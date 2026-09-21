import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

import { migrate } from "../../scripts/migrate.mjs";
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
