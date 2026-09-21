import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  getSessionUser: vi.fn(),
  sessionTokenHashFromRequest: vi.fn(),
}));

vi.mock("@/lib/session", () => mocks);

import { GET } from "./route";

describe("GET /api/auth/me", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue(null);
    mocks.sessionTokenHashFromRequest.mockReturnValue(null);
  });

  it("keeps the anonymous bootstrap contract when no credential is presented", async () => {
    const response = await GET(new NextRequest("http://localhost/api/auth/me"));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: null });
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
  });

  it("fails closed and clears an invalid or expired presented credential", async () => {
    mocks.sessionTokenHashFromRequest.mockReturnValue("a".repeat(64));

    const response = await GET(new NextRequest("http://localhost/api/auth/me", {
      headers: { cookie: "sid=expired-session" },
    }));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ user: null, error: "unauthorized" });
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.clearSessionCookie).toHaveBeenCalledWith(response);
  });

  it("preserves the authenticated response", async () => {
    const user = { id: 17, email: "owner@example.test" };
    mocks.sessionTokenHashFromRequest.mockReturnValue("b".repeat(64));
    mocks.getSessionUser.mockResolvedValue(user);

    const response = await GET(new NextRequest("http://localhost/api/auth/me", {
      headers: { cookie: "sid=active-session" },
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ user: { ...user, is_admin: false } });
    expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
  });

  it("flags allowlisted administrators so the cabinet can show the operations link", async () => {
    const user = { id: 17, email: "ops@example.test" };
    mocks.sessionTokenHashFromRequest.mockReturnValue("b".repeat(64));
    mocks.getSessionUser.mockResolvedValue(user);
    const previous = process.env.AURORA_ADMIN_EMAILS;
    process.env.AURORA_ADMIN_EMAILS = "ops@example.test";
    try {
      const response = await GET(new NextRequest("http://localhost/api/auth/me", { headers: { cookie: "sid=active-session" } }));
      await expect(response.json()).resolves.toEqual({ user: { ...user, is_admin: true } });
    } finally {
      if (previous === undefined) delete process.env.AURORA_ADMIN_EMAILS;
      else process.env.AURORA_ADMIN_EMAILS = previous;
    }
  });

  it("does not turn a session-store failure into a logout", async () => {
    mocks.sessionTokenHashFromRequest.mockReturnValue("c".repeat(64));
    mocks.getSessionUser.mockRejectedValue(new Error("database unavailable"));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      const response = await GET(new NextRequest("http://localhost/api/auth/me", {
        headers: { cookie: "sid=unknown-session" },
      }));

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ user: null, error: "unavailable" });
      expect(mocks.clearSessionCookie).not.toHaveBeenCalled();
    } finally {
      error.mockRestore();
    }
  });
});
