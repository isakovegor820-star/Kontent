import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { migrate } from "../../scripts/migrate.mjs";
import { ensureDraftEditorialBootstrap } from "../../worker/draft-editorial-bootstrap.mjs";
import { scheduleBotDraftPublication } from "../../worker/bot-draft-publication.mjs";
import { submitBotDraftReview, decideBotApproval } from "../../worker/bot-editorial.mjs";
import { claimAutopilotPlan, scheduleAutopilotItem } from "@/lib/autopilot-scheduling.mjs";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";

const mocks = vi.hoisted(() => ({ user: vi.fn(), pool: vi.fn(), enqueue: vi.fn() }));
vi.mock("@/lib/session", () => ({ getSessionUser: mocks.user }));
vi.mock("@/lib/db", () => ({ getPool: mocks.pool }));
vi.mock("@/lib/queue", () => ({ getPublishQueue: () => ({ add: mocks.enqueue }), jobIdForPostRevision: (id: number) => `post-${id}` }));
vi.mock("@/lib/readiness-probes", () => ({ probeRedisAndPublicationWorker: async () => ({ redis: "up", publicationWorker: "up" }) }));
import { POST as legacyPublish } from "@/app/api/posts/create/route";

const databaseUrl = String(process.env.DATABASE_URL || "");
const target = new URL(databaseUrl);
if (target.hostname !== "127.0.0.1" || target.pathname !== "/aurora_launch_test") {
  throw new Error("Bot publication integration requires disposable local aurora_launch_test");
}
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
let owner: number;
let publisher: number;
let projectId: number;
let channelId: number;
let draftId: number;
let token: string;
let revision: Awaited<ReturnType<typeof ensureDraftEditorialBootstrap>>;
const enqueue = vi.fn();
const passedQuality = {
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  semantic: {
    version: 1,
    status: "passed",
    passed: true,
    requiresReview: false,
    blockers: [],
    claimVerdicts: [{
      claimId: "claim-1", claim: "Проверенный текст", verdict: "supported",
      reasonCode: "entailed_by_source", riskCodes: [],
      sourceSpans: [{ sourceId: "qa-source", start: 0, end: 20 }],
    }],
    provenance: {
      validatorVersion: "semantic-publication-v1",
      checkedAt: "2026-08-02T09:30:00.000Z",
      provider: "qa-nli-v1",
      model: "qa-entailment-v1",
      sourceIds: ["qa-source"],
      rejectedSourceSpans: [],
      terminalVerdict: "passed",
    },
  },
  metadata: {
    checkedAt: "2026-08-02T09:30:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: {
      kind: "deterministic",
      validator: "validatePostQuality",
      trigger: "generation",
      humanAttestation: null,
    },
  },
};

beforeAll(async () => {
  await pool.query("drop schema public cascade; create schema public");
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: databaseUrl }, logger: { log() {} } });
  [owner, publisher] = (await pool.query(`insert into users(email,name)
    values('owner@bot-publication.test','Owner'),('publisher@bot-publication.test','Publisher') returning id`))
    .rows.map((row) => Number(row.id));
});
beforeEach(async () => {
  vi.clearAllMocks();
  enqueue.mockResolvedValue(undefined);
  mocks.pool.mockReturnValue(pool);
  mocks.user.mockResolvedValue({ id: owner });
  mocks.enqueue.mockResolvedValue({ id: "fake-publish" });
  await pool.query("update projects set personal_owner_user_id=null where personal_owner_user_id=$1", [owner]);
  await pool.query("delete from bot_conversations where user_id=any($1::bigint[])", [[owner,publisher]]);
  projectId = Number((await pool.query(
    "insert into projects(name,created_by_user_id,personal_owner_user_id,timezone) values('Bot QA',$1,$1,'Europe/Moscow') returning id", [owner],
  )).rows[0].id);
  await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner'),($1,$3,'publisher')", [projectId,owner,publisher]);
  await pool.query(`insert into user_project_preferences(user_id,selected_project_id) values($1,$2),($3,$2)
    on conflict(user_id) do update set selected_project_id=excluded.selected_project_id`, [owner,projectId,publisher]);
  channelId = Number((await pool.query(`insert into channels(project_id,user_id,network,tg_chat_id,title)
    values($1,$2,'tg',$3,'Bot QA') returning id`, [projectId,owner,-1008800000-projectId])).rows[0].id);
  draftId = Number((await pool.query(`insert into drafts(project_id,user_id,text,origin,purpose,client_key)
    values($1,$2,'The text shown in the bot preview','manual','publishable',$3) returning id`, [projectId,owner,crypto.randomUUID()])).rows[0].id);
  await pool.query("insert into draft_destinations(draft_id,channel_id) values($1,$2)", [draftId,channelId]);
  revision = await ensureDraftEditorialBootstrap(pool, { projectId, actorUserId: owner, draftId });
  token = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  await pool.query(`insert into bot_conversations(project_id,user_id,channel_id,draft_id,state,token,data,expires_at)
    values($1,$2,$3,$4,'preview',$5,$6::jsonb,now()+interval '1 hour')`,
  [projectId,owner,channelId,draftId,token,JSON.stringify({ draftVersion: 1, revisionId: revision.revisionId, contentHash: revision.contentHash })]);
});
afterAll(async () => { await pool.end(); });

