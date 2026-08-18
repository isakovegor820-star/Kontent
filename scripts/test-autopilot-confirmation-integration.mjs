import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";

import { migrate } from "./migrate.mjs";
import {
  autopilotPlanRevisionHash,
  buildAutopilotApprovalPreview,
  createAutopilotPreviewToken,
  hashAutopilotPreviewToken,
} from "../src/lib/autopilot-approval.mjs";
import { claimAutopilotPlan } from "../src/lib/autopilot-scheduling.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const redisUrl = String(process.env.MIGRATION_TEST_REDIS_URL || "").trim();

function assertDisposableTargets() {
  if (!databaseUrl || !redisUrl) throw new Error("disposable PostgreSQL and Redis URLs are required");
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    !localHosts.has(database.hostname) ||
    database.pathname.replace(/^\//u, "") !== "aurora_autopilot_cas_test"
  ) {
    throw new Error("expected disposable aurora_autopilot_cas_test database");
  }
  if (!localHosts.has(redis.hostname) || Number(redis.port || 6379) === 6379) {
    throw new Error("expected non-default disposable local Redis port");
  }
}

const quality = {
  score: 92,
  threshold: 85,
  passed: true,
  blockers: [],
  violations: [],
  metadata: {
    checkedAt: "2026-08-02T09:30:00.000Z",
    rules: { id: "aurora-post-quality", version: 1, profileVersion: 1 },
    provenance: { kind: "deterministic", validator: "validatePostQuality", trigger: "generation" },
  },
};

const makeItems = (suffix = "original") => [{
  i: 0,
  scheduledAt: new Date(Date.now() + 3_600_000).toISOString(),
  topic: `QA ${suffix}`,
  draft: `Проверенный текст ${suffix}`,
  status: "pending",
  quality,
}];

async function ensurePersonalProject(pool, userId) {
  const result = await pool.query(
    `with selected_project as (
       insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
       values ('QA personal project', 'UTC', $1, $1)
       on conflict (personal_owner_user_id) do update
         set updated_at = projects.updated_at
       returning id
     ), member as (
       insert into project_members (project_id, user_id, role, status)
       select id, $1, 'owner', 'active' from selected_project
       on conflict (project_id, user_id) do update
         set role = 'owner', status = 'active', revoked_at = null, updated_at = now()
     )
     insert into user_project_preferences (user_id, selected_project_id)
     select $1, id from selected_project
     on conflict (user_id) do update set selected_project_id = excluded.selected_project_id
     returning selected_project_id`,
    [userId],
  );
  const projectId = Number(result.rows[0]?.selected_project_id ?? 0);
  assert(Number.isSafeInteger(projectId) && projectId > 0, "personal project fixture was not created");
  return projectId;
}

async function insertPlan(pool, projectId, userId, channelId, items) {
  return Number((await pool.query(
    `insert into autopilot_plan (project_id, user_id, channel_id, week_start, items, status)
     values ($1, $2, $3, current_date, $4::jsonb, 'pending') returning id`,
    [projectId, userId, channelId, JSON.stringify(items)],
  )).rows[0].id);
}

async function insertOperation(pool, projectId, userId, channelId, planId, key, revision, hash) {
  return Number((await pool.query(
    `insert into autopilot_approval_operations
       (project_id, user_id, channel_id, plan_id, plan_revision, preview_hash,
        idempotency_key, actor_type, status, request_snapshot)
     values ($1, $2, $3, $4, $5, $6, $7, 'web', 'processing', '{}'::jsonb)
     returning id`,
    [projectId, userId, channelId, planId, revision, hash, key],
  )).rows[0].id);
}

async function sideEffectCounts(pool, projectId, userId, queue) {
  const db = (await pool.query(
    `select
       (select count(*)::int from posts where project_id = $1 and user_id = $2) as posts,
       (select count(*)::int from autopilot_schedule_outbox
         where project_id = $1 and user_id = $2) as outbox`,
    [projectId, userId],
  )).rows[0];
  return { posts: db.posts, outbox: db.outbox, jobs: await queue.getJobCounts() };
}

assertDisposableTargets();
const schemaSql = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 8 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const publishQueue = new Queue("publish", { connection: redis });

