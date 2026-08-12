import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  verifyOrigin: vi.fn(),
  recordConversion: vi.fn(),
  checkRateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({}) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/rate-limit")>(),
  clientIp: () => "203.0.113.10",
  checkRateLimit: mocks.checkRateLimit,
}));
vi.mock("@/lib/tracking-secrets", () => ({
  getTrackingSecrets: () => ({ attributionSecret: "a".repeat(40), fingerprintSecret: "b".repeat(40) }),
}));
vi.mock("@/lib/tracking-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tracking-service")>();
  return {
    ...actual,
    verifyTrackerCorsOrigin: mocks.verifyOrigin,
    recordConversionEvent: mocks.recordConversion,
  };
});

import { OPTIONS, POST } from "./route";

describe("tracking conversion CORS", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 60, remaining: 59, retryAfter: 0 });
    mocks.verifyOrigin.mockResolvedValue("https://law.example.ru");
    mocks.recordConversion.mockResolvedValue({
      id: "conversion-1",
      eventType: "form_submit",
      occurredAt: "2026-08-11T12:00:00.000Z",
      duplicate: false,
    });
  });

  it("allows preflight only after exact project-origin verification", async () => {
    const response = await OPTIONS(new NextRequest("http://localhost/api/tracking/conversions", {
      method: "OPTIONS",
      headers: { origin: "https://law.example.ru", "x-aurora-project-key": "tracker_public_key_1234567890" },
    }));
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://law.example.ru");
    expect(response.headers.get("vary")).toBe("Origin");
  });

  it("records a conversion without session cookies and returns scoped CORS", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tracking/conversions", {
      method: "POST",
      headers: {
        origin: "https://law.example.ru",
        "content-type": "application/json",
        "idempotency-key": "conversion:form:001",
      },
      body: JSON.stringify({
        publicKey: "tracker_public_key_1234567890",
        token: "signed-attribution",
        eventType: "form_submit",
      }),
    }));
    expect(response.status).toBe(201);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://law.example.ru");
    expect(mocks.recordConversion).toHaveBeenCalledWith(expect.objectContaining({
      publicKey: "tracker_public_key_1234567890",
      idempotencyKey: "conversion:form:001",
      requestOrigin: "https://law.example.ru",
    }));
    expect(mocks.checkRateLimit).toHaveBeenCalledTimes(2);
    expect(mocks.checkRateLimit.mock.calls[0]?.[0]).toMatch(/^tracking:conversion:ip:[0-9a-f]{32}$/u);
    expect(mocks.checkRateLimit.mock.calls[1]?.[0]).toMatch(/^tracking:conversion:project-ip:[0-9a-f]{32}$/u);
  });

  it("rejects an oversized chunked body by bytes even when Content-Length lies", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tracking/conversions", {
      method: "POST",
      headers: {
        origin: "https://law.example.ru",
        "content-type": "application/json",
        "content-length": "1",
        "transfer-encoding": "chunked",
      },
      body: JSON.stringify({
        publicKey: "tracker_public_key_1234567890",
        token: "signed-attribution",
        eventType: "form_submit",
        padding: "x".repeat(17_000),
      }),
    }));

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "payload_too_large" });
    expect(mocks.verifyOrigin).not.toHaveBeenCalled();
    expect(mocks.recordConversion).not.toHaveBeenCalled();
  });

  it("rejects unknown top-level fields", async () => {
    const response = await POST(new NextRequest("http://localhost/api/tracking/conversions", {
      method: "POST",
      headers: { origin: "https://law.example.ru", "content-type": "application/json" },
      body: JSON.stringify({
        publicKey: "tracker_public_key_1234567890",
        token: "signed-attribution",
        eventType: "form_submit",
        projectId: 999,
      }),
    }));

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "bad_request" });
    expect(mocks.verifyOrigin).not.toHaveBeenCalled();
  });

  it("keeps both limiter buckets stable when an attacker rotates attribution tokens", async () => {
    for (const token of ["attacker-token-one", "attacker-token-two"]) {
      const response = await POST(new NextRequest("http://localhost/api/tracking/conversions", {
        method: "POST",
        headers: { origin: "https://law.example.ru", "content-type": "application/json" },
        body: JSON.stringify({
          publicKey: "tracker_public_key_1234567890",
          token,
          idempotencyKey: `event:${token}`,
          eventType: "form_submit",
        }),
      }));
      expect(response.status).toBe(201);
    }

    const keys = mocks.checkRateLimit.mock.calls.map(([key]) => String(key));
    expect(keys).toHaveLength(4);
    expect(keys[0]).toBe(keys[2]);
    expect(keys[1]).toBe(keys[3]);
    expect(keys.join(" ")).not.toContain("attacker-token");
  });
});
