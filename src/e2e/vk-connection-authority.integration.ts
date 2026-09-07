import { AsyncLocalStorage } from "node:async_hooks";
import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { decryptToken, encryptToken } from "@/lib/token-crypto.mjs";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), user: vi.fn() }));
const scope = new AsyncLocalStorage<Headers>();
vi.mock("next/headers", () => ({ headers: async () => scope.getStore() ?? new Headers() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIp: () => "127.0.0.1" }));
import { POST } from "@/app/api/channels/connect-vk/route";

const url = new URL(process.env.VK_AUTHORITY_TEST_DATABASE_URL || "http://invalid");
if (!["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/aurora_vk_authority_test") {
  throw new Error("Requires disposable loopback aurora_vk_authority_test");
}
const pool = new pg.Pool({ connectionString: url.href, max: 6, ssl: false });
const originalMaster = process.env.TOKENS_MASTER_KEY;
let userId: number, projectId: number, otherProjectId: number;
let groupId = 905401, providerCalls = 0;
let providerDenied = false;
const token = "synthetic-vk-community-credential";
const freshToken = "synthetic-vk-community-credential-rotated";

beforeAll(async () => {
  process.env.TOKENS_MASTER_KEY = "isolated-n54-credential-encryption-fixture";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    expect(String(input)).toBe("https://api.vk.com/method/groups.getById");
    expect(init?.method).toBe("POST");
    const body = new URLSearchParams(String(init?.body));
    expect([token, freshToken]).toContain(body.get("access_token"));
    expect(body.has("group_id")).toBe(false);
    providerCalls++;
    return Response.json(providerDenied ? { error: { error_code: 5, error_msg: "Invalid fixture credential" } } : {
      response: { groups: [{ id: groupId, name: "Authorized fixture group", screen_name: "fixture-group" }] },
    });
  });
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: url.href }, logger: { log() {} } });
  userId = Number((await pool.query("insert into users(email) values ('vk-authority@fixture.test') returning id")).rows[0].id);
  [projectId, otherProjectId] = (await pool.query("insert into projects(name,created_by_user_id) values ('VK selected',$1),('VK other',$1) returning id", [userId])).rows.map(row => Number(row.id));
  await pool.query("insert into project_members(project_id,user_id,role) values ($1,$3,'owner'),($2,$3,'owner')", [projectId, otherProjectId, userId]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values ($1,$2)", [userId, projectId]);
});
beforeEach(async () => {
  mocks.pool.mockReturnValue(pool);
  mocks.user.mockResolvedValue({ id: userId });
  await pool.query("delete from channels where project_id=any($1::bigint[])", [[projectId, otherProjectId]]);
  await pool.query("update project_members set status='active', revoked_at=null, role='owner' where user_id=$1", [userId]);
  await pool.query("update projects set is_archived=false where id=any($1::bigint[])", [[projectId, otherProjectId]]);
  await pool.query("update users set blocked_at=null where id=$1", [userId]);
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1", [userId, projectId]);
  providerCalls = 0; providerDenied = false; groupId = 905401;
});
afterAll(async () => {
  vi.unstubAllGlobals();
  if (originalMaster === undefined) delete process.env.TOKENS_MASTER_KEY;
  else process.env.TOKENS_MASTER_KEY = originalMaster;
  await pool.end();
});

function request(credential = token) {
  return scope.run(new Headers({ "x-aurora-project-id": String(projectId) }), () => POST(new NextRequest("http://localhost/api/channels/connect-vk", {
    method: "POST", headers: { origin: "http://localhost", "content-type": "application/json" },
    body: JSON.stringify({ token: credential, groupId: 123456789, projectId: otherProjectId }),
  })));
}
async function seedChannel(project = projectId, owner = userId) {
  return Number((await pool.query("insert into channels(project_id,user_id,network,vk_group_id,vk_token,title,status,is_active,last_auth_error_code,last_auth_error_at) values ($1,$2,'vk',$3,$4,'Original','permission_lost',false,'vk_permission_15',now()) returning id", [project, owner, groupId, encryptToken(token, { userId: owner, provider: "vk" })])).rows[0].id);
}
async function snapshot() {
  const channels = (await pool.query("select id,project_id,user_id,vk_group_id,vk_token,title,status,is_active,last_auth_error_code,last_auth_error_at,updated_at from channels where project_id=any($1::bigint[]) order by id", [[projectId, otherProjectId]])).rows;
  const events = (await pool.query("select * from channel_events where channel_id=any($1::bigint[]) order by id", [channels.map(row => row.id)])).rows;
  return { channels, events };
}
// Actual PostgreSQL returns the first and final authority reads. Between the
// final non-locking read and any write, a second connection commits revocation.
function pauseAfterFinalMembership(action: () => Promise<void>) {
  let reads = 0, used = false;
  const wrap = (db: Pick<pg.Pool, "query">) => async (sql: string, values?: unknown[]) => {
    const result = await db.query(sql, values);
    if (sql.includes("from project_members member") && ++reads === 2) { used = true; await action(); }
    return result;
  };
  return {
    db: { query: wrap(pool), connect: async () => { const client = await pool.connect(); return { query: wrap(client), release: () => client.release() }; } } as unknown as pg.Pool,
    wasUsed: () => used,
  };
}

