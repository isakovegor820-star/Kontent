import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import { migrate } from "../../scripts/migrate.mjs";
import { Pool, type PoolClient } from "pg";
import { NextRequest } from "next/server";

const database = vi.hoisted(() => ({ getPool: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: database.getPool }));
import { hashSessionToken } from "@/lib/session";
import { GET as aiSpend } from "@/app/api/admin/ai-spend/route";
import { GET as connections } from "@/app/api/admin/connections/route";

const connectionString = process.env.ADMIN_RESOURCE_TEST_DATABASE_URL;
if (!connectionString) throw new Error("ADMIN_RESOURCE_TEST_DATABASE_URL must explicitly name the isolated test database");
const target = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/aurora_admin_resource_test") throw new Error("disposable local aurora_admin_resource_test required");
const pool = new Pool({ connectionString, ssl: false });
let client: PoolClient;
let sqlCalls: { sql: string; params?: unknown[] }[] = [];
const handlers = [["ai-spend", aiSpend], ["connections", connections]] as const;
const token = (userId: number) => `isolated-admin-resource-session-${userId}`;
const request = (route: string, userId?: number, query = "") => new NextRequest(`http://localhost/api/admin/${route}${query}`, { headers: userId ? { cookie: `sid=${token(userId)}` } : {} });

beforeAll(async () => {
  // Public catalog checks must see the actual candidate schema. This strict local
  // database belongs only to this suite; its state never depends on a prior run.
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: connectionString }, logger: { log() {} } });
  client = await pool.connect();
  // Exercise the real ledger's UTC budget day even on a non-UTC database session.
  // A current_date shadow default hid today's attempts after local midnight.
  await client.query("set time zone 'Pacific/Kiritimati'");
  // Session-local content shadows preserve compact auth/data fixtures while the
  // loader's public ledger capability check executes against the real schema.
  await client.query(`
    create temporary table users (id bigint primary key,email text,verified_email text,tg_chat_id bigint,blocked_at timestamptz,
      tg_id bigint,vk_id bigint,name text,avatar text,onboarding_completed_at timestamptz,credential_epoch bigint default 0);
    create temporary table sessions (token_hash text primary key,user_id bigint,expires_at timestamptz,credential_epoch bigint default 0);
    create temporary table projects (id bigint primary key,name text,is_archived boolean default false);
    create temporary table project_members (project_id bigint,user_id bigint,status text,role text);
    create temporary table user_project_preferences (user_id bigint,selected_project_id bigint);
    create temporary table channels (id bigint,user_id bigint,project_id bigint,title text,handle text,network text,status text,is_active boolean,
      last_auth_error_code text,last_auth_error_at timestamptz,updated_at timestamptz default now(),vk_token text);
    create temporary table ai_spend_attempts (project_id bigint,provider text,model text,budget_date date default (now() at time zone 'UTC')::date,status text,
      usage_known boolean,charged_microusd bigint,reserved_microusd bigint,provider_secret text);
    create temporary table admin_account_actions (action text);
    create temporary table admin_observation_events (action text);
  `);
  vi.stubEnv("AURORA_ADMIN_USER_IDS", "1,5,7,8");
  vi.stubEnv("AURORA_ADMIN_EMAILS", "ops@example.test");
  database.getPool.mockReturnValue({ query: async (sql: string, params?: unknown[]) => {
    sqlCalls.push({ sql, params });
    // These GET handlers must not mutate application state, renew sessions with a
    // full remaining lifetime, or create a misleading mutation-audit record.
    if (!/^\s*select\b/i.test(sql)) throw new Error("unexpected_admin_read_mutation");
    return client.query(sql, params);
  } });
});
beforeEach(async () => {
  await client.query("truncate users,sessions,projects,project_members,user_project_preferences,channels,ai_spend_attempts,admin_account_actions,admin_observation_events");
  await client.query(`insert into users(id,email,verified_email,blocked_at,credential_epoch) values
    (1,null,null,null,0),(2,'owner@example.test','owner@example.test',null,0),
    (3,'ops@example.test',null,null,0),(4,'ops@example.test','ops@example.test',null,0),
    (5,'ops@example.test','ops@example.test',now(),0),(6,'ops@example.test','old@example.test',null,0),
    (7,null,null,null,1),(8,null,null,null,0)`);
  await client.query("insert into projects values(11,'Private project',false)");
  for (let id = 1; id <= 8; id++) {
    await client.query("insert into sessions values($1,$2,now()+interval '30 days',0)",[hashSessionToken(token(id)),id]);
    await client.query("insert into user_project_preferences values($1,11)",[id]);
    await client.query("insert into project_members values(11,$1,'active','owner')",[id]);
  }
  await client.query("update sessions set expires_at=now()-interval '1 second' where user_id=8");
  await client.query("insert into channels(id,user_id,project_id,title,handle,network,status,is_active,vk_token) values(101,2,11,'Private channel','fixture_handle','vk','active',true,'credential-canary-never-return')");
  await client.query("insert into ai_spend_attempts(project_id,provider,model,status,usage_known,charged_microusd,reserved_microusd,provider_secret) values(11,'fake-provider','fake-model','failed',true,120,200,'credential-canary-never-return')");
  expect((await client.query("select budget_date = (now() at time zone 'UTC')::date as utc_budget_day from ai_spend_attempts")).rows[0].utc_budget_day).toBe(true);
  sqlCalls = [];
});
afterAll(async () => { vi.unstubAllEnvs(); client?.release(); await pool.end(); });

