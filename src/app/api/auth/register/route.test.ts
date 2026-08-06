import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  convertLead: vi.fn(),
  createSession: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: vi.fn() }) }));
vi.mock("@/lib/password-registration", () => ({ registerPasswordUser: mocks.register }));
vi.mock("@/lib/users", () => ({ convertMatchingLeadAfterRegistration: mocks.convertLead }));
vi.mock("@/lib/session", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/password", () => ({
  hashPassword: vi.fn(async () => "salt:hash"),
  validatePassword: vi.fn(() => undefined),
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.rateLimit,
  clientIp: () => "127.0.0.1",
  rateLimitResponse: () => Response.json({ error: "rate_limited" }, { status: 429 }),
}));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ email: "new@example.test", password: "strong-pass", name: "New" }),
  });
}

describe("registration route", () => {
  beforeEach(() => {
    process.env.DATABASE_URL = "postgresql://local/test";
    mocks.rateLimit.mockResolvedValue({ allowed: true });
    mocks.register.mockResolvedValue({ ok: true, userId: 19 });
    mocks.convertLead.mockResolvedValue({ converted: false, notified: false });
    mocks.createSession.mockResolvedValue(true);
  });
  afterEach(() => vi.clearAllMocks());

  it("returns stable email_taken without lead or session side effects", async () => {
    mocks.register.mockResolvedValue({ ok: false, error: "email_taken" });
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "email_taken" });
    expect(mocks.convertLead).not.toHaveBeenCalled();
    expect(mocks.createSession).not.toHaveBeenCalled();
  });

  it("keeps committed account explicit when session creation fails", async () => {
    mocks.createSession.mockResolvedValue(false);
    const response = await POST(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: "session_creation_failed",
      accountCreated: true,
    });
    expect(mocks.convertLead).toHaveBeenCalledWith(["new@example.test"], "New");
  });
});
