import { readFile } from "node:fs/promises";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import pg from "pg";

const mocks = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => mocks.getPool() }));

import { migrate } from "../../scripts/migrate.mjs";
import {
  consumePasswordReset,
  createPasswordResetOutboxRequest,
  hashPasswordResetToken,
} from "@/lib/password-reset";
import { createSession, getSessionUser } from "@/lib/session";
import { decryptToken } from "@/lib/token-crypto.mjs";
import { reconcilePasswordResetOutbox } from "../../worker/password-reset-outbox.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_password_gate_test") {
  throw new Error("Gate 7 integration requires disposable local aurora_password_gate_test database");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
let userId = 0;

async function activeTokenRows() {
  return (await pool.query(
    `select t.id, t.generation, t.token_hash, t.used_at, o.token_envelope, o.status
       from password_reset_tokens t join password_reset_outbox o on o.token_id = t.id
      where t.user_id = $1 order by t.generation`,
    [userId],
  )).rows;
}

beforeAll(async () => {
  mocks.getPool.mockReturnValue(pool);
  process.env.TOKENS_MASTER_KEY = "disposable-password-reset-envelope-key";
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query(
    `insert into users (email, name, password_hash)
     values ('qa-password@example.test', 'QA Password', 'old-hash') returning id`,
  )).rows[0].id);
});

afterAll(async () => { await pool.end(); });

describe("password recovery concurrency and delivery", () => {
  it("serializes concurrent forgot requests into one active generation", async () => {
    const [first, second] = await Promise.all([
      createPasswordResetOutboxRequest({ email: "qa-password@example.test", requestIpHash: "ip-a" }, pool),
      createPasswordResetOutboxRequest({ email: "qa-password@example.test", requestIpHash: "ip-b" }, pool),
    ]);
    expect([first?.generation, second?.generation].sort()).toEqual([1, 2]);
    const rows = await activeTokenRows();
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.used_at === null)).toHaveLength(1);
    const firstRaw = decryptToken(rows[0].token_envelope, { userId, provider: "password-reset" });
    expect(hashPasswordResetToken(firstRaw)).toBe(rows[0].token_hash);
    await expect(consumePasswordReset(
      { token: firstRaw, password: "new password one" },
      pool,
      async () => "unused-hash",
    )).resolves.toBe("used");
  });

  it("never leaves a session authenticated against the old credential epoch", async () => {
    const request = await createPasswordResetOutboxRequest({
      email: "qa-password@example.test",
      requestIpHash: "ip-race",
    }, pool);
    expect(request).not.toBeNull();
    const row = (await activeTokenRows()).at(-1);
    const raw = decryptToken(row.token_envelope, { userId, provider: "password-reset" });
    const oldEpoch = Number((await pool.query(
      "select credential_epoch from users where id = $1",
      [userId],
    )).rows[0].credential_epoch);
    const response = NextResponse.json({ ok: true });
    const [sessionCreated, reset] = await Promise.all([
      createSession(response, userId, "race fixture", oldEpoch),
      consumePasswordReset(
        { token: raw, password: "new password two" },
        pool,
        async () => "new-hash",
      ),
    ]);
    expect(reset).toBe("ok");
    expect([true, false]).toContain(sessionCreated);
    expect((await pool.query(
      `select count(*)::int as count from sessions s join users u on u.id = s.user_id
        where s.user_id = $1 and s.credential_epoch = u.credential_epoch`,
      [userId],
    )).rows[0].count).toBe(0);
    const cookie = response.cookies.get("sid")?.value;
    if (cookie) {
      await expect(getSessionUser(new NextRequest("http://localhost/api/auth/me", {
        headers: { cookie: `sid=${cookie}` },
      }))).resolves.toBeNull();
    }
  });

  it("delivers asynchronously and records provider failure without exposing the token", async () => {
    const created = await createPasswordResetOutboxRequest({
      email: "qa-password@example.test",
      requestIpHash: "ip-delivery",
    }, pool);
    expect(created).not.toBeNull();
    const slowProvider = async (_input: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 120));
      const body = JSON.parse(String(init?.body || "{}"));
      expect(body.to).toEqual(["qa-password@example.test"]);
      expect(body.text).toContain("/reset-password#token=");
      return Response.json({ id: "mail-fixture" });
    };
    const outcomes = await reconcilePasswordResetOutbox(pool, {
      env: {
        ...process.env,
        APP_URL: "https://aurora.example",
        RESEND_API_KEY: "fake-provider-key",
        PASSWORD_RESET_FROM: "security@example.test",
      },
      fetchImpl: slowProvider,
    });
    expect(outcomes.some((outcome) => outcome.status === "sent")).toBe(true);
    const outbox = await pool.query(
      "select status, token_envelope, last_error_code from password_reset_outbox where id = $1",
      [created?.outboxId],
    );
    expect(outbox.rows[0]).toMatchObject({ status: "sent", last_error_code: null });
    expect(outbox.rows[0].token_envelope).not.toContain("token=");
  });
});
