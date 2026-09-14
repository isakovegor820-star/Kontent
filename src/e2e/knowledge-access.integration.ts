import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { revokeProjectMember } from "@/lib/project-context";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), user: vi.fn(), enqueue: vi.fn(), fetch: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.enqueue }) }));
import { DELETE, GET, POST } from "@/app/api/knowledge/route";
vi.mock("@/lib/tg-public", () => ({ fetchPublicPosts: mocks.fetch }));
vi.mock("@/lib/ai-completion-service.mjs", () => ({ completeAiText: mocks.complete }));
import { POST as readChannel } from "@/app/api/knowledge/read-channel/route";
import { PUT as saveProfile, POST as extractProfile } from "@/app/api/knowledge/extract-profile/route";

const databaseUrl = String(process.env.DATABASE_URL || "");
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/aurora_launch_test") {
  throw new Error("Knowledge integration requires disposable local aurora_launch_test");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8, application_name: "knowledge-access-test" });
let owner: number;
let author: number;
let publisher: number;
let projectId: number;
let channelId: number;
let siteId: number;

function request(method: string, suffix = "", body?: unknown) {
  return new NextRequest(`http://localhost/api/knowledge${suffix}`, {
    method, headers: { origin: "http://localhost", "content-type": "application/json", "x-aurora-project-id": String(projectId) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function source(userId = author, kind = "paste") {
  const id = Number((await pool.query(
    `insert into knowledge_sources(user_id, channel_id, kind, title, raw_text, status)
     values ($1,$2,$3,'Shared facts','Ниша канала: Тестовое издательство','ready') returning id`,
    [userId, channelId, kind],
  )).rows[0].id);
  await pool.query(`insert into knowledge_chunks(user_id, channel_id, source_id, kind, text)
    values ($1,$2,$3,'fact','Test source evidence')`, [userId, channelId, id]);
  return id;
}
async function remains(id: number) {
  return Number((await pool.query("select count(*)::int as n from knowledge_chunks where source_id=$1", [id])).rows[0].n);
}
async function revoke() {
  const version = Number((await pool.query(
    "select version from project_members where project_id=$1 and user_id=$2", [projectId, author],
  )).rows[0].version);
  return revokeProjectMember({ pool, actorUserId: owner, projectId, memberUserId: author, expectedVersion: version });
}
async function waitForBlockedQuery(fragment: string) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const row = (await pool.query(`select count(*)::int as n from pg_stat_activity
      where application_name='knowledge-access-test' and pid<>pg_backend_pid()
        and state='active' and query like $1 and cardinality(pg_blocking_pids(pid))>0`, [`%${fragment}%`])).rows[0];
    if (Number(row.n) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`No real PostgreSQL lock wait for ${fragment}`);
}

beforeAll(async () => {
  await pool.query("drop schema public cascade; create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
  [owner, author, publisher] = (await pool.query(`insert into users(email,name)
    values ('owner@knowledge.test','Owner'),('author@knowledge.test','Author'),('publisher@knowledge.test','Publisher') returning id`))
    .rows.map((row) => Number(row.id));
  projectId = Number((await pool.query("insert into projects(name,created_by_user_id) values('Knowledge team',$1) returning id", [owner])).rows[0].id);
  await pool.query(`insert into project_members(project_id,user_id,role)
    values ($1,$2,'owner'),($1,$3,'author'),($1,$4,'publisher')`, [projectId,owner,author,publisher]);
  await pool.query(`insert into user_project_preferences(user_id,selected_project_id)
    values ($2,$1),($3,$1),($4,$1)`, [projectId,owner,author,publisher]);
  channelId = Number((await pool.query(`insert into channels(project_id,user_id,network,tg_chat_id,title,handle)
    values($1,$2,'tg',-100777001,'Knowledge channel','knowledge_fixture') returning id`, [projectId,owner])).rows[0].id);
  const foreignProject = Number((await pool.query("insert into projects(name,created_by_user_id) values('Foreign site',$1) returning id", [owner])).rows[0].id);
  siteId = Number((await pool.query(`insert into sites(project_id,user_id,confirmed_domain,canonical_url,verification_token)
    values($1,$2,'foreign.example.test','https://foreign.example.test','aurora-verify-fixture-01234567890123456789') returning id`, [foreignProject,owner])).rows[0].id);
});
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.pool.mockReturnValue(pool);
  mocks.user.mockResolvedValue({ id: author });
  mocks.enqueue.mockResolvedValue({ id: "test-only-job" });
  mocks.fetch.mockResolvedValue({ posts: Array.from({ length: 3 }, (_, i) => `Проверенный материал тестового канала номер ${i}. Профиль издательства.`) });
  mocks.complete.mockResolvedValue({ text: JSON.stringify({ niche: "Профиль из тестовых публикаций" }) });
  await pool.query("delete from ai_usage where user_id=$1", [author]);
  await pool.query(`update project_members set status='active', revoked_at=null,
    role=case when user_id=$2 then 'owner' when user_id=$3 then 'author' else 'publisher' end,
    version=version+1 where project_id=$1`, [projectId,owner,author]);
  await pool.query("delete from knowledge_sources where channel_id=$1 or site_id=$2", [channelId,siteId]);
});
afterAll(async () => { await pool.end(); });

describe.sequential("knowledge membership and preserved team workflows", () => {
  it("denies a revoked creator without cascading deletion of chunks", async () => {
    const id = await source();
    await revoke();
    expect((await DELETE(request("DELETE", `?id=${id}`))).status).toBe(403);
    expect(await remains(id)).toBe(1);
  });
  it("denies a role downgrade immediately and keeps the source", async () => {
    const id = await source();
    await pool.query("update project_members set role='publisher',version=version+1 where project_id=$1 and user_id=$2", [projectId,author]);
    expect((await DELETE(request("DELETE", `?id=${id}`))).status).toBe(403);
    expect(await remains(id)).toBe(1);
  });
  it("lets an active owner manage a source created by a colleague", async () => {
    const id = await source();
    mocks.user.mockResolvedValue({ id: owner });
    expect((await DELETE(request("DELETE", `?id=${id}`))).status).toBe(200);
    expect(await remains(id)).toBe(0);
  });
  it("allows authors to add facts but keeps publishers read-only", async () => {
    const body = { channelId, kind: "paste", title: "Facts", text: "Verified team facts" };
    expect((await POST(request("POST", "", body))).status).toBe(200);
    mocks.user.mockResolvedValue({ id: publisher });
    expect((await POST(request("POST", "", body))).status).toBe(403);
    expect(mocks.enqueue).toHaveBeenCalledTimes(1);
  });
  it("returns the same shared profile to an author who did not connect the channel", async () => {
    await source(owner, "profile_edit");
    const response = await GET(request("GET", `?channel=${channelId}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ effectiveProfile: { niche: { value: "Тестовое издательство" } } });
  });
  it("replaces the channel profile rather than retaining another author's stale profile", async () => {
    await source(owner, "profile_edit");
    const response = await saveProfile(request("PUT", "/extract-profile", { channelId, profile: { niche: "Новый профиль команды" } }));
    expect(response.status).toBe(200);
    const rows = (await pool.query("select raw_text from knowledge_sources where channel_id=$1 and kind in ('profile','profile_edit')", [channelId])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0].raw_text).toContain("Новый профиль команды");
  });
  it("denies revoked reads and foreign site sources even when the actor created the row", async () => {
    const id = Number((await pool.query(`insert into knowledge_sources(user_id,site_id,kind,title,raw_text)
      values($1,$2,'site_page','Foreign','Foreign site evidence') returning id`, [author,siteId])).rows[0].id);
    expect((await DELETE(request("DELETE", `?id=${id}`))).status).toBe(409);
    await revoke();
    expect((await GET(request("GET", `?channel=${channelId}`))).status).toBe(403);
  });
  it("lets a colleague extract the shared channel profile using the existing AI workflow", async () => {
    const response = await extractProfile(request("POST", "/extract-profile", { channelId }));
    expect(response.status).toBe(200);
    expect(mocks.complete).toHaveBeenCalledOnce();
    expect(Number((await pool.query("select count(*)::int as n from ai_usage where user_id=$1 and status='committed'", [author])).rows[0].n)).toBe(1);
  });
  it("rechecks permission after extraction and releases the reservation if membership was revoked", async () => {
    const id = await source(owner, "profile");
    mocks.complete.mockImplementationOnce(async () => {
      await revoke();
      return { text: JSON.stringify({ niche: "Do not persist this revoked result" }) };
    });
    expect((await extractProfile(request("POST", "/extract-profile", { channelId }))).status).toBe(403);
    expect(await remains(id)).toBe(1);
    expect(Number((await pool.query("select count(*)::int as n from ai_usage where user_id=$1 and status in ('committed','reserved')", [author])).rows[0].n)).toBe(0);
  });
  it("preserves the source if channel reading finishes after a role downgrade", async () => {
    const id = await source(owner, "channel");
    mocks.fetch.mockImplementationOnce(async () => {
      await pool.query("update project_members set role='publisher' where project_id=$1 and user_id=$2", [projectId,author]);
      return { posts: ["Достаточно длинный материал канала для обновления образца стиля."] };
    });
    expect((await readChannel(request("POST", "/read-channel", { channelId }))).status).toBe(403);
    expect(await remains(id)).toBe(1);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("keeps publisher reads working while denying both profile editing and external extraction", async () => {
    const id = await source(owner, "profile_edit");
    mocks.user.mockResolvedValue({ id: publisher });
    expect((await GET(request("GET", `?channel=${channelId}`))).status).toBe(200);
    expect((await saveProfile(request("PUT", "/extract-profile", { channelId, profile: { niche: "Forbidden edit" } }))).status).toBe(403);
    expect((await extractProfile(request("POST", "/extract-profile", { channelId }))).status).toBe(403);
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(await remains(id)).toBe(1);
  });
  it("does not silently substitute the first channel for a malformed selector", async () => {
    expect((await POST(request("POST", "", { channelId: "bad", title: "Fact", text: "Wrong selector" }))).status).toBe(422);
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });
  it("orders a committed revocation before a waiting mutation", async () => {
    const id = await source();
    const blocker = await pool.connect();
    let deleting: Promise<Response> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from project_members where project_id=$1 and user_id=$2 for update", [projectId,author]);
      deleting = DELETE(request("DELETE", `?id=${id}`));
      await waitForBlockedQuery("project_members");
      await blocker.query("update project_members set status='revoked',revoked_at=now(),version=version+1 where project_id=$1 and user_id=$2", [projectId,author]);
      await blocker.query("commit");
      expect((await deleting).status).toBe(403);
      expect(await remains(id)).toBe(1);
    } finally {
      await blocker.query("rollback"); blocker.release();
      await deleting;
    }
  });
  it("lets an already authorized mutation commit before revocation, with no deadlock", async () => {
    const id = await source();
    const blocker = await pool.connect();
    let deleting: Promise<Response> | undefined;
    let revoking: Promise<unknown> | undefined;
    try {
      await blocker.query("begin");
      await blocker.query("select 1 from knowledge_sources where id=$1 for update", [id]);
      deleting = DELETE(request("DELETE", `?id=${id}`));
      await waitForBlockedQuery("knowledge_sources");
      revoking = revoke();
      await waitForBlockedQuery("project_members");
      await blocker.query("commit");
      expect((await deleting).status).toBe(200);
      await revoking;
      expect(await remains(id)).toBe(0);
    } finally {
      await blocker.query("rollback"); blocker.release();
      await Promise.allSettled([deleting, revoking].filter(Boolean));
    }
  });
});
