import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ consume: vi.fn(), limit: vi.fn() }));
vi.mock("@/lib/email-change", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/email-change")>();
  return { ...actual, consumeEmailChange: mocks.consume };
});
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: vi.fn() }) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mocks.limit,
  clientIp: () => "127.0.0.1",
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

import { POST } from "./route";

function request(token = "x".repeat(32)) {
  return new NextRequest("http://localhost/api/settings/profile/email/confirm", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

describe("email change confirmation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.limit.mockResolvedValue({ allowed: true });
  });

  it("confirms once and treats an exact replay as already confirmed", async () => {
    mocks.consume.mockResolvedValueOnce("ok").mockResolvedValueOnce("already_confirmed");
    const first = await POST(request());
    const replay = await POST(request());
    await expect(first.json()).resolves.toMatchObject({ ok: true, status: "confirmed" });
    await expect(replay.json()).resolves.toMatchObject({ ok: true, status: "already_confirmed" });
  });

  it("returns a conflict when another account claimed the target email", async () => {
    mocks.consume.mockResolvedValue("email_taken");
    const response = await POST(request());
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "email_taken", requestId: expect.any(String) });
  });
});