for (const [route, GET] of handlers) describe(`actual GET /api/admin/${route} with PostgreSQL session and policy`, () => {
  it.each([
    [undefined,401,"absent"], [5,401,"blocked allowlisted admin"], [7,401,"credential-epoch revoked admin"], [8,401,"expired admin"],
    [2,403,"regular project owner"], [3,403,"unverified allowlisted email"], [6,403,"stale verified email"],
  ] as const)("denies %s → %s (%s) before reading operational data", async (userId,status,scenario) => {
    const response = await GET(request(route,userId));
    expect(response.status,scenario).toBe(status);
    expect(await response.json()).toEqual({ error: status === 401 ? "unauthorized" : "access_denied" });
    expect(sqlCalls.every(({sql}) => /from sessions s/.test(sql))).toBe(true);
    expect(sqlCalls.some(({sql}) => /from channels|from ai_spend_attempts/.test(sql))).toBe(false);
    if (userId) expect(sqlCalls[0].params).toEqual([hashSessionToken(token(userId))]);
    expect((await client.query("select count(*)::int as count from admin_account_actions")).rows[0].count).toBe(0);
    expect((await client.query("select count(*)::int as count from admin_observation_events")).rows[0].count).toBe(0);
  });
  it.each([1,4])("returns only read-only uncached operational data for lawful admin %s", async (userId) => {
    const response = await GET(request(route,userId));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body.items).toHaveLength(1);
    expect(JSON.stringify(body)).not.toContain("credential-canary");
    if (route === "ai-spend") expect(body).toMatchObject({availability:"ready",summary:{attempts:1,failed:1,knownMicrousd:"120"},items:[{projectId:11,knownMicrousd:"120"}]});
    else expect(body.items[0]).toMatchObject({id:101,userId:2,project:"Private project",status:"active"});
    expect(sqlCalls.length).toBeGreaterThan(1); expect(sqlCalls.every(({sql})=>/^\s*select\b/i.test(sql))).toBe(true);
    expect((await client.query("select count(*)::int as count from admin_account_actions")).rows[0].count).toBe(0);
    expect((await client.query("select count(*)::int as count from admin_observation_events")).rows[0].count).toBe(0);
    expect((await client.query("select count(*)::int as count from channels")).rows[0].count).toBe(1);
    expect((await client.query("select count(*)::int as count from sessions")).rows[0].count).toBe(8);
  });
  it("keeps hostile query text as a SQL parameter without altering data", async () => {
    const query = "'; delete from channels; --";
    const response = await GET(request(route,1,`?q=${encodeURIComponent(query)}&page=9999999`));
    expect(response.status).toBe(200);
    expect((await response.json()).items).toEqual([]);
    expect(sqlCalls.some(({params})=>params?.includes(query))).toBe(true);
    expect(sqlCalls.every(({sql})=>!sql.includes(query))).toBe(true);
    expect((await client.query("select count(*)::int as count from channels")).rows[0].count).toBe(1);
  });
});
