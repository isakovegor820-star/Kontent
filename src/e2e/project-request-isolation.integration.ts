import { randomUUID } from "node:crypto";
import { confirmTelegramChannelProject } from "@/lib/telegram-channel-connect.mjs";
import { authorizeGenerationAcknowledgement } from "@/lib/generation-artifacts";
import { runWithProjectRequest } from "@/lib/project-request-context";
import { collectRssPipeline } from "../../worker/rss-pipeline.mjs";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { serializeStudioChatSession } from "@/lib/studio-chat-session";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), queue: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }) }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.queue }) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true }), rateLimitResponse: vi.fn() }));
vi.mock("@/lib/rss-catalog", () => ({ listPublicLegalRssSources: () => [{ title: "Fixture feed", url: "https://feed.example.test/rss" }] }));
import { GET as channels } from "@/app/api/channels/route";
import { PATCH as projectSettings } from "@/app/api/projects/current/route";
import { GET as studio, PUT as saveStudio } from "@/app/api/studio/session/route";
import { POST as addKnowledge } from "@/app/api/knowledge/route";
import { POST as bootstrapRss } from "@/app/api/rss/bootstrap/route";
import { GET as feeds } from "@/app/api/rss/route";
import { GET as ideas } from "@/app/api/ideas/route";
import { GET as radar } from "@/app/api/radar/search/route";

