import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  cookies: vi.fn(),
}));

vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("next/headers", () => ({ cookies: mocks.cookies }));

import { createSession, destroySession, getSessionUser, hashSessionToken } from "./session";

describe("destroySession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("clears the browser credential even when PostgreSQL cannot revoke the row", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));
    const request = new NextRequest("http://localhost/api/auth/logout", {
      headers: { cookie: "sid=opaque-session-token" },
    });
    const response = NextResponse.json({ ok: true });

    await expect(destroySession(request, response)).rejects.toThrow("database unavailable");

    expect(mocks.query).toHaveBeenCalledWith(
      "delete from sessions where token_hash = $1",
      [hashSessionToken("opaque-session-token")],
    );

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
    expect(mocks.query.mock.calls[0]?.[1]).toEqual([hashSessionToken("test-session")]);
  });
});

describe("session token storage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("stores only token_hash while returning the raw bearer in the cookie", async () => {
    mocks.query.mockResolvedValueOnce({ rowCount: 1, rows: [{ token_hash: "stored" }] });
    const response = NextResponse.json({ ok: true });

    await expect(createSession(response, 17, "test-device")).resolves.toBe(true);

    const [sql, params] = mocks.query.mock.calls[0];
    expect(String(sql)).toContain("insert into sessions (token_hash,");
    const rawCookie = response.headers.get("set-cookie")?.match(/sid=([^;]+)/u)?.[1];
    expect(rawCookie).toBeTruthy();
    expect(params[0]).toBe(hashSessionToken(String(rawCookie)));
    expect(params[0]).not.toBe(rawCookie);
  });

  it("uses a one-way verifier instead of the browser bearer", () => {
    const raw = "live-browser-cookie";
    expect(hashSessionToken(raw)).toMatch(/^[a-f0-9]{64}$/u);
    expect(hashSessionToken(raw)).not.toContain(raw);
  });
});
