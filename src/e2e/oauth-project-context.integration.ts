import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
const mocks = vi.hoisted(() => ({ pool: vi.fn(), user: vi.fn(), exchange: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/rate-limit", () => ({ clientIp: () => "local-fixture", checkRateLimit: async () => ({ allowed: true }), rateLimitResponse: vi.fn() }));
vi.mock("@/lib/oauth-capabilities", () => ({ hasComposerPayloadSupport: () => true }));
vi.mock("@/lib/social-providers.mjs", () => ({
  getOAuthConfig: () => ({ id: "youtube" }),
  getAdapter: () => ({ finalizeTokens: async () => ({ ok: true, externalId: "isolated-oauth-channel", meta: { title: "Isolated OAuth" } }) }),
}));
vi.mock("@/lib/oauth.mjs", () => ({ exchangeCode: mocks.exchange }));
import { GET } from "@/app/api/channels/oauth/callback/route";
import { sealOAuthState } from "@/lib/oauth-state";

const connectionString = String(process.env.PROJECT_CONTEXT_TEST_DATABASE_URL || "");
const target = new URL(connectionString);
if (!["127.0.0.1", "localhost"].includes(target.hostname) || target.pathname !== "/aurora_oauth_context_test") throw new Error("Requires disposable aurora_oauth_context_test");
const pool = new pg.Pool({ connectionString, ssl: false });
let client: pg.PoolClient; let userId: number; let a: number; let b: number;
beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: connectionString }, logger: { log() {} } });
});
beforeEach(async () => {
  vi.stubEnv("TOKENS_MASTER_KEY", "isolated-oauth-integration-key");
  client = await pool.connect(); await client.query("begin");
  userId = Number((await client.query("insert into users(email) values($1) returning id", [`oauth-${randomUUID()}@fixture.test`])).rows[0].id);
  [a, b] = (await client.query("insert into projects(name,created_by_user_id) values('OAuth A',$1),('OAuth B',$1) returning id", [userId])).rows.map((row) => Number(row.id));
  await client.query("insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')", [a, b, userId]);
  await client.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [userId, b]);
  mocks.user.mockResolvedValue({ id: userId });
  mocks.exchange.mockReset(); mocks.exchange.mockResolvedValue({ accessToken: "isolated-provider-token", scope: "publish" });
  // Keep the actual route transaction inside an outer rollback-only test fixture.
  const query = async (sql: string, params?: unknown[]) => {
    if (sql === "begin") return client.query("savepoint oauth_route");
    if (sql === "commit") return client.query("release savepoint oauth_route");
    if (sql === "rollback") {
      await client.query("rollback to savepoint oauth_route"); return client.query("release savepoint oauth_route");
    }
    return client.query(sql, params);
  };
  mocks.pool.mockReturnValue({ query: client.query.bind(client), connect: async () => ({ query, release() {} }) });
});
afterEach(async () => { await client.query("rollback"); client.release(); vi.unstubAllEnvs(); });
afterAll(async () => { await pool.end(); });
function request() {
  const state = sealOAuthState({ state: "isolated-state", verifier: "isolated-pkce", network: "youtube", userId, projectId: a });
  return new NextRequest("http://localhost/api/channels/oauth/callback?network=youtube&code=isolated-code&state=isolated-state", { headers: { cookie: `oauth_state=${encodeURIComponent(state)}` } });
}
describe("OAuth callback with real PostgreSQL project guards", () => {
  it("creates the channel in A while another tab's persisted preference is B", async () => {
    const response = await GET(request());
    expect(response.headers.get("location")).toContain(`oauthProjectId=${a}`);
    const channel = (await client.query("select project_id,user_id from channels where user_id=$1", [userId])).rows;
    expect(channel).toEqual([{ project_id: String(a), user_id: String(userId) }]);
    expect(Number((await client.query("select selected_project_id from user_project_preferences where user_id=$1", [userId])).rows[0].selected_project_id)).toBe(b);
  });
  it("blocks a revoked owner before any provider exchange", async () => {
    await client.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a, userId]);
    expect((await GET(request())).headers.get("location")).toContain("oauth=forbidden");
    expect(mocks.exchange).not.toHaveBeenCalled();
  });
  it("blocks demotion during the provider exchange before token/channel writes", async () => {
    mocks.exchange.mockImplementationOnce(async () => {
      await client.query("update project_members set role='author' where project_id=$1 and user_id=$2", [a, userId]);
      return { accessToken: "isolated-provider-token", scope: "publish" };
    });
    expect((await GET(request())).headers.get("location")).toContain("oauth=forbidden");
    expect((await client.query("select id from oauth_tokens where user_id=$1", [userId])).rowCount).toBe(0);
    expect((await client.query("select id from channels where user_id=$1", [userId])).rowCount).toBe(0);
  });
  it("does not move an active same-owner channel from B and rolls back the new token", async () => {
    await client.query("insert into channels(project_id,user_id,network,youtube_channel_id) values($1,$2,'youtube','isolated-oauth-channel')", [b, userId]);
    expect((await GET(request())).headers.get("location")).toContain("oauth=taken");
    expect(Number((await client.query("select project_id from channels where user_id=$1", [userId])).rows[0].project_id)).toBe(b);
    expect((await client.query("select id from oauth_tokens where user_id=$1", [userId])).rowCount).toBe(0);
  });
});
