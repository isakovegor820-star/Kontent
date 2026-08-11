import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import { destroySession, getSessionUser } from "./session";

describe("destroySession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the browser credential even when PostgreSQL cannot revoke the row", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    const request = new NextRequest("http://localhost/api/auth/logout", {
      headers: { cookie: "sid=opaque-session-token" },
    });
    const response = NextResponse.json({ ok: true });

    await expect(destroySession(request, response)).rejects.toThrow("database unavailable");

    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sid=");
    expect(cookie.toLowerCase()).toContain("max-age=0");
  });
});

describe("getSessionUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.query.mockResolvedValue({
      rowCount: 1,
      rows: [{
        id: "17",
        tg_id: "42",
        vk_id: null,
        email: "user@example.com",
        name: "User",
        avatar: null,
        onboarding_completed_at: null,
        expires_at: new Date(Date.now() + 29 * 24 * 60 * 60 * 1000).toISOString(),
      }],
    });
  });

  it("нормализует bigint идентификаторы PostgreSQL в числа", async () => {
    const request = new NextRequest("http://localhost/api/auth/me", {
      headers: { cookie: "sid=test-session" },
    });

    await expect(getSessionUser(request)).resolves.toMatchObject({
      id: 17,
      tg_id: 42,
      vk_id: null,
    });
  });
});