const publish = (actor = owner) => scheduleBotDraftPublication({ pool, userId: actor, action: "hour", token, enqueue });
async function posts() { return (await pool.query("select * from posts where project_id=$1 order by id", [projectId])).rows; }
async function team() { await pool.query("update projects set personal_owner_user_id=null where id=$1", [projectId]); }
async function approve() {
  const request = await submitBotDraftReview(pool, { projectId, userId: owner, draftId });
  await decideBotApproval(pool, { projectId, userId: owner, requestId: request.requestId, decision: "approve" });
}

describe.sequential("exact bot publication decision and durable dispatch", () => {
  it("keeps the personal owner's single-click workflow and freezes its approval", async () => {
    const result = await publish();
    expect(result.replayed).toBe(false);
    const rows = await posts();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ text: "The text shown in the bot preview", publication_origin: "manual", status: "scheduled" });
    const operation = (await pool.query("select * from publication_operations where id=$1", [result.operationId])).rows[0];
    expect(Number(operation.approved_revision_id)).toBe(revision.revisionId);
    expect(operation.approved_content_hash).toBe(revision.contentHash);
    expect(Number((await pool.query("select count(*)::int as n from publication_parts where post_id=$1", [result.postId])).rows[0].n)).toBeGreaterThan(0);
    expect(enqueue).toHaveBeenCalledOnce();
  });
  it("rejects a draft edited after the preview", async () => {
    await pool.query("update drafts set text='Unseen edit',version=version+1 where id=$1", [draftId]);
    await expect(publish()).rejects.toMatchObject({ code: "preview_changed" });
    expect(await posts()).toHaveLength(0);
  });
  it("rejects changed preview hashes and legacy previews without a content identity", async () => {
    await pool.query("update bot_conversations set data=data-'contentHash' where user_id=$1 and token=$2", [owner,token]);
    await expect(publish()).rejects.toMatchObject({ code: "preview_changed" });
    expect(await posts()).toHaveLength(0);
  });
  it("requires team approval even for an owner", async () => {
    await team();
    await expect(publish()).rejects.toMatchObject({ code: "approval_required" });
    expect(await posts()).toHaveLength(0);
  });
  it("allows a team publisher to schedule an already approved exact version", async () => {
    await team(); await approve();
    await pool.query("update bot_conversations set user_id=$1 where user_id=$2 and token=$3", [publisher,owner,token]);
    expect((await publish(publisher)).postId).toBeGreaterThan(0);
    expect(await posts()).toHaveLength(1);
  });
  it("denies a publisher's arbitrary draft without creating approval", async () => {
    await team();
    await pool.query("update bot_conversations set user_id=$1 where user_id=$2 and token=$3", [publisher,owner,token]);
    await expect(publish(publisher)).rejects.toMatchObject({ code: "approval_required" });
    expect(await posts()).toHaveLength(0);
  });
  it("applies revoked membership and a downgrade before mutation", async () => {
    await pool.query("update project_members set role='author' where project_id=$1 and user_id=$2", [projectId,owner]);
    await expect(publish()).rejects.toMatchObject({ code: "publication_permission_denied" });
    await pool.query("update project_members set role='owner',status='revoked',revoked_at=now() where project_id=$1 and user_id=$2", [projectId,owner]);
    await expect(publish()).rejects.toMatchObject({ code: "publication_permission_denied" });
    expect(await posts()).toHaveLength(0);
  });
  it("does not retarget the captured project after another device switches selection", async () => {
    const otherProject = Number((await pool.query("insert into projects(name,created_by_user_id) values('Other device',$1) returning id", [owner])).rows[0].id);
    await pool.query("insert into project_members(project_id,user_id,role) values($1,$2,'owner')", [otherProject,owner]);
    await pool.query("update user_project_preferences set selected_project_id=$2 where user_id=$1", [owner,otherProject]);
    expect((await publish()).projectId).toBe(projectId);
  });
  it("commits one operation for simultaneous duplicate clicks", async () => {
    const results = await Promise.all([publish(),publish()]);
    expect(results.filter((result) => result.replayed)).toHaveLength(1);
    expect(await posts()).toHaveLength(1);
    expect(Number((await pool.query("select count(*)::int as n from publication_operations where project_id=$1", [projectId])).rows[0].n)).toBe(1);
  });
  it("keeps accepted intent when Redis fails and recovers the same post through outbox", async () => {
    enqueue.mockRejectedValue(new Error("fake Redis down after commit"));
    const result = await publish();
    expect(result.queuePending).toBe(true);
    expect(await posts()).toHaveLength(1);
    expect((await publish()).replayed).toBe(true);
    enqueue.mockResolvedValue(undefined);
    await pool.query("update publication_outbox set next_attempt_at=now()-interval '1 second' where operation_id=$1", [result.operationId]);
    await reconcilePublicationOutbox({ pool, operationId: result.operationId, enqueue });
    const outbox = (await pool.query("select * from publication_outbox where operation_id=$1", [result.operationId])).rows[0];
    expect(outbox.status).toBe("enqueued");
    expect(Number(outbox.post_id)).toBe(result.postId);
    expect(await posts()).toHaveLength(1);
  });
  it("keeps frozen text after later edits", async () => {
    const result = await publish();
    await pool.query("update drafts set text='Later edit',version=version+1 where id=$1", [draftId]);
    expect((await posts())[0].text).toBe("The text shown in the bot preview");
    expect((await publish()).postId).toBe(result.postId);
  });
  it("lets a publisher confirm a colleague's Autopilot item and checks membership again before each post", async () => {
    const item = { i: 0, draft: "Проверенный текст", status: "pending", topic: "Тема",
      scheduledAt: new Date(Date.now()+3600000).toISOString(), quality: passedQuality };
    const planId = Number((await pool.query(`insert into autopilot_plan(project_id,user_id,channel_id,week_start,items,status)
      values($1,$2,$3,current_date,$4::jsonb,'pending') returning id`, [projectId,owner,channelId,JSON.stringify([item])])).rows[0].id);
    const operationId = Number((await pool.query(`insert into autopilot_approval_operations
      (project_id,user_id,channel_id,plan_id,plan_revision,preview_hash,idempotency_key,actor_type,status,request_snapshot)
      values($1,$2,$3,$4,1,$5,$6,'bot','processing',$7::jsonb) returning id`,
    [projectId,publisher,channelId,planId,"a".repeat(64),crypto.randomUUID(),JSON.stringify({items:[item]})])).rows[0].id);
    expect(await claimAutopilotPlan(pool,{projectId,userId:publisher,channelId,planId,operationId,expectedRevision:1})).not.toBeNull();
    const input = { pool, enqueue, projectId, userId:publisher, channelId, planId, operationId, index:0 };
    const result = await scheduleAutopilotItem(input);
    expect(result.postId).toBeGreaterThan(0);
    expect(await posts()).toHaveLength(1);
    await pool.query("update project_members set role='approver' where project_id=$1 and user_id=$2", [projectId,publisher]);
    await expect(scheduleAutopilotItem(input)).rejects.toMatchObject({code:"AUTOPILOT_APPROVAL_LEASE_LOST"});
    expect(await posts()).toHaveLength(1);
  });
  it.each(["manual", "rss", "autopilot"])("rejects the legacy API with forged %s origin and no approval", async (origin) => {
    mocks.user.mockResolvedValue({ id: publisher });
    const response = await legacyPublish(new NextRequest("http://localhost/api/posts/create", {
      method: "POST", headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({ channelId, text: "Unapproved arbitrary text", origin, scheduledAt: new Date(Date.now()+3600000).toISOString() }),
    }));
    expect(response.status).toBe(410);
    expect(await posts()).toHaveLength(0);
  });
});
