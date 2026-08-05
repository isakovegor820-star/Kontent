import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));

vi.mock("./db", () => ({ getPool: () => ({ query: mocks.query }) }));

import { destroySession } from "./session";

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
