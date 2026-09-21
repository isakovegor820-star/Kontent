import { describe, expect, it, vi } from "vitest";

import {
  revokeAdminAccountSessions,
  sendAdminPasswordReset,
  setAdminAccountAiLimit,
  setAdminAccountBlock,
} from "./admin-account-actions";

const passwordReset = vi.hoisted(() => ({ createPasswordResetOutboxRequest: vi.fn() }));
vi.mock("./password-reset", () => passwordReset);

type Target = { id: number; email: string | null; blocked_at: string | null; ai_daily_limit: number | null } | null;

function fakePool(target: Target) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sqlValue: string, params: unknown[] = []) => {
    const sql = sqlValue.replace(/\s+/gu, " ").trim();
    statements.push({ sql, params });
    if (sql.startsWith("select id, email, blocked_at, ai_daily_limit from users") || sql.startsWith("select email, blocked_at from users")) {
      return { rowCount: target ? 1 : 0, rows: target ? [target] : [] };
    }
    if (sql.startsWith("update sessions set expires_at = now()")) return { rowCount: 2, rows: [] };
    return { rowCount: 1, rows: [] };
  });
  const pool = { query, connect: vi.fn(async () => ({ query, release: vi.fn() })) } as never as Parameters<typeof setAdminAccountBlock>[0];
  return { pool, statements };
}

const base = { actorUserId: 3, targetUserId: 42, requestId: "req-1" };

describe("admin account actions", () => {
  it("blocks an account by rotating the credential epoch and expiring sessions in one transaction", async () => {
    const { pool, statements } = fakePool({ id: 42, email: "u@example.com", blocked_at: null, ai_daily_limit: null });
    await expect(setAdminAccountBlock(pool, { ...base, blocked: true, reason: "Спам" })).resolves.toEqual({ status: "ok", action: "account.blocked", targetUserId: 42 });
    const sqls = statements.map((entry) => entry.sql);
    expect(sqls[0]).toBe("begin");
    expect(sqls.some((sql) => sql.includes("blocked_at = now(), blocked_reason = $2, credential_epoch = credential_epoch + 1"))).toBe(true);
    expect(sqls.some((sql) => sql.startsWith("update sessions set expires_at = now()"))).toBe(true);
    const journal = statements.find((entry) => entry.sql.startsWith("insert into admin_account_actions"));
    expect(journal?.params).toEqual([3, 42, "account.blocked", "Спам", "{}", "req-1"]);
    expect(sqls.at(-1)).toBe("commit");
  });

  it("refuses self-block, protected admins and no-op transitions", async () => {
    const self = fakePool({ id: 3, email: null, blocked_at: null, ai_daily_limit: null });
    await expect(setAdminAccountBlock(self.pool, { ...base, targetUserId: 3, blocked: true })).resolves.toEqual({ status: "self" });
    const admin = fakePool({ id: 42, email: "admin@example.com", blocked_at: null, ai_daily_limit: null });
    await expect(setAdminAccountBlock(admin.pool, { ...base, blocked: true, isProtected: (user) => user.email === "admin@example.com" })).resolves.toEqual({ status: "protected" });
    expect(admin.statements.some((entry) => entry.sql.startsWith("update users"))).toBe(false);
    const blocked = fakePool({ id: 42, email: null, blocked_at: "2026-09-01T00:00:00.000Z", ai_daily_limit: null });
    await expect(setAdminAccountBlock(blocked.pool, { ...base, blocked: true })).resolves.toEqual({ status: "already" });
    await expect(setAdminAccountBlock(blocked.pool, { ...base, blocked: false })).resolves.toMatchObject({ status: "ok", action: "account.unblocked" });
    const missing = fakePool(null);
    await expect(setAdminAccountBlock(missing.pool, { ...base, blocked: true })).resolves.toEqual({ status: "not_found" });
  });

  it("revokes sessions and records how many were live", async () => {
    const { pool, statements } = fakePool({ id: 42, email: null, blocked_at: null, ai_daily_limit: null });
    await expect(revokeAdminAccountSessions(pool, base)).resolves.toMatchObject({ status: "ok", action: "account.sessions_revoked" });
    expect(statements.some((entry) => entry.sql.includes("credential_epoch = credential_epoch + 1"))).toBe(true);
    const journal = statements.find((entry) => entry.sql.startsWith("insert into admin_account_actions"));
    expect(JSON.parse(String(journal?.params[4]))).toEqual({ sessions: 2, self: false });
  });

  it("sends the password reset through the existing outbox and never returns the token", async () => {
    passwordReset.createPasswordResetOutboxRequest.mockResolvedValue({ outboxId: 9, generation: 4 });
    const { pool, statements } = fakePool({ id: 42, email: "u@example.com", blocked_at: null, ai_daily_limit: null });
    const result = await sendAdminPasswordReset(pool, base);
    expect(result).toMatchObject({ status: "ok", action: "account.password_reset_sent" });
    expect(passwordReset.createPasswordResetOutboxRequest).toHaveBeenCalledWith({ email: "u@example.com", requestIpHash: "admin:3" }, pool);
    expect(JSON.stringify(result)).not.toMatch(/token/iu);
    expect(statements.some((entry) => entry.sql.startsWith("insert into admin_account_actions"))).toBe(true);
    const noEmail = fakePool({ id: 42, email: null, blocked_at: null, ai_daily_limit: null });
    await expect(sendAdminPasswordReset(noEmail.pool, base)).resolves.toEqual({ status: "no_email" });
  });

  it("bounds the AI limit and journals the previous value", async () => {
    const { pool, statements } = fakePool({ id: 42, email: null, blocked_at: null, ai_daily_limit: 30 });
    await expect(setAdminAccountAiLimit(pool, { ...base, limit: 0 })).resolves.toEqual({ status: "invalid_limit" });
    await expect(setAdminAccountAiLimit(pool, { ...base, limit: 100_001 })).resolves.toEqual({ status: "invalid_limit" });
    await expect(setAdminAccountAiLimit(pool, { ...base, limit: 2.5 })).resolves.toEqual({ status: "invalid_limit" });
    await expect(setAdminAccountAiLimit(pool, { ...base, limit: 120 })).resolves.toMatchObject({ status: "ok" });
    const update = statements.find((entry) => entry.sql.startsWith("update users set ai_daily_limit"));
    expect(update?.params).toEqual([42, 120]);
    const journal = statements.find((entry) => entry.sql.startsWith("insert into admin_account_actions"));
    expect(JSON.parse(String(journal?.params[4]))).toEqual({ from: 30, to: 120 });
    await expect(setAdminAccountAiLimit(pool, { ...base, limit: null })).resolves.toMatchObject({ status: "ok" });
  });
});
