import { readFile } from "node:fs/promises";
import { NextRequest } from "next/server";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";

const mocks = vi.hoisted(() => ({ pool: vi.fn(), session: vi.fn(), enqueue: vi.fn(), fetchPosts: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.session }));
vi.mock("@/lib/queue", () => ({ getStatsQueue: () => ({ add: mocks.enqueue }) }));
vi.mock("@/lib/tg-public", () => ({ fetchPublicPosts: mocks.fetchPosts }));
import { POST as addKnowledge, DELETE as deleteKnowledge } from "@/app/api/knowledge/route";
import { POST as readChannel } from "@/app/api/knowledge/read-channel/route";
import { POST as extractProfile, PUT as editProfile } from "@/app/api/knowledge/extract-profile/route";

const databaseUrl = process.env.MIGRATION_TEST_DATABASE_URL || "";
const target = new URL(databaseUrl);
if (!(["127.0.0.1", "localhost"].includes(target.hostname)) || target.pathname !== "/aurora_publication_gate_test") {
  throw new Error("Knowledge integration requires disposable local aurora_publication_gate_test");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 6 });
let userId: number;
let projectId: number;
let channelId: number;
let foreignSourceId: number;
let sourceId: number;
function request(path: string, method: string, body?: unknown) {
  return new NextRequest(`http://localhost${path}`, { method, headers: { origin: "http://localhost" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

beforeAll(async () => {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  userId = Number((await pool.query("insert into users (email) values ('knowledge-review@example.test') returning id")).rows[0].id);
  const projects = (await pool.query("insert into projects (name, created_by_user_id) values ('Selected', $1), ('Other', $1) returning id", [userId])).rows;
  projectId = Number(projects[0].id);
  const foreignProjectId = Number(projects[1].id);
  await pool.query("insert into project_members (project_id, user_id, role) values ($1, $2, 'owner'), ($3, $2, 'owner')", [projectId, userId, foreignProjectId]);
  await pool.query("insert into user_project_preferences (user_id, selected_project_id) values ($1, $2)", [userId, projectId]);
  const channels = (await pool.query("insert into channels (project_id, user_id, network, tg_chat_id, handle, title) values ($1, $2, 'tg', -999011, 'review_channel', 'Review'), ($3, $2, 'tg', -999012, 'other_channel', 'Other') returning id", [projectId, userId, foreignProjectId])).rows;
  channelId = Number(channels[0].id);
  const sources = (await pool.query("insert into knowledge_sources (user_id, channel_id, kind, title, raw_text) values ($1, $2, 'paste', 'Own', 'Preserve own source'), ($1, $3, 'paste', 'Other', 'Preserve other project') returning id", [userId, channelId, channels[1].id])).rows;
  sourceId = Number(sources[0].id);
  foreignSourceId = Number(sources[1].id);
});
afterAll(async () => pool.end());
beforeEach(async () => {
  vi.clearAllMocks();
  mocks.pool.mockReturnValue(pool);
  mocks.session.mockResolvedValue({ id: userId });
  mocks.enqueue.mockResolvedValue({});
  mocks.fetchPosts.mockResolvedValue({ posts: ["Образец авторского стиля канала, достаточно длинный для индексирования."] });
  await pool.query("update project_members set role = 'owner', status = 'active' where project_id = $1 and user_id = $2", [projectId, userId]);
});

describe("knowledge mutation authorization with PostgreSQL", () => {
  it.each(["add", "read", "extract", "edit", "delete"])("denies publisher %s before writes or external calls", async (action) => {
    await pool.query("update project_members set role = 'publisher' where project_id = $1 and user_id = $2", [projectId, userId]);
    const before = (await pool.query("select id, raw_text from knowledge_sources order by id")).rows;
    const profile = { niche: "Правовая помощь бизнесу", audience: "Предприниматели" };
    const response = action === "add" ? await addKnowledge(request("/api/knowledge", "POST", { channelId, kind: "paste", title: "New", text: "New facts" }))
      : action === "read" ? await readChannel(request("/api/knowledge/read-channel", "POST", { channelId }))
      : action === "extract" ? await extractProfile(request("/api/knowledge/extract-profile", "POST", { channelId }))
      : action === "edit" ? await editProfile(request("/api/knowledge/extract-profile", "PUT", { channelId, profile }))
      : await deleteKnowledge(request(`/api/knowledge?id=${sourceId}`, "DELETE"));
    expect(response.status).toBe(403);
    expect((await pool.query("select id, raw_text from knowledge_sources order by id")).rows).toEqual(before);
    expect(mocks.fetchPosts).not.toHaveBeenCalled();
    expect(mocks.enqueue).not.toHaveBeenCalled();
  });

  it("does not delete an owned source from another selected project", async () => {
    const response = await deleteKnowledge(request(`/api/knowledge?id=${foreignSourceId}`, "DELETE"));
    expect(response.status).toBe(404);
    expect((await pool.query("select id from knowledge_sources where id = $1", [foreignSourceId])).rowCount).toBe(1);
  });

  it("allows an author to add factual knowledge and preserves it when Redis is down", async () => {
    await pool.query("update project_members set role = 'author' where project_id = $1 and user_id = $2", [projectId, userId]);
    mocks.enqueue.mockRejectedValue(new Error("redis_unavailable"));
    const response = await addKnowledge(request("/api/knowledge", "POST", { channelId, kind: "paste", title: "Facts", text: "Verified facts" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect((await pool.query("select status, raw_text, channel_id from knowledge_sources where id = $1", [body.id])).rows[0])
      .toMatchObject({ status: "pending", raw_text: "Verified facts", channel_id: String(channelId) });
  });

  it("rejects malformed channel-import requests instead of importing the default channel", async () => {
    const response = await readChannel(new NextRequest("http://localhost/api/knowledge/read-channel", { method: "POST", headers: { origin: "http://localhost" }, body: "{" }));
    expect(response.status).toBe(400);
    expect(mocks.fetchPosts).not.toHaveBeenCalled();
  });
});
