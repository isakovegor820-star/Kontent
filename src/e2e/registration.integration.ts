import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { migrate } from "../../scripts/migrate.mjs";
import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { createPasswordResetToken, consumePasswordReset } from "@/lib/password-reset";
import { registerPasswordUser } from "@/lib/password-registration";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const target = databaseUrl ? new URL(databaseUrl) : null;
if (!target || !["localhost", "127.0.0.1", "::1"].includes(target.hostname)
  || target.pathname.slice(1) !== "aurora_publication_gate_test") {
  throw new Error("Registration integration requires disposable local aurora_publication_gate_test database");
}

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 24 });

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
});

afterAll(async () => pool.end());

describe("password registration transaction", () => {
  it("linearizes 20 simultaneous registrations without a 500-shaped exception", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => registerPasswordUser({
      pool,
      email: "parallel-registration@example.test",
      name: `Parallel ${index}`,
      passwordHash: `salt:${index}`,
    })));
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.filter((result) => !result.ok && result.error === "email_taken")).toHaveLength(19);
    const stored = await pool.query(
      "select count(*)::int as count, min(password_hash) as password_hash from users where email = $1",
      ["parallel-registration@example.test"],
    );
    expect(stored.rows[0].count).toBe(1);
    expect(stored.rows[0].password_hash).toMatch(/^salt:/u);
  });

  it("rolls back a fault after INSERT and leaves no credentialless account", async () => {
    await expect(registerPasswordUser({
      pool,
      email: "fault-registration@example.test",
      name: "Fault",
      passwordHash: "salt:hash",
      afterInsert: () => { throw new Error("fault_after_insert"); },
    })).rejects.toThrow("fault_after_insert");
    expect((await pool.query("select count(*)::int as count from users where email = $1", [
      "fault-registration@example.test",
    ])).rows[0].count).toBe(0);
  });

  it("does not attach a password to an existing social identity", async () => {
    await pool.query(
      "insert into users (email, tg_id, name) values ($1, 99112233, 'Social')",
      ["social-registration@example.test"],
    );
    await expect(registerPasswordUser({
      pool,
      email: "social-registration@example.test",
      name: "Attacker",
      passwordHash: "salt:attacker",
    })).resolves.toEqual({ ok: false, error: "email_taken" });
    expect((await pool.query("select password_hash from users where email = $1", [
      "social-registration@example.test",
    ])).rows[0].password_hash).toBeNull();
  });
});


it("does not turn self-asserted registration email into a global admin grant; mailbox proof does", async () => {
  const email = "admin-identity@example.test";
  const result = await registerPasswordUser({pool, email, name: "Unverified", passwordHash: "fake:hash"});
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("fixture registration failed");
  const readIdentity = async () => (await pool.query(
    "select id::int, email, (email is not null and verified_email = email) as email_verified from users where id = $1", [result.userId],
  )).rows[0];
  const env = {AURORA_ADMIN_EMAILS: email};
  expect(hasAuroraAdminAccess(await readIdentity(), env)).toBe(false);
  await pool.query("update users set password_reset_generation = 1 where id = $1", [result.userId]);
  const proof = createPasswordResetToken();
  await pool.query("insert into password_reset_tokens(user_id, token_hash, expires_at, generation) values($1,$2,$3,1)", [result.userId, proof.tokenHash, proof.expiresAt]);
  expect(await consumePasswordReset({token: proof.token, password: "fake-reset-password"}, pool, async () => "fake:new-hash")).toBe("ok");
  expect(hasAuroraAdminAccess(await readIdentity(), env)).toBe(true);
  expect(await consumePasswordReset({token: proof.token, password: "fake-reset-password"}, pool, async () => "fake:new-hash")).toBe("used");
  await pool.query("update users set email = 'different@example.test' where id = $1", [result.userId]);
  expect(hasAuroraAdminAccess(await readIdentity(), {AURORA_ADMIN_EMAILS:"different@example.test"})).toBe(false);
});
