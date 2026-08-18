import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  checkRateLimit: vi.fn(),
  createPasswordResetOutboxRequest: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: () => "203.0.113.8",
  rateLimitResponse: (result: { unavailable?: boolean }) =>
    new Response(null, { status: result.unavailable ? 503 : 429 }),
}));
vi.mock("@/lib/password-reset", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/password-reset")>();
  return {
    ...actual,
    configuredAppUrl: () => "https://aurora.example",
    createPasswordResetOutboxRequest: mocks.createPasswordResetOutboxRequest,
  };
});

import { POST } from "./route";

function request(email: string) {
  return new NextRequest("http://localhost/api/auth/password/forgot", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email }),
  });
}

describe("POST /api/auth/password/forgot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("DATABASE_URL", "postgresql://fixture.invalid/aurora");
    vi.stubEnv("RESEND_API_KEY", "test-key");
    vi.stubEnv("PASSWORD_RESET_FROM", "security@example.test");
    vi.stubEnv("TOKENS_MASTER_KEY", "test-envelope-key");
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.createPasswordResetOutboxRequest.mockResolvedValue(null);
  });

  it("returns an indistinguishable response for known and unknown accounts", async () => {
    mocks.createPasswordResetOutboxRequest.mockResolvedValueOnce(null);
    const unknown = await POST(request("unknown@example.com"));

    mocks.createPasswordResetOutboxRequest.mockResolvedValueOnce({ outboxId: 31, generation: 2 });
    const known = await POST(request("known@example.com"));

    expect(unknown.status).toBe(202);
    expect(known.status).toBe(202);
    expect(await known.text()).toBe(await unknown.text());
    expect(mocks.createPasswordResetOutboxRequest).toHaveBeenCalledTimes(2);
  });

  it("never returns a reset token for malformed input", async () => {
    const response = await POST(request("not-an-email"));
    const body = await response.text();

    expect(response.status).toBe(202);
    expect(body).not.toContain("token");
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("uses fail-closed limiting and stops before database/email when it is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValueOnce({
      allowed: false,
      limit: 5,
      remaining: 0,
      retryAfter: 30,
      unavailable: true,
    });

    const response = await POST(request("known@example.com"));

    expect(response.status).toBe(503);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith(
      expect.stringContaining("password-reset:ip:"),
      5,
      3600,
      { failureMode: "closed" },
    );
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.createPasswordResetOutboxRequest).not.toHaveBeenCalled();
  });

  it("rejects a cross-site browser mutation before rate limiting or database access", async () => {
    const response = await POST(new NextRequest("http://localhost/api/auth/password/forgot", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ email: "known@example.com" }),
    }));

    expect(response.status).toBe(403);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