try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(schemaSql);
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  await publishQueue.obliterate({ force: true }).catch(() => {});

  const userId = Number((await pool.query(
    "insert into users (email, name) values ('qa-gate2@example.test', 'QA Gate 2') returning id",
  )).rows[0].id);
  const projectId = await ensurePersonalProject(pool, userId);
  const channels = (await pool.query(
    `insert into channels (project_id, user_id, network, title, handle, is_active)
     values ($1, $2, 'tg', 'QA channel A', 'qa_gate2_a', true),
            ($1, $2, 'tg', 'QA channel B', 'qa_gate2_b', true)
     returning id`,
    [projectId, userId],
  )).rows.map((row) => Number(row.id));
  const [channelA, channelB] = channels;

  for (const mutation of ["draft", "date", "quality"]) {
    const original = makeItems(mutation);
    const planId = await insertPlan(pool, projectId, userId, channelA, original);
    const preview = buildAutopilotApprovalPreview({
      items: original,
      channel: { id: channelA, title: "QA channel A", handle: "qa_gate2_a" },
      planId,
      planRevision: 1,
    });
    const token = createAutopilotPreviewToken();
    await pool.query(
      `insert into autopilot_approval_previews
         (token_hash, project_id, user_id, channel_id, plan_id, plan_revision,
          preview_hash, snapshot, expires_at)
       values ($1, $2, $3, $4, $5, 1, $6, $7::jsonb, now() + interval '5 minutes')`,
      [hashAutopilotPreviewToken(token), projectId, userId, channelA, planId,
        preview.hash, JSON.stringify(preview)],
    );

    const changed = structuredClone(original);
    if (mutation === "draft") changed[0].draft = "Изменённый после preview текст";
    if (mutation === "date") changed[0].scheduledAt = new Date(Date.now() + 7_200_000).toISOString();
    if (mutation === "quality") changed[0].quality = { ...quality, passed: false, blockers: ["QA blocker"] };
    await pool.query(
      `update autopilot_plan set items = $2::jsonb, revision = revision + 1 where id = $1`,
      [planId, JSON.stringify(changed)],
    );

    const current = (await pool.query(
      "select items, revision from autopilot_plan where id = $1",
      [planId],
    )).rows[0];
    assert.equal(Number(current.revision), 2);
    assert.notEqual(
      autopilotPlanRevisionHash({ items: current.items, planId, planRevision: 2, channelId: channelA }),
      preview.hash,
      `${mutation} mutation kept the preview hash`,
    );

    const operationId = await insertOperation(
      pool,
      projectId,
      userId,
      channelA,
      planId,
      `qa-stale-${mutation}`,
      1,
      preview.hash,
    );
    const claim = await claimAutopilotPlan(pool, {
      planId,
      projectId,
      userId,
      channelId: channelA,
      operationId,
      allowedStatuses: ["pending"],
      expectedRevision: 1,
    });
    assert.equal(claim, null, `${mutation} stale preview acquired the plan`);
  }

  const crossChannelPlan = await insertPlan(
    pool,
    projectId,
    userId,
    channelA,
    makeItems("channel isolation"),
  );
  const crossToken = createAutopilotPreviewToken();
  await pool.query(
    `insert into autopilot_approval_previews
       (token_hash, project_id, user_id, channel_id, plan_id, plan_revision,
        preview_hash, snapshot, expires_at)
     values ($1, $2, $3, $4, $5, 1, $6, '{}'::jsonb, now() + interval '5 minutes')`,
    [hashAutopilotPreviewToken(crossToken), projectId, userId, channelA,
      crossChannelPlan, "0".repeat(64)],
  );
  const crossChannelMatch = await pool.query(
    `select token_hash from autopilot_approval_previews
      where token_hash = $1 and project_id = $2 and user_id = $3
        and channel_id = $4 and plan_id = $5`,
    [hashAutopilotPreviewToken(crossToken), projectId, userId, channelB, crossChannelPlan],
  );
  assert.equal(crossChannelMatch.rowCount, 0, "channel B accepted channel A preview token");

  const raceItems = makeItems("parallel");
  const racePlan = await insertPlan(pool, projectId, userId, channelA, raceItems);
  const raceHash = autopilotPlanRevisionHash({
    items: raceItems,
    planId: racePlan,
    planRevision: 1,
    channelId: channelA,
  });
  const operationIds = await Promise.all([
    insertOperation(pool, projectId, userId, channelA, racePlan, "qa-race-a", 1, raceHash),
    insertOperation(pool, projectId, userId, channelA, racePlan, "qa-race-b", 1, raceHash),
  ]);
  const claims = await Promise.all(operationIds.map((operationId) => claimAutopilotPlan(pool, {
    planId: racePlan,
    projectId,
    userId,
    channelId: channelA,
    operationId,
    allowedStatuses: ["pending"],
    expectedRevision: 1,
  })));
  assert.equal(claims.filter(Boolean).length, 1, "parallel confirmations both acquired the plan");

  const duplicateKeyResults = await Promise.all(["a", "b"].map(() => pool.query(
    `insert into autopilot_approval_operations
       (project_id, user_id, channel_id, plan_id, plan_revision, preview_hash,
        idempotency_key, actor_type, status, request_snapshot)
     values ($1, $2, $3, $4, 1, $5, 'project:' || ($1::bigint)::text || ':qa-same-idempotency-key',
             'web', 'processing', '{}'::jsonb)
     on conflict do nothing returning id`,
    [projectId, userId, channelA, crossChannelPlan, "0".repeat(64)],
  )));
  assert.equal(duplicateKeyResults.reduce((sum, result) => sum + Number(result.rowCount), 0), 1);

  const effects = await sideEffectCounts(pool, projectId, userId, publishQueue);
  assert.equal(effects.posts, 0);
  assert.equal(effects.outbox, 0);
  assert.equal(Object.values(effects.jobs).reduce((sum, count) => sum + Number(count), 0), 0);

  console.log(
    "Autopilot confirmation integration passed: draft/date/quality stale CAS, channel isolation, parallel claim, idempotency, 0 posts/outbox/Redis jobs.",
  );
} finally {
  await publishQueue.obliterate({ force: true }).catch(() => {});
  await publishQueue.close().catch(() => {});
  redis.disconnect(false);
  await pool.end().catch(() => {});
}
