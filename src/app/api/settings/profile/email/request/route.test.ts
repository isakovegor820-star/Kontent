import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  query: vi.fn(),
  verifyPassword: vi.fn(),
  checkRateLimit: vi.fn(),
  createRequest: vi.fn(),
  deliveryConfigured: vi.fn(),
  configuredAppUrl: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query, connect: vi.fn() }) }));
vi.mock("@/lib/password", () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: () => "127.0.0.1",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));
vi.mock("@/lib/email-change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email-change")>();
  return { ...actual, createEmailChangeOutboxRequest: mocks.createRequest };
});
vi.mock("@/lib/email-change-delivery.mjs", () => ({ emailChangeDeliveryConfigured: mocks.deliveryConfigured }));
vi.mock("@/lib/password-reset", () => ({ configuredAppUrl: mocks.configuredAppUrl }));

import { POST } from "./route";

function request(body: Record<string, unknown>, origin = "http://localhost") {
  return new NextRequest("http://localhost/api/settings/profile/email/request", {
    method: "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": String(body.requestKey),
    },
    body: JSON.stringify(body),
  });
}

describe("email change request route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TOKENS_MASTER_KEY = "test-key";
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.checkRateLimit.mockResolvedValue({ allowed: true });
    mocks.verifyPassword.mockResolvedValue(true);
    mocks.deliveryConfigured.mockReturnValue(true);
    mocks.configuredAppUrl.mockReturnValue("https://aurora.example");
    mocks.createRequest.mockResolvedValue({
      status: "created",
      requestId: 41,
      targetEmail: "new@example.test",
      expiresAt: new Date("2026-08-05T14:00:00Z"),
    });
  });

  it("requires password reauthentication and creates a durable confirmation request", async () => {
    mocks.query.mockResolvedValue({ rows: [{
      email: "old@example.test",
      password_hash: "stored-hash",
      tg_id: null,
      vk_id: null,
      target_taken: false,
    }] });
    const response = await POST(request({
      email: "new@example.test",
      password: "current password",
      requestKey: "email-change:one",
    }));
    expect(response.status).toBe(202);
    expect(mocks.verifyPassword).toHaveBeenCalledWith("current password", "stored-hash");
    expect(mocks.createRequest).toHaveBeenCalledWith(expect.objectContaining({
      userId: 7,
      targetEmail: "new@example.test",
      requestKey: "email-change:one",
    }), expect.anything());
  });

  it("fails explicitly for social-only accounts without a fresh provider proof", async () => {
    mocks.query.mockResolvedValue({ rows: [{
      email: "old@example.test",
      password_hash: null,
      tg_id: "12",
      vk_id: null,
      target_taken: false,
    }] });
    const response = await POST(request({
      email: "new@example.test",
      requestKey: "email-change:social",
    }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "reauth_required", reauthProvider: "telegram" });
    expect(mocks.createRequest).not.toHaveBeenCalled();
  });

  it("rejects the same idempotency key with a different body key and cross-origin requests", async () => {
    const mismatch = request({ email: "new@example.test", password: "x", requestKey: "body:key:one" });
    mismatch.headers.set("idempotency-key", "header:key:two");
    expect((await POST(mismatch)).status).toBe(422);
    expect((await POST(request({ email: "new@example.test", requestKey: "email-change:evil" }, "https://evil.example"))).status).toBe(403);
    expect(mocks.query).not.toHaveBeenCalled();
  });
});
