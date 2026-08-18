import { createHash, createHmac } from "node:crypto";

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

const BOT_TOKEN = "telegram-test-token";

function signedBody(authDate: number) {
  const data: Record<string, string | number> = {
    id: 42,
    first_name: "Анна",
    auth_date: authDate,
  };
  const checkString = Object.keys(data).sort().map((key) => `${key}=${data[key]}`).join("\n");
  const secret = createHash("sha256").update(BOT_TOKEN).digest();
  return {
    ...data,
    hash: createHmac("sha256", secret).update(checkString).digest("hex"),
  };
}

function request(body: Record<string, unknown>, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/auth/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

describe("POST /api/auth/telegram", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TG_BOT_TOKEN", BOT_TOKEN);
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.findOrCreateUser.mockResolvedValue({ id: 7 });
    mocks.createSession.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("requires same-origin browser authentication before rate limiting", async () => {
    const response = await POST(request(signedBody(Math.floor(Date.now() / 1_000)), "https://evil.example"));
    expect(response.status).toBe(403);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
  });

  it("accepts a fresh signed payload and applies fail-closed IP/account limits", async () => {
    const response = await POST(request(signedBody(Math.floor(Date.now() / 1_000))));
    expect(response.status).toBe(200);
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(
      1,
      "social-login:telegram:ip:127.0.0.1",
      10,
      900,
      { failureMode: "closed" },
    );
    expect(mocks.rateLimit).toHaveBeenNthCalledWith(
      2,
      "social-login:telegram:account:42",
      5,
      900,
      { failureMode: "closed" },
    );
  });

  it("rejects a replay older than five minutes even with a valid signature", async () => {
    const stale = signedBody(Math.floor(Date.now() / 1_000) - 301);
    const response = await POST(request(stale));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "stale" });
    expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
  });

  it("rejects a forged signature without entering account lookup", async () => {
    const forged = { ...signedBody(Math.floor(Date.now() / 1_000)), hash: "0".repeat(64) };
    const response = await POST(request(forged));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "bad_signature" });
    expect(mocks.findOrCreateUser).not.toHaveBeenCalled();
  });
});
