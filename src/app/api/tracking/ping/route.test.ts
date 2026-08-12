import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyOrigin: vi.fn(),
  markPing: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  clientIp: () => "203.0.113.20",
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/tracking-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tracking-service")>(),
  verifyTrackerCorsOrigin: mocks.verifyOrigin,
  markTrackerPing: mocks.markPing,
}));

import { POST } from "./route";

describe("tracking ping boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 30, remaining: 29, retryAfter: 0 });
    mocks.verifyOrigin.mockResolvedValue("https://law.example.ru");
    mocks.markPing.mockResolvedValue({ status: "pending_verification" });
  });

  it("applies IP and project/IP limits before recording an exact ping", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tracking/ping", {
      method: "POST",
      headers: { origin: "https://law.example.ru", "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "tracker_public_key_1234567890" }),
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://law.example.ru");
    await expect(response.clone().json()).resolves.toMatchObject({
      status: "signal_received",
      verificationStatus: "pending_verification",
    });
    expect(mocks.checkRateLimit.mock.calls.map(([key]) => key)).toEqual([
      expect.stringMatching(/^tracking:ping:ip:[0-9a-f]{32}$/u),
      expect.stringMatching(/^tracking:ping:project-ip:[0-9a-f]{32}$/u),
    ]);
    expect(mocks.markPing).toHaveBeenCalledWith({}, {
      publicKey: "tracker_public_key_1234567890",
      requestOrigin: "https://law.example.ru",
    });
  });

  it("never promotes a public ping to active and rejects non-JSON media", async () => {
    const unsupported = await POST(new NextRequest("http://localhost/api/tracking/ping", {
      method: "POST",
      headers: { origin: "https://law.example.ru", "content-type": "text/plain" },
      body: JSON.stringify({ publicKey: "tracker_public_key_1234567890" }),
    }));
    expect(unsupported.status).toBe(415);
    expect(mocks.markPing).not.toHaveBeenCalled();
  });

  it("rejects an oversized streamed body without trusting Content-Length", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tracking/ping", {
      method: "POST",
      headers: {
        origin: "https://law.example.ru",
        "content-type": "application/json",
        "content-length": "10",
        "transfer-encoding": "chunked",
      },
      body: JSON.stringify({
        publicKey: "tracker_public_key_1234567890",
        padding: "x".repeat(17_000),
      }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
    expect(mocks.verifyOrigin).not.toHaveBeenCalled();
    expect(mocks.markPing).not.toHaveBeenCalled();
  });

  it("fails closed before parsing when the public ingress limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfter: 30,
      unavailable: true,
    });
    const response = await POST(new NextRequest("http://localhost/api/tracking/ping", {
      method: "POST",
      headers: { origin: "https://law.example.ru", "content-type": "application/json" },
      body: JSON.stringify({ publicKey: "tracker_public_key_1234567890" }),
    }));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: "rate_limit_unavailable" });
    expect(mocks.verifyOrigin).not.toHaveBeenCalled();
    expect(mocks.markPing).not.toHaveBeenCalled();
  });
});
