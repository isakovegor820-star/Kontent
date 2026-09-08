import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptToken, decryptToken, tokenEnvelopeKeyId } from "@/lib/token-crypto.mjs";
import { reencryptTokenBatch } from "@/lib/token-reencryption.mjs";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), group: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), clientIp: () => "127.0.0.1", rateLimitResponse: vi.fn() }));
vi.mock("@/lib/vk", () => ({ resolveGroupByToken: mocks.group }));
// Exercise dormant persistence independently of the release gate. Production's
// immutable registry remains closed and is checked separately with no override.
vi.mock("@/lib/provider-write-boundary.mjs", () => ({ resolveProviderLiveWriteBoundary: () => ({ allowed: true }) }));
import { POST } from "@/app/api/channels/connect-vk/route";
const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || target.port !== "55437") throw new Error("Isolated local PostgreSQL required");
const admin = new pg.Pool({ connectionString: target.href, ssl: false });
const database = `aurora_vk_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, ssl: false, max: 8 });
let creator: number, actor: number, projectId: number, channelId: number;
const group = { groupId: 755100, name: "Fixture VK", screenName: "fixture", membersCount: 0 };
function request(token = "replacement-test-token", userId = actor) {
  return new NextRequest("http://localhost/api/channels/connect-vk", { method: "POST", headers: {
    origin: "http://localhost", "content-type": "application/json", "x-test-user": String(userId), "x-aurora-project-id": String(projectId),
  }, body: JSON.stringify({ token }) });
}
async function channel() { return (await pool.query("select * from channels where id=$1", [channelId])).rows[0]; }
beforeAll(async () => {
  // Each run owns a new DB; existing databases and fixtures are never cleared.
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  [creator, actor] = (await pool.query("insert into users(email) values('vk-original@example.test'),('vk-owner@example.test') returning id")).rows.map(r => Number(r.id));
  projectId = Number((await pool.query("insert into projects(name,created_by_user_id) values('VK fixture',$1) returning id", [creator])).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner'),($1,$3,'owner')", [projectId,creator,actor]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$3),($2,$3)", [creator,actor,projectId]);
  channelId = Number((await pool.query("insert into channels(project_id,user_id,network,vk_group_id,title) values($1,$2,'vk',$3,'Original') returning id", [projectId,creator,group.groupId])).rows[0].id);
});
beforeEach(async () => {
  vi.clearAllMocks(); mocks.pool.mockReturnValue(pool); mocks.group.mockResolvedValue(group);
  vi.stubEnv("TOKENS_MASTER_KEY", "fixture-old-master"); vi.stubEnv("TOKENS_KEY_ID", "old"); vi.stubEnv("TOKENS_OLD_KEYS", "");
  await pool.query("update project_members set status='active',revoked_at=null where project_id=$1", [projectId]);
  await pool.query("update channels set title='Original',vk_token=$2,status='revoked',is_active=false where id=$1", [channelId,encryptToken("original-test-token", { userId: creator, provider: "vk" })]);
});
afterAll(async () => { vi.unstubAllEnvs(); await pool.end(); await admin.end(); });

describe.sequential("VK dormant credential storage with real PostgreSQL", () => {
  it("reconnect by another owner keeps the stored encryption identity", async () => {
    expect((await POST(request())).status).toBe(200);
    const row = await channel();
    expect(Number(row.user_id)).toBe(creator);
    expect(decryptToken(row.vk_token, { userId: creator, provider: "vk" })).toBe("replacement-test-token");
    expect(() => decryptToken(row.vk_token, { userId: actor, provider: "vk" })).toThrow();
    // Credential storage alone cannot claim verified permission or repair auth health.
    expect(row.status).toBe("revoked"); expect(row.is_active).toBe(false);
    const audit = (await pool.query("select actor_user_id from channel_events where channel_id=$1 order by id desc limit 1", [channelId])).rows[0];
    expect(Number(audit.actor_user_id)).toBe(actor);
  });
  it("concurrent owners update one channel with a decryptable envelope", async () => {
    const responses = await Promise.all([POST(request("token-a", creator)), POST(request("token-b", actor))]);
    expect(responses.map(r => r.status)).toEqual([200,200]);
    const row = await channel();
    expect(["token-a","token-b"]).toContain(decryptToken(row.vk_token, { userId: creator, provider: "vk" }));
    expect(Number((await pool.query("select count(*) from channels where project_id=$1 and vk_group_id=$2", [projectId,group.groupId])).rows[0].count)).toBe(1);
  });
  it("auth failure preserves the previous token and status", async () => {
    const before = await channel(); mocks.group.mockResolvedValueOnce(null);
    expect((await POST(request())).status).toBe(422);
    expect(await channel()).toEqual(before);
  });
  it("revocation during credential lookup prevents persistence", async () => {
    const before = await channel();
    mocks.group.mockImplementationOnce(async () => {
      await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId,actor]);
      return group;
    });
    expect((await POST(request())).status).toBe(403);
    expect(await channel()).toEqual(before);
  });
  it("audit failure rolls the credential update back", async () => {
    const before = await channel();
    mocks.pool.mockReturnValue({ query: pool.query.bind(pool), connect: async () => {
      const client = await pool.connect();
      return { release: () => client.release(), query: async (sql: string, values?: unknown[]) => {
        if (sql.includes("insert into channel_events")) throw new Error("fixture audit unavailable");
        return client.query(sql, values);
      } };
    } });
    expect((await POST(request())).status).toBe(500);
    expect(await channel()).toEqual(before);
  });
  it("rotates a reconnected token and restores access when the old key returns", async () => {
    expect((await POST(request())).status).toBe(200);
    const old = (await channel()).vk_token;
    vi.stubEnv("TOKENS_MASTER_KEY", "fixture-new-master"); vi.stubEnv("TOKENS_KEY_ID", "new");
    expect(() => decryptToken(old, { userId: creator, provider: "vk" })).toThrow("token_key_unknown");
    const before = await channel();
    await expect(reencryptTokenBatch({ pool })).rejects.toThrow("token_key_unknown");
    expect(await channel()).toEqual(before);
    vi.stubEnv("TOKENS_OLD_KEYS", JSON.stringify({ old: "fixture-old-master" }));
    expect((await reencryptTokenBatch({ pool })).reencrypted).toBe(1);
    vi.stubEnv("TOKENS_OLD_KEYS", "");
    const fresh = (await channel()).vk_token;
    expect(tokenEnvelopeKeyId(fresh)).toBe("new");
    expect(decryptToken(fresh, { userId: creator, provider: "vk" })).toBe("replacement-test-token");
  });
});
