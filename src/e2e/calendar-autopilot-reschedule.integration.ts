import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Queue, Worker } from "bullmq";
import { NextRequest } from "next/server";
import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import { autopilotEditorPostHash } from "@/lib/autopilot-editor-payload.mjs";
import { reconcileAutopilotScheduleOutbox } from "@/lib/autopilot-scheduling.mjs";
import { claimPublicationLease, beginProviderCall } from "../../worker/publication-lease.mjs";

const mock = vi.hoisted(() => ({ pool: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: mock.pool }));
vi.mock("@/lib/session", () => ({ getSessionUser: async (req: NextRequest) => ({ id: Number(req.headers.get("x-test-user")) }) }));
vi.mock("@/lib/autopilot", async original => ({ ...await original<typeof import("@/lib/autopilot")>(), enqueueAutopilotPost: mock.enqueue }));
import { PATCH } from "@/app/api/autopilot/item/schedule/route";
import { GET } from "@/app/api/posts/route";
import { POST as openEditor } from "@/app/api/autopilot/item/draft/route";

const target = new URL(String(process.env.DATABASE_URL));
if (target.hostname !== "127.0.0.1" || target.port !== "55437") throw new Error("Isolated local PostgreSQL required");
const admin = new pg.Pool({ connectionString: target.href });
const database = `aurora_calendar_${randomUUID().replaceAll("-", "")}`;
target.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: target.href, max: 8, application_name: "calendar-move-test" });
let actor: number, project: number, foreign: number, channel: number, plan: number, post: number;
const scheduled = "2030-04-10T10:00:00.000Z";
const moveInput = { localDate: "2030-04-11", localTime: "12:00", timezone: "Europe/Amsterdam", disambiguation: "reject" };
function request(method: string, body?: unknown, projectId = project) {
  return new NextRequest(`http://localhost/api/${method === "GET" ? `posts?id=${post}` : "autopilot/item/schedule"}`, {
    method, headers: { origin: "http://localhost", "content-type": "application/json", "x-test-user": String(actor), "x-aurora-project-id": String(projectId) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
const move = (extra = {}, projectId = project) => PATCH(request("PATCH", { postId: post, scheduleRevision: 1, ...moveInput, ...extra }, projectId));
const postRow = async () => { const row = (await pool.query("select * from posts where id=$1", [post])).rows[0]; return { ...row, schedule_revision: Number(row.schedule_revision) }; };
const planRow = async () => (await pool.query("select * from autopilot_plan where id=$1", [plan])).rows[0];
async function waitForBlockedMutation() {
  await vi.waitFor(async () => {
    const result = await pool.query(`select pid from pg_stat_activity where application_name='calendar-move-test'
      and pid<>pg_backend_pid() and state='active' and cardinality(pg_blocking_pids(pid))>0`);
    expect(result.rows.length).toBeGreaterThan(0);
  }, { timeout: 3000 });
}

beforeAll(async () => {
  await admin.query(`create database ${database}`);
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
});
beforeEach(async () => {
  vi.clearAllMocks(); mock.pool.mockReturnValue(pool); mock.enqueue.mockResolvedValue(undefined);
  actor = Number((await pool.query("insert into users(email) values($1) returning id", [`calendar-${randomUUID()}@example.test`])).rows[0].id);
  [project, foreign] = (await pool.query("insert into projects(name,created_by_user_id) values('Calendar',$1),('Other',$1) returning id", [actor])).rows.map(r => Number(r.id));
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$3,'owner'),($2,$3,'owner')", [project, foreign, actor]);
  channel = Number((await pool.query("insert into channels(user_id,project_id,network,title,tg_chat_id,is_active) values($1,$2,'tg','Calendar test',$3,true) returning id", [actor, project, -1009000000-actor])).rows[0].id);
  post = Number((await pool.query(`insert into posts(user_id,project_id,channel_id,text,status,scheduled_at,scheduled_timezone,publication_origin)
    values($1,$2,$3,'Keep this text','scheduled',$4,'UTC','autopilot') returning id`, [actor, project, channel, scheduled])).rows[0].id);
  plan = Number((await pool.query(`insert into autopilot_plan(user_id,project_id,channel_id,week_start,status,items)
    values($1,$2,$3,current_date,'approved',$4::jsonb) returning id`, [actor, project, channel, JSON.stringify([{ i: 0, status: "approved", postId: post, scheduledAt: scheduled, draft: "Keep this text" }])])).rows[0].id);
  await pool.query(`insert into autopilot_schedule_outbox(plan_id,item_index,user_id,project_id,channel_id,post_id,scheduled_at,status)
    values($1,0,$2,$3,$4,$5,$6,'enqueued')`, [plan, actor, project, channel, post, scheduled]);
});
afterAll(async () => { await pool.end(); await admin.query(`drop database ${database}`); await admin.end(); });

describe.sequential("Autopilot calendar dates through PostgreSQL and Redis", () => {
  it("advertises and persists a move of the same post, including a completed older plan", async () => {
    await pool.query("update autopilot_plan set status='done' where id=$1", [plan]);
    const read = await GET(request("GET"));
    expect((await read.json()).posts[0]).toMatchObject({ id: post, schedule_revision: 1, autopilot_can_reschedule: true });
    const response = await move();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, postId: post, scheduleRevision: 2, scheduledAt: "2030-04-11T10:00:00.000Z", timezone: "Europe/Amsterdam", queuePending: false });
    expect(await postRow()).toMatchObject({ text: "Keep this text", schedule_revision: 2, scheduled_timezone: "Europe/Amsterdam", publication_operation_id: null });
    expect((await planRow()).items[0].scheduledAt).toBe("2030-04-11T10:00:00.000Z");
    const outbox = (await pool.query("select scheduled_at,status from autopilot_schedule_outbox where post_id=$1", [post])).rows[0];
    expect(outbox.scheduled_at.toISOString()).toBe("2030-04-11T10:00:00.000Z");
    expect(outbox.status).toBe("pending");
    expect(mock.enqueue).toHaveBeenCalledWith(project, post, "2030-04-11T10:00:00.000Z", 2);
    expect((await pool.query("select count(*)::int as n from posts where project_id=$1", [project])).rows[0].n).toBe(1);
  });
  it("requires publishing permission for a post while preserving edit permission for an unscheduled plan", async () => {
    await pool.query("update project_members set role='author' where project_id=$1", [project]);
    expect((await move()).status).toBe(403);
    await pool.query("update project_members set role='publisher' where project_id=$1", [project]);
    expect((await PATCH(request("PATCH", { planId: plan, planRevision: 1, index: 0, ...moveInput }))).status).toBe(403);
    expect((await move()).status).toBe(200);
  });
  it("rejects a different project and an absent or cancelled outbox link", async () => {
    expect((await move({}, foreign)).status).toBe(409);
    await pool.query("update autopilot_schedule_outbox set status='cancelled' where post_id=$1", [post]);
    expect((await move()).status).toBe(409);
    expect((await (await GET(request("GET"))).json()).posts[0].autopilot_can_reschedule).toBe(false);
    expect((await postRow()).schedule_revision).toBe(1);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("lets only one concurrent request change a schedule revision", async () => {
    const responses = await Promise.all([move(), move({ localDate: "2030-04-12" })]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
    expect((await postRow()).schedule_revision).toBe(2);
    expect(mock.enqueue).toHaveBeenCalledTimes(1);
    expect((await move()).status).toBe(409);
  });
  it("rolls back the post if a plan-based move finds a cancelled outbox", async () => {
    await pool.query("update autopilot_schedule_outbox set status='cancelled' where post_id=$1", [post]);
    const response = await PATCH(request("PATCH", { planId: plan, planRevision: 1, index: 0, ...moveInput }));
    expect(response.status).toBe(409);
    expect((await postRow()).scheduled_at.toISOString()).toBe(scheduled);
    expect((await postRow()).schedule_revision).toBe(1);
    expect(Number((await planRow()).revision)).toBe(1);
    expect(mock.enqueue).not.toHaveBeenCalled();
  });
  it("does not race past a worker that has already claimed the publication", async () => {
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await tx.query("update posts set scheduled_at=now() where id=$1", [post]);
      expect(await claimPublicationLease(tx as never, { postId: post, projectId: project, scheduleRevision: 1, leaseToken: randomUUID(), overdueCutoff: new Date(Date.now()-60_000) })).not.toBeNull();
      const pending = move();
      await waitForBlockedMutation();
      await tx.query("commit");
      expect((await pending).status).toBe(409);
      expect((await postRow()).status).toBe("publishing");
      expect(mock.enqueue).not.toHaveBeenCalled();
    } finally { await tx.query("rollback"); tx.release(); }
  });
  it("honors a concurrent publisher membership revocation", async () => {
    await pool.query("update project_members set role='publisher' where project_id=$1", [project]);
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await tx.query("update project_members set status='revoked',revoked_at=now() where project_id=$1", [project]);
      const pending = move();
      await waitForBlockedMutation();
      await tx.query("commit");
      expect((await pending).status).toBe(403);
      expect((await postRow()).schedule_revision).toBe(1);
      expect(mock.enqueue).not.toHaveBeenCalled();
    } finally { await tx.query("rollback"); tx.release(); }
  });
  it.each(["publishing", "published", "cancelled"])("does not move a %s post", async status => {
    await pool.query("update posts set status=$2 where id=$1", [post, status]);
    expect((await move()).status).toBe(409);
    expect((await postRow()).schedule_revision).toBe(1);
  });
  it("rejects already sent parts even when the post still says scheduled", async () => {
    await pool.query("insert into publication_parts(post_id,part_index,part_type,payload_html,payload_hash,entity_length,send_status,external_message_id) values($1,0,'text','text',repeat('a',64),4,'sent','123')", [post]);
    expect((await move()).status).toBe(409);
    expect((await postRow()).schedule_revision).toBe(1);
  });
  it("validates time zones, future time and DST without changing data on failure", async () => {
    for (const extra of [{ localDate: "2020-01-01" }, { timezone: "Invalid/Zone" }, { localDate: "2030-03-31", localTime: "02:30" }, { localDate: "2030-10-27", localTime: "02:30" }]) {
      expect((await move(extra)).status).toBe(422);
    }
    expect((await postRow()).schedule_revision).toBe(1);
    const result = await move({ localDate: "2030-10-27", localTime: "02:30", disambiguation: "later", offset: "+01:00" });
    expect(await result.json()).toMatchObject({ ok: true, scheduledAt: "2030-10-27T01:30:00.000Z", disambiguation: "later" });
  });
  it("keeps unsynchronized editor content and its version unchanged", async () => {
    const draft = Number((await pool.query("insert into drafts(user_id,project_id,text,scheduled_at,client_key) values($1,$2,'Unsaved editor work',$3,'calendar-test') returning id", [actor, project, scheduled])).rows[0].id);
    const item = (await planRow()).items[0];
    await pool.query("update autopilot_plan set items=$2 where id=$1", [plan, JSON.stringify([{ ...item, draftId: draft, editorPostHash: autopilotEditorPostHash(await postRow()) }])]);
    expect((await move()).status).toBe(200);
    const current = (await pool.query("select text,version,scheduled_at from drafts where id=$1", [draft])).rows[0];
    expect(current.text).toBe("Unsaved editor work");
    expect(Number(current.version)).toBe(1);
    expect(current.scheduled_at.toISOString()).toBe(scheduled);
    expect((await planRow()).items[0].editorPostHash).toBeUndefined();
  });
  it("updates a synchronized editor schedule, version and conflict hash", async () => {
    const draft = Number((await pool.query("insert into drafts(user_id,project_id,text,scheduled_at,client_key) values($1,$2,'Keep this text',$3,'calendar-test') returning id", [actor, project, scheduled])).rows[0].id);
    const item = (await planRow()).items[0];
    await pool.query("update autopilot_plan set items=$2 where id=$1", [plan, JSON.stringify([{ ...item, draftId: draft, editorVersion: 1, editorPostHash: autopilotEditorPostHash(await postRow()) }])]);
    expect((await move()).status).toBe(200);
    const current = (await pool.query("select version,scheduled_at from drafts where id=$1", [draft])).rows[0];
    expect(Number(current.version)).toBe(2);
    expect(current.scheduled_at.toISOString()).toBe("2030-04-11T10:00:00.000Z");
    expect((await planRow()).items[0]).toMatchObject({ editorVersion: 2, editorPostHash: autopilotEditorPostHash(await postRow()) });
    const opened = await openEditor(request("POST", { postId: post, channelId: channel }));
    expect(opened.status).toBe(200);
    expect(await opened.json()).toMatchObject({ draftId: draft, postId: post });
  });
  it("recovers through Redis and prevents old or duplicated jobs from sending", async () => {
    mock.enqueue.mockRejectedValueOnce(new Error("Redis unavailable"));
    expect(await (await move()).json()).toMatchObject({ ok: true, queuePending: true, scheduleRevision: 2 });
    const name = `calendar-drag-${randomUUID()}`;
    const connection = { host: "127.0.0.1", port: 56437, maxRetriesPerRequest: null };
    const queue = new Queue(name, { connection });
    let worker: Worker | undefined;
    try {
      const enqueue = async (projectId: number, postId: number, _date: string, scheduleRevision = 1) => {
        if (postId === post) await queue.add("publish", { projectId, postId, scheduleRevision }, { jobId: `post-${postId}-r${scheduleRevision}` });
      };
      await enqueue(project, post, scheduled, 1);
      await reconcileAutopilotScheduleOutbox({ pool, enqueue });
      await reconcileAutopilotScheduleOutbox({ pool, enqueue });
      expect((await queue.getJobs(["waiting"]))).toHaveLength(2);
      // Advance this isolated fixture to its due instant without waiting four years.
      await pool.query("update posts set scheduled_at=now() where id=$1", [post]);
      const deliveries: number[] = [];
      worker = new Worker(name, async job => {
        const leaseToken = randomUUID();
        const claim = await claimPublicationLease(pool as never, { ...job.data, leaseToken, overdueCutoff: new Date(Date.now() - 60_000) });
        if (!claim || !await beginProviderCall(pool as never, { ...job.data, leaseToken })) return;
        deliveries.push(job.data.postId); // Isolated fake provider: no external request.
        await pool.query("update posts set status='published' where id=$1", [job.data.postId]);
      }, { connection, concurrency: 2 });
      await vi.waitFor(async () => expect(await queue.getCompletedCount()).toBe(2), { timeout: 5000 });
      expect(deliveries).toEqual([post]);
      expect((await postRow()).status).toBe("published");
    } finally {
      await worker?.close();
      await queue.obliterate({ force: true });
      await queue.close();
    }
  });
});
