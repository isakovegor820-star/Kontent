import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";

const mock = vi.hoisted(() => ({ pool: vi.fn(), assess: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mock.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }) }));
vi.mock("@/lib/autopilot-quality.mjs", () => ({ assessAutopilotDraft: mock.assess }));
vi.mock("@/lib/autopilot", async (original) => ({ ...await original<typeof import("@/lib/autopilot")>(), enqueueAutopilotPost: mock.enqueue }));
import { POST as openEditor, PATCH as saveEditor } from "@/app/api/autopilot/item/draft/route";
import { PATCH as moveItem } from "@/app/api/autopilot/item/schedule/route";

const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || target.port !== "55437") throw new Error("Isolated local PostgreSQL required");
const admin = new pg.Pool({ connectionString: target.href });
const database = `aurora_editor_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, max: 8, application_name: "editor-isolation-test" });
let actor: number, a: number, b: number, channel: number, plan: number;
const goodQuality = { passed: true, score: 92, threshold: 80, blockers: [], violations: [], publicationDisposition: "ready", semantic: { status: "passed", requiresReview: false } };
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
function request(path: string, method: string, body: unknown, projectId: number | null = a) {
  return new NextRequest(`http://localhost/api/autopilot/item/${path}`, { method,
    headers: { origin: "http://localhost", "content-type": "application/json", "x-test-user": String(actor),
      ...(projectId == null ? {} : { "x-aurora-project-id": String(projectId) }) }, body: JSON.stringify(body) });
}
const open = (projectId: number | null = a) => openEditor(request("draft", "POST", { channelId: channel, planId: plan, planRevision: 1, index: 0 }, projectId));
const move = () => moveItem(request("schedule", "PATCH", { planId: plan, planRevision: 1, index: 0, localDate: tomorrow(), localTime: "15:00" }));
const state = async () => (await pool.query("select items, revision from autopilot_plan where id=$1", [plan])).rows[0];
async function blocked(fragment: string) {
  await vi.waitFor(async () => {
    const rows = (await pool.query(`select pid from pg_stat_activity where application_name='editor-isolation-test'
      and pid<>pg_backend_pid() and state='active' and query like $1 and cardinality(pg_blocking_pids(pid))>0`, [`%${fragment}%`])).rows;
    expect(rows.length).toBeGreaterThan(0);
  }, { timeout: 3000, interval: 15 });
}
beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  vi.clearAllMocks(); mock.pool.mockReturnValue(pool); mock.assess.mockResolvedValue(goodQuality);
  actor = Number((await pool.query("insert into users(email) values($1) returning id", [`editor-${randomUUID()}@example.test`])).rows[0].id);
  [a,b] = (await pool.query("insert into projects(name,created_by_user_id) values('Editor A',$1),('Editor B',$1) returning id", [actor])).rows.map((r) => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')", [a,b,actor]);
  await pool.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [actor,b]);
  channel = Number((await pool.query("insert into channels(user_id,project_id,network,title,tg_chat_id,is_active) values($1,$2,'tg','Editor channel',$3,true) returning id", [actor,a,-1009000000-actor])).rows[0].id);
  plan = Number((await pool.query(`insert into autopilot_plan(user_id,project_id,channel_id,week_start,status,items)
    values($1,$2,$3,current_date,'pending',$4::jsonb) returning id`, [actor,a,channel,JSON.stringify([{ i: 0, draft: "Исходный текст", scheduledAt: new Date(Date.now()+86_400_000).toISOString(), status: "pending" }])])).rows[0].id);
});
afterAll(async () => { await pool.end(); await admin.end(); });

describe.sequential("new Autopilot editor routes through PostgreSQL", () => {
  it("requires the captured project and keeps opening/saving an editor private until approval", async () => {
    expect((await open(null)).status).toBe(428);
    const foreign = await open(b);
    expect(foreign.status).toBe(422);
    expect((await foreign.json()).error).toBe("no_channel");
    expect(Number((await state()).revision)).toBe(1);
    const response = await open();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-aurora-project-id")).toBe(String(a));
    const draftId = (await response.json()).draftId;
    const draft = (await pool.query("update drafts set text='Текст после редактирования',version=version+1 where id=$1 returning version,project_id", [draftId])).rows[0];
    expect(Number(draft.project_id)).toBe(a);
    const saved = await saveEditor(request("draft", "PATCH", { draftId, draftVersion: Number(draft.version) }));
    expect(saved.status).toBe(200);
    expect((await state()).items[0]).toMatchObject({ draft: "Текст после редактирования", editorVersion: Number(draft.version), status: "pending" });
    expect((await pool.query("select id from posts where project_id in ($1,$2)", [a,b])).rows).toEqual([]);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("rechecks membership after quality evaluation before saving the acknowledged editor version", async () => {
    const draftId = (await (await open()).json()).draftId;
    await pool.query("update drafts set text='Changed version',version=version+1 where id=$1", [draftId]);
    const before = await state();
    mock.assess.mockImplementation(async () => {
      await pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
      return goodQuality;
    });
    const response = await saveEditor(request("draft", "PATCH", { draftId, draftVersion: 2 }));
    expect(response.status).toBe(403);
    expect(await state()).toEqual(before);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("rejects an edit or schedule change after a role is reduced to publisher", async () => {
    await pool.query("update project_members set role='publisher' where project_id=$1 and user_id=$2", [a,actor]);
    const before = await state();
    expect((await open()).status).toBe(403);
    expect((await move()).status).toBe(403);
    expect(await state()).toEqual(before);
  });
  it("a revocation holding the membership lock wins before a schedule mutation", async () => {
    const tx = await pool.connect();
    const before = await state();
    await tx.query("begin");
    try {
      await tx.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
      const pending = move();
      await blocked("for share of member, project");
      await tx.query("commit");
      expect((await pending).status).toBe(403);
      expect(await state()).toEqual(before);
    } finally { await tx.query("rollback"); tx.release(); }
  });
  it("a schedule mutation holding membership commits before a concurrent revocation", async () => {
    const tx = await pool.connect();
    await tx.query("begin");
    try {
      await tx.query("select id from autopilot_plan where id=$1 for update", [plan]);
      const pending = move();
      await blocked("select id, revision, channel_id, items from autopilot_plan");
      const revoke = pool.query("update project_members set status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [a,actor]);
      await blocked("update project_members");
      await tx.query("commit");
      expect((await pending).status).toBe(200);
      await revoke;
      expect(Number((await state()).revision)).toBe(2);
      expect((await move()).status).toBe(403);
    } finally { await tx.query("rollback"); tx.release(); }
  });
});
