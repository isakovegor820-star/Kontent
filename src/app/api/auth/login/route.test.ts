import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  verifyPassword: vi.fn(),
  createSession: vi.fn(),
  checkRateLimit: vi.fn(),
  clientIp: vi.fn(),
  rateLimitResponse: vi.fn(),
}));

vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/password", () => ({ verifyPassword: mocks.verifyPassword }));
vi.mock("@/lib/session", () => ({ createSession: mocks.createSession }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.checkRateLimit,
  clientIp: mocks.clientIp,
  rateLimitResponse: mocks.rateLimitResponse,
}));

import { POST } from "./route";

const previousDatabaseUrl = process.env.DATABASE_URL;

function request() {
  return new NextRequest("http://localhost/api/auth/login", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ email: "missing@example.test", password: "correct-horse-42" }),
  });
}

describe("POST /api/auth/login", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DATABASE_URL = "postgresql://test.invalid/aurora";
    mocks.query.mockResolvedValue({ rows: [], rowCount: 0 });
    mocks.verifyPassword.mockResolvedValue(false);
    mocks.checkRateLimit.mockResolvedValue({ allowed: true, limit: 10, remaining: 9, retryAfter: 0 });
    mocks.clientIp.mockReturnValue("127.0.0.1");
  });

  afterEach(() => {
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("runs password verification for an unknown email before returning the generic error", async () => {
    const response = await POST(request());

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: "invalid" });
    expect(mocks.verifyPassword).toHaveBeenCalledWith("correct-horse-42", null);
    expect(mocks.createSession).not.toHaveBeenCalled();
  });
});
