import { NextRequest, NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  checkRateLimit: vi.fn(),
  rateLimitResponse: vi.fn(),
  verifyProjectTrackingSite: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn(), connect: vi.fn() }) }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  rateLimitResponse: mocks.rateLimitResponse,
}));
vi.mock("@/lib/tracking-service", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/tracking-service")>(),
  verifyProjectTrackingSite: mocks.verifyProjectTrackingSite,
}));

import { POST } from "./route";

function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/tracking/settings/verify", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", ...headers },
    body: (typeof body === "string" || body instanceof Uint8Array ? body : JSON.stringify(body)) as BodyInit,
  });
}

describe("POST /api/tracking/settings/verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 15, remaining: 14, retryAfter: 0 });
    mocks.rateLimitResponse.mockReturnValue(NextResponse.json({ error: "rate_limited" }, { status: 429 }));
    mocks.verifyProjectTrackingSite.mockResolvedValue({
      verified: true,
      tracking: { status: "active", version: 3 },
    });
  });

  it("uses origin, auth and fail-closed rate limit before the bounded body and verification", async () => {
    const response = await POST(request({ expectedVersion: 2 }));
    expect(response.status).toBe(200);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      "tracking:verify:user:7", 15, 3_600, { failureMode: "closed" },
    );
    expect(mocks.verifyProjectTrackingSite).toHaveBeenCalledWith(expect.objectContaining({
      actorUserId: 7,
      expectedVersion: 2,
    }));
  });

  it("rejects unknown fields, unsupported media and a lying oversized stream", async () => {
    expect((await POST(request({ expectedVersion: 2, projectId: 99 }))).status).toBe(400);
    expect((await POST(request("{}", { "content-type": "text/plain" }))).status).toBe(415);
    expect((await POST(request(JSON.stringify({
      expectedVersion: 2,
      padding: "x".repeat(17_000),
    }), { "content-length": "2" }))).status).toBe(413);
    expect(mocks.verifyProjectTrackingSite).not.toHaveBeenCalled();
  });

  it("does not read the body when the limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({ allowed: false, unavailable: true, retryAfter: 30 });
    mocks.rateLimitResponse.mockReturnValue(NextResponse.json({ error: "rate_limit_unavailable" }, { status: 503 }));
    const stream = new ReadableStream<Uint8Array>({
      pull() { throw new Error("body must not be read"); },
    });
    const response = await POST(new NextRequest("http://localhost/api/tracking/settings/verify", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as never));
    expect(response.status).toBe(503);
    expect(mocks.verifyProjectTrackingSite).not.toHaveBeenCalled();
  });
});
