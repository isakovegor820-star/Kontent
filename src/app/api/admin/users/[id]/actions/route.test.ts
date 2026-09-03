import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasAuroraAdminAccess: vi.fn(),
  setAdminAccountBlock: vi.fn(),
  revokeAdminAccountSessions: vi.fn(),
  sendAdminPasswordReset: vi.fn(),
  setAdminAccountAiLimit: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/admin-access", () => ({ hasAuroraAdminAccess: mocks.hasAuroraAdminAccess }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: vi.fn(), connect: vi.fn() }) }));
vi.mock("@/lib/admin-account-actions", () => ({
  setAdminAccountBlock: mocks.setAdminAccountBlock,
  revokeAdminAccountSessions: mocks.revokeAdminAccountSessions,
  sendAdminPasswordReset: mocks.sendAdminPasswordReset,
  setAdminAccountAiLimit: mocks.setAdminAccountAiLimit,
}));

import { POST } from "./route";

const context = (id: string) => ({ params: Promise.resolve({ id }) });
function request(body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/admin/users/42/actions", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /api/admin/users/:id/actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 3, email: "admin@example.com" });
    mocks.hasAuroraAdminAccess.mockReturnValue(true);
  });

  it("gates on origin, session and the global allowlist", async () => {
    expect((await POST(request({ action: "block" }, { origin: "https://attacker.example", "sec-fetch-site": "cross-site" }), context("42"))).status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    mocks.hasAuroraAdminAccess.mockReturnValue(false);
    expect((await POST(request({ action: "block" }), context("42"))).status).toBe(403);
    expect(mocks.setAdminAccountBlock).not.toHaveBeenCalled();
  });

  it("dispatches actions with a bounded reason and the allowlist as the protection oracle", async () => {
    mocks.setAdminAccountBlock.mockResolvedValue({ status: "ok", action: "account.blocked", targetUserId: 42 });
    const response = await POST(request({ action: "block", reason: "  Спам  " }), context("42"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const call = mocks.setAdminAccountBlock.mock.calls[0][1];
    expect(call).toMatchObject({ actorUserId: 3, targetUserId: 42, blocked: true, reason: "Спам" });
    mocks.hasAuroraAdminAccess.mockReturnValueOnce(true);
    expect(call.isProtected({ id: 5, email: "x@example.com" })).toBe(true);
    expect(mocks.hasAuroraAdminAccess).toHaveBeenLastCalledWith({ id: 5, email: "x@example.com" });
  });

  it("maps domain outcomes to HTTP statuses and validates input", async () => {
    mocks.setAdminAccountBlock.mockResolvedValueOnce({ status: "protected" });
    expect((await POST(request({ action: "block" }), context("42"))).status).toBe(409);
    mocks.sendAdminPasswordReset.mockResolvedValueOnce({ status: "no_email" });
    expect((await POST(request({ action: "send_password_reset" }), context("42"))).status).toBe(422);
    mocks.revokeAdminAccountSessions.mockResolvedValueOnce({ status: "not_found" });
    expect((await POST(request({ action: "revoke_sessions" }), context("42"))).status).toBe(404);
    expect((await POST(request({ action: "set_ai_limit", limit: "abc" }), context("42"))).status).toBe(422);
    mocks.setAdminAccountAiLimit.mockResolvedValueOnce({ status: "ok", action: "account.ai_limit_changed", targetUserId: 42 });
    expect((await POST(request({ action: "set_ai_limit", limit: null }), context("42"))).status).toBe(200);
    expect(mocks.setAdminAccountAiLimit).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ limit: null }));
    expect((await POST(request({ action: "delete" }), context("42"))).status).toBe(400);
    expect((await POST(request({ action: "block" }), context("abc"))).status).toBe(400);
  });
});
