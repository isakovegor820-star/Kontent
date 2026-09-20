import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import { adminAlertRecipients } from "../lib/admin-alerts";

const connectionString = process.env.ADMIN_ALERT_TEST_DATABASE_URL;
if (!connectionString) throw new Error("ADMIN_ALERT_TEST_DATABASE_URL must explicitly select an isolated database");
const url = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/^\/aurora_[a-z0-9_]+_test$/u.test(url.pathname)) throw new Error("isolated local aurora_*_test database required");
const pool = new Pool({ connectionString });
let client: PoolClient;
const env = { AURORA_ADMIN_EMAILS: "ops@example.test", AURORA_ADMIN_USER_IDS: "9" };
beforeAll(async () => {
  client = await pool.connect();
  await client.query("create temporary table users (id bigint primary key, email text, verified_email text, tg_chat_id bigint, blocked_at timestamptz)");
});
beforeEach(async () => { await client.query("truncate users"); });
afterAll(async () => { client?.release(); await pool.end(); });

describe("admin alert recipient identity proof", () => {
  it("denies an allowlisted email until the same address has been verified", async () => {
    await client.query("insert into users values (1,'ops@example.test',null,101,null)");
    expect(await adminAlertRecipients(client, env)).toEqual([]);
    await client.query("update users set verified_email=email where id=1");
    expect(await adminAlertRecipients(client, env)).toEqual([{ userId: 1, chatId: "101" }]);
  });
  it("rejects stale proof, blocked users and missing linked chat while retaining explicit ID grants", async () => {
    await client.query("insert into users values (1,'ops@example.test','old@example.test',101,null),(2,'ops@example.test','ops@example.test',102,now()),(3,'ops@example.test','ops@example.test',null,null),(9,null,null,109,null)");
    expect(await adminAlertRecipients(client, env)).toEqual([{ userId: 9, chatId: "109" }]);
  });
});
