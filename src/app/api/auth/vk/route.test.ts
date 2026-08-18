import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findOrCreateUser: vi.fn(),
  createSession: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/users", () => ({ findOrCreateUser: mocks.findOrCreateUser }));
vi.mock("@/lib/session", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "127.0.0.1",
  rateLimitResponse: () => Response.json({ error: "rate_limited" }, { status: 429 }),
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/auth/vk", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({
      code: "one-time-code",
      device_id: "device-id",
      code_verifier: "v".repeat(43),
    }),
  });
}

describe("POST /api/auth/vk logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VK_APP_ID", "app-id");
    vi.stubEnv("VK_APP_SECRET", "app-secret");
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.createSession.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("never logs the provider response body or access token on exchange failure", async () => {
    const secret = "provider-access-token-must-not-be-logged";
    const fetchMock = vi.fn(async () => Response.json(
      { access_token: secret, error: "malformed_response" },
      { status: 400 },
    ));
    vi.stubGlobal("fetch", fetchMock);
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(log).toHaveBeenCalledWith(
      "[/api/auth/vk] token exchange failed",
      { status: 400, code: "vk_exchange_failed" },
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain("malformed_response");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://id.vk.com/oauth2/auth",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("bounds provider latency and returns a stable gateway timeout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(504);
    await expect(response.json()).resolves.toMatchObject({ error: "vk_exchange_timeout" });
    expect(log).toHaveBeenCalledWith(
      "[/api/auth/vk] request timed out",
      { code: "vk_exchange_timeout" },
    );
  });
});
