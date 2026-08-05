import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  findOrCreateUser: vi.fn(),
  createSession: vi.fn(),
}));

vi.mock("@/lib/users", () => ({ findOrCreateUser: mocks.findOrCreateUser }));
vi.mock("@/lib/session", () => ({ createSession: mocks.createSession }));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/auth/vk", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "one-time-code" }),
  });
}

describe("POST /api/auth/vk logging", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("VK_APP_ID", "app-id");
    vi.stubEnv("VK_APP_SECRET", "app-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("never logs the provider response body or access token on exchange failure", async () => {
    const secret = "provider-access-token-must-not-be-logged";
    vi.stubGlobal("fetch", vi.fn(async () => Response.json(
      { access_token: secret, error: "malformed_response" },
      { status: 400 },
    )));
    const log = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request());

    expect(response.status).toBe(401);
    expect(log).toHaveBeenCalledWith(
      "[/api/auth/vk] token exchange failed",
      { status: 400, code: "vk_exchange_failed" },
    );
    expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(log.mock.calls)).not.toContain("malformed_response");
  });
});