const databaseUrl = String(process.env.DATABASE_URL || "");
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/aurora_launch_test") throw new Error("Disposable local aurora_launch_test required");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let actor: number, colleague: number, a: number, b: number, channelA: number, channelB: number;
function request(path: string, projectId: number | null, method = "GET", body?: unknown, userId = actor) {
  return new NextRequest(`http://localhost/api/${path}`, { method,
    headers: { origin: "http://localhost", "content-type": "application/json", "x-test-user": String(userId),
      ...(projectId == null ? {} : { "x-aurora-project-id": String(projectId) }) },
    ...(body == null ? {} : { body: JSON.stringify(body) }),
  });
}
function session(text: string) {
  return JSON.parse(serializeStudioChatSession(actor, { messages: [{ id: "m1", role: "user", text }], draft: text, workspaceMode: "chat", generations: [] }));
}
beforeAll(async () => {
  await pool.query("drop schema public cascade; create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ directory: fileURLToPath(new URL("../../db/migrations", import.meta.url)), env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
  [actor, colleague] = (await pool.query("insert into users(email,name) values('scope-owner@example.test','Owner'),('scope-author@example.test','Author') returning id")).rows.map((r) => Number(r.id));
  [a, b] = (await pool.query("insert into projects(name,created_by_user_id) values('Project A',$1),('Project B',$1) returning id", [actor])).rows.map((r) => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner'),($1,$4,'author')", [a,b,actor,colleague]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2),($3,$2)", [actor,a,colleague]);
  [channelA, channelB] = (await pool.query(`insert into channels(project_id,user_id,network,tg_chat_id,title)
    values($1,$3,'tg',-10077001,'Channel A'),($2,$3,'tg',-10077002,'Channel B') returning id`, [a,b,actor])).rows.map((r) => Number(r.id));
});
beforeEach(async () => {
  vi.clearAllMocks(); mocks.pool.mockReturnValue(pool); mocks.queue.mockResolvedValue({ id: "fake-job" });
  await pool.query("update user_project_preferences set selected_project_id=$1 where user_id=$2", [b,actor]);
  await pool.query("update projects set name=case when id=$1 then 'Project A' else 'Project B' end where id in ($1,$2)", [a,b]);
  await pool.query("update project_members set status='active',revoked_at=null where project_id in ($1,$2)", [a,b]);
});
afterAll(async () => { await pool.end(); });

describe.sequential("project selectors through actual PostgreSQL API routes", () => {
  it("baseline: a tab reading A does not follow another session's selection B", async () => {
    const response = await channels(request("channels", a));
    expect(response.status).toBe(200);
    expect((await response.json()).channels.map((c: { title: string }) => c.title)).toEqual(["Channel A"]);
  });
  it("baseline: settings submitted from A cannot rename the server-selected B", async () => {
    const response = await projectSettings(request("projects/current", a, "PATCH", { name: "Changed A", timezone: "UTC" }));
    expect(response.status).toBe(200);
    expect((await pool.query("select name from projects where id=$1", [a])).rows[0].name).toBe("Changed A");
    expect((await pool.query("select name from projects where id=$1", [b])).rows[0].name).toBe("Project B");
  });
  it("baseline: an authenticated mutation without a selector is rejected", async () => {
    expect((await projectSettings(request("projects/current", null, "PATCH", { name: "Wrong", timezone: "UTC" }))).status).toBe(428);
  });
  it("baseline: the same actor's Studio histories remain separate in A and B", async () => {
    const initial = await studio(request("studio/session", a));
    expect((await saveStudio(request("studio/session", a, "PUT", { expectedRevision: (await initial.json()).revision, session: session("Private A brief") }))).status).toBe(200);
    const response = await studio(request("studio/session", b));
    expect((await response.json()).session).toBeNull();
  });
  it("serves concurrent A and B requests without mixing async context", async () => {
    const replies = await Promise.all(Array.from({ length: 12 }, (_, index) => channels(request("channels", index % 2 ? b : a))));
    for (let i=0;i<replies.length;i++) {
      expect(replies[i].headers.get("x-aurora-project-id")).toBe(String(i % 2 ? b : a));
      expect((await replies[i].json()).channels[0].title).toBe(i % 2 ? "Channel B" : "Channel A");
    }
  });
  it("checks current membership in A even while the account selection remains accessible B", async () => {
    await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
    expect((await channels(request("channels", a))).status).toBe(403);
    expect((await channels(request("channels", b))).status).toBe(200);
  });
  it("rejects B's object id in a mutation captured for A", async () => {
    const response = await addKnowledge(request("knowledge", a, "POST", { channelId: channelB, kind: "paste", title: "Wrong", text: "This belongs to another project" }));
    expect(response.status).toBe(409);
    expect((await pool.query("select count(*)::int as n from knowledge_sources where channel_id=$1", [channelB])).rows[0].n).toBe(0);
    expect(mocks.queue).not.toHaveBeenCalled();
  });
  it("keeps equal RSS URLs in separate projects and reuses a colleague's subscription", async () => {
    const fromA = await bootstrapRss(request("rss/bootstrap", a, "POST", { channelId: channelA }));
    const fromB = await bootstrapRss(request("rss/bootstrap", b, "POST", { channelId: channelB }));
    expect(fromA.status).toBe(200); expect(fromB.status).toBe(200);
    const fromColleague = await bootstrapRss(request("rss/bootstrap", a, "POST", { channelId: channelA }, colleague));
    expect(fromColleague.status).toBe(200);
    expect((await pool.query("select channel_id from rss_feeds order by channel_id")).rows.map((r) => Number(r.channel_id))).toEqual([channelA,channelB]);
    const visible = await feeds(request("rss", a, "GET", undefined, colleague));
    expect((await visible.json()).feeds.map((f: { channel_id: number }) => f.channel_id)).toEqual([channelA]);
  });
  it("does not expose the actor's idea from another project's competitor", async () => {
    const competitor = (await pool.query("insert into competitors(user_id,channel_id,network,handle) values($1,$2,'tg','fixture_b') returning id", [actor,channelB])).rows[0].id;
    await pool.query("insert into content_ideas(user_id,competitor_id,topic,hook,structure,ai_status) values($1,$2,'B topic','B hook','B structure','ready')", [actor,competitor]);
    expect((await (await ideas(request("ideas", a))).json()).ideas).toEqual([]);
  });
  it("does not expose a radar run from B through its id in A", async () => {
    const run = (await pool.query("insert into radar_search_runs(project_id,user_id,channel_id,request_key,query,normalized_query) values($1,$2,$3,'scope-radar-key','Fixture search','fixture search') returning id", [b,actor,channelB])).rows[0].id;
    expect((await radar(request(`radar/search?run=${run}`, a))).status).toBe(404);
  });
});


describe.sequential("captured project in delayed operations", () => {
  it("binds Telegram to the confirmed project after another device selects B", async () => {
    const chatId = -10077003;
    const api = vi.fn(async (method: string, payload: { user_id?: number }) => method === "getChat"
      ? { ok: true, result: { id: chatId, type: "channel", title: "Confirmed A" } }
      : { ok: true, result: payload.user_id === 909 ? { status: "administrator", can_post_messages: true } : { status: "creator" } });
    const saved = await confirmTelegramChannelProject(pool, { userId: actor, projectId: a, actorId: 808, botId: 909, chatId, requestId: "test-confirm-A" }, api);
    expect(saved.state).toBe("connected");
    expect(Number((await pool.query("select project_id from channels where tg_chat_id=$1", [chatId])).rows[0].project_id)).toBe(a);
    expect((await confirmTelegramChannelProject(pool, { userId: actor, projectId: a, actorId: 808, botId: 909, chatId, requestId: "test-confirm-A" }, api)).state).toBe("already_connected");
    expect((await pool.query("select count(*)::int as n from channels where tg_chat_id=$1", [chatId])).rows[0].n).toBe(1);
  });
  it("rechecks Telegram and project rights before binding a new channel", async () => {
    const input = { userId: actor, projectId: a, actorId: 808, botId: 909, chatId: -10077004 };
    const api = vi.fn(async () => ({ ok: false }));
    await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
    expect((await confirmTelegramChannelProject(pool, input, api)).state).toBe("access_denied");
    expect(api).not.toHaveBeenCalled();
    await pool.query("update project_members set status='active',revoked_at=null where project_id=$1 and user_id=$2", [a,actor]);
    expect((await confirmTelegramChannelProject(pool, input, api)).state).toBe("telegram_access_denied");
    expect((await pool.query("select count(*)::int as n from channels where tg_chat_id=$1", [input.chatId])).rows[0].n).toBe(0);
  });
  it("checks the generation operation's project before ACK even when preferences point elsewhere", async () => {
    const usage = (await pool.query("insert into ai_usage(user_id,kind) values($1,'generate') returning id", [actor])).rows[0].id;
    const key = "web:project-scoped-ack";
    await pool.query(`insert into generation_operations(user_id,ai_usage_id,request_key,server_request_id,request_fingerprint,channel_id,provider_engine,provider_model,status)
      values($1,$2,$3,$4,$5,$6,'fixture','fixture','pending_ack')`, [actor,usage,key,randomUUID(),"a".repeat(64),channelA]);
    const inProject = (projectId: number) => runWithProjectRequest({ projectId, mismatch: false }, () => authorizeGenerationAcknowledgement(actor, key));
    expect(await inProject(a)).toBe(true);
    expect(await inProject(b)).toBe(false);
    await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
    await expect(inProject(a)).rejects.toMatchObject({ code: "membership_required" });
  });
  it("collects a shared RSS subscription only inside the queued project", async () => {
    const urls: string[] = [];
    const result = await collectRssPipeline({ pool, userId: colleague, projectId: a, channelId: channelA,
      fetchFn: async (url: string) => { urls.push(url); return new Response("<rss><channel></channel></rss>"); },
      enqueuePost: vi.fn(), summarize: vi.fn(), logger: { error() {}, log() {} },
    });
    expect(result.feeds).toBe(1);
    expect(urls).toEqual(["https://feed.example.test/rss"]);
    await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,colleague]);
    const deniedFetch = vi.fn();
    expect(await collectRssPipeline({ pool, userId: colleague, projectId: a, channelId: channelA,
      fetchFn: deniedFetch, enqueuePost: vi.fn(), summarize: vi.fn(), logger: { error() {}, log() {} },
    })).toEqual({ feeds: 0, posts: 0 });
    expect(deniedFetch).not.toHaveBeenCalled();
  });
});