it("connects only the provider-resolved group into the request-selected project", async () => {
  await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1", [userId, otherProjectId]);
  const response = await request();
  expect(response.status).toBe(200);
  const saved = (await snapshot()).channels;
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ project_id: String(projectId), user_id: String(userId), vk_group_id: String(groupId), status: "active" });
  expect(decryptToken(saved[0].vk_token, { userId, provider: "vk" })).toBe(token);
  expect(providerCalls).toBe(1);
});
it("reconnects an authorized channel and records its restored health", async () => {
  const id = await seedChannel();
  expect((await request(freshToken)).status).toBe(200);
  const saved = await snapshot();
  expect(saved.channels[0]).toMatchObject({ id: String(id), status: "active", is_active: true, last_auth_error_code: null });
  expect(decryptToken(saved.channels[0].vk_token, { userId, provider: "vk" })).toBe(freshToken);
  expect(saved.events).toHaveLength(1);
  expect(saved.events[0]).toMatchObject({ action: "reconnected", from_status: "permission_lost", to_status: "active" });
});
for (const change of ["revoke", "archive", "block"] as const) {
  for (const existing of [false, true]) {
    it(`${change} committed after final guard rejects ${existing ? "reconnect" : "new connect"} without any channel/token/event change`, async () => {
      if (existing) await seedChannel();
      const before = await snapshot();
      const barrier = pauseAfterFinalMembership(async () => {
        if (change === "revoke") await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId, userId]);
        if (change === "archive") await pool.query("update projects set is_archived=true where id=$1", [projectId]);
        if (change === "block") await pool.query("update users set blocked_at=now() where id=$1", [userId]);
      });
      mocks.pool.mockReturnValue(barrier.db);
      const response = await request(freshToken);
      expect(barrier.wasUsed()).toBe(true);
      expect(await snapshot()).toEqual(before);
      expect(response.status).toBe(403);
      expect(providerCalls).toBe(1);
    });
  }
}
it("does not overwrite a group claimed by another project", async () => {
  const id = await seedChannel(otherProjectId);
  await pool.query("update channels set status='active',is_active=true where id=$1", [id]);
  const before = await snapshot();
  expect((await request()).status).toBe(409);
  expect(await snapshot()).toEqual(before);
});
it("does not call the provider for an already revoked member", async () => {
  await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId, userId]);
  expect((await request()).status).toBe(403);
  expect(providerCalls).toBe(0);
  expect((await snapshot()).channels).toEqual([]);
});
it("an invalid provider credential cannot create a channel", async () => {
  providerDenied = true;
  expect((await request()).status).toBe(422);
  expect((await snapshot()).channels).toEqual([]);
  expect(providerCalls).toBe(1);
});

for (const existing of [false, true]) {
  it(`rolls back ${existing ? "token and health" : "channel"} if its event cannot persist`, async () => {
    if (existing) await seedChannel();
    const before = await snapshot();
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let failed = false;
    mocks.pool.mockReturnValue({ query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("insert into channel_events")) { failed = true; throw new Error("synthetic event persistence failure"); }
        return client.query(sql, values);
      } };
    } });
    try {
      expect((await request(freshToken)).status).toBe(500);
      expect(failed).toBe(true);
      expect(await snapshot()).toEqual(before);
    } finally { errorLog.mockRestore(); }
  });
}
it("holds authority until a valid write commits, then rejects the next connection", async () => {
  let revoke: Promise<pg.QueryResult> | undefined;
  let observedLockWait = false;
  mocks.pool.mockReturnValue({ query: pool.query.bind(pool), connect: async () => {
    const client = await pool.connect();
    return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      if (sql.startsWith("select id from users") && !revoke) {
        revoke = pool.query("/* N54 authority fence control */ update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId, userId]);
        const deadline = Date.now() + 4000;
        while (Date.now() < deadline) {
          const waiting = await pool.query("select 1 from pg_stat_activity where query like '/* N54 authority fence control */%' and wait_event_type='Lock'");
          if (waiting.rowCount) { observedLockWait = true; break; }
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        expect(observedLockWait).toBe(true);
      }
      return result;
    } };
  } });
  try {
    expect((await request()).status).toBe(200);
    await revoke;
    expect(observedLockWait).toBe(true);
    expect((await snapshot()).channels).toHaveLength(1);
    const beforeCalls = providerCalls;
    expect((await request(freshToken)).status).toBe(403);
    expect(providerCalls).toBe(beforeCalls);
  } finally { await revoke; }
});

for (const active of [false, true]) {
  it(`another project owner reconnects ${active ? "active" : "inactive"} VK without changing its persisted credential AAD owner`, async () => {
    const id = await seedChannel();
    if (active) await pool.query("update channels set status='active',is_active=true where id=$1", [id]);
    const second = Number((await pool.query("insert into users(email) values ($1) returning id", [`vk-owner-${active}@fixture.test`])).rows[0].id);
    await pool.query("insert into project_members(project_id,user_id,role) values ($1,$2,'owner')", [projectId, second]);
    mocks.user.mockResolvedValue({ id: second });
    const response = await request(freshToken);
    expect(response.status).toBe(200);
    const saved = (await snapshot()).channels;
    expect(saved).toHaveLength(1);
    expect(saved[0].id).toBe(String(id));
    expect(saved[0].user_id).toBe(String(userId));
    // Exactly the worker decrypt contract; a new actor must not silently rebind AAD.
    expect(decryptToken(saved[0].vk_token, { userId: saved[0].user_id, provider: "vk" })).toBe(freshToken);
    expect(() => decryptToken(saved[0].vk_token, { userId: second, provider: "vk" })).toThrow();
    expect(providerCalls).toBe(1);
  });
}
