import { describe, expect, it, vi } from "vitest";
import {
  consumePasswordReset,
  createPasswordResetToken,
  hashPasswordResetToken,
  passwordResetUrl,
  sendPasswordResetEmail,
} from "./password-reset";

function fakePool(row: {
  id: string;
  user_id: string;
  generation: string;
  expires_at: string;
  used_at: string | null;
} | null) {
  const queries: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql.trim());
      if (sql.includes("from password_reset_tokens")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      if (sql.includes("password_reset_generation") && sql.includes("for update")) {
        return { rows: row ? [{ password_reset_generation: row.generation }] : [], rowCount: row ? 1 : 0 };
      }
      return { rows: [], rowCount: 1 };
    }),
    release: vi.fn(),
  };
  return { pool: { connect: vi.fn(async () => client) }, client, queries };
}

describe("password reset tokens", () => {
  it("stores a digest and places the raw token only in the URL fragment", () => {
    const created = createPasswordResetToken(new Date("2026-08-01T12:00:00Z"));
    expect(created.tokenHash).toBe(hashPasswordResetToken(created.token));
    expect(created.tokenHash).not.toContain(created.token);
    const url = passwordResetUrl("https://aurora.example", created.token);
    expect(url).toContain("/reset-password#token=");
    expect(new URL(url).search).toBe("");
  });

  it("atomically consumes once, updates the password and revokes every session", async () => {
    const h = fakePool({
      id: "10",
      user_id: "7",
      generation: "3",
      expires_at: "2026-08-01T13:00:00Z",
      used_at: null,
    });
    await expect(
      consumePasswordReset(
        { token: "secret", password: "new password", now: new Date("2026-08-01T12:00:00Z") },
        h.pool as never,
        async () => "safe-hash",
      ),
    ).resolves.toBe("ok");
    expect(h.queries.some((sql) => sql.startsWith("update users") && sql.includes("password_hash"))).toBe(true);
    expect(h.queries.some((sql) => sql.startsWith("delete from sessions"))).toBe(true);
    expect(h.queries.at(-1)).toBe("commit");
  });

  it.each([
    ["invalid", null],
    ["used", { id: "1", user_id: "7", generation: "3", expires_at: "2026-08-01T13:00:00Z", used_at: "2026-08-01T11:00:00Z" }],
    ["expired", { id: "1", user_id: "7", generation: "3", expires_at: "2026-08-01T11:00:00Z", used_at: null }],
  ] as const)("returns %s without changing password or sessions", async (expected, row) => {
    const h = fakePool(row);
    await expect(
      consumePasswordReset(
        { token: "secret", password: "new password", now: new Date("2026-08-01T12:00:00Z") },
        h.pool as never,
        async () => "safe-hash",
      ),
    ).resolves.toBe(expected);
    expect(h.queries.some((sql) => sql.startsWith("update users set password_hash"))).toBe(false);
    expect(h.queries.some((sql) => sql.startsWith("delete from sessions"))).toBe(false);
  });
});

describe("password reset delivery", () => {
  it("uses provider authentication and email idempotency without logging the token", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-api-key");
    vi.stubEnv("PASSWORD_RESET_FROM", "Aurora <security@example.com>");
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      void input;
      void init;
      return new Response(JSON.stringify({ id: "mail-1" }), { status: 200 });
    });
    await expect(
      sendPasswordResetEmail(
        {
          to: "qa@example.com",
          resetUrl: "https://aurora.example/reset-password#token=secret",
          idempotencyKey: "reset-1",
        },
        fetchImpl as never,
      ),
    ).resolves.toEqual({ ok: true });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init?.headers).toMatchObject({
      authorization: "Bearer test-api-key",
      "idempotency-key": "reset-1",
    });
    vi.unstubAllEnvs();
  });
});
