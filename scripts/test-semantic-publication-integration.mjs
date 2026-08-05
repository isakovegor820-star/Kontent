import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";

import { migrate } from "./migrate.mjs";
import { assessAutopilotDraft } from "../src/lib/autopilot-quality.mjs";
import { normalizePostQuality } from "../src/lib/post-quality.mjs";
import { claimAutopilotPlan, scheduleAutopilotItem } from "../src/lib/autopilot-scheduling.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const redisUrl = String(process.env.MIGRATION_TEST_REDIS_URL || "").trim();

function assertDisposableTargets() {
  if (!databaseUrl || !redisUrl) throw new Error("disposable PostgreSQL and Redis URLs are required");
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (!localHosts.has(database.hostname) || database.pathname.slice(1) !== "aurora_semantic_gate_test") {
    throw new Error("expected disposable aurora_semantic_gate_test database");
  }
  if (!localHosts.has(redis.hostname) || Number(redis.port || 6379) === 6379) {
    throw new Error("expected non-default disposable local Redis port");
  }
}

assertDisposableTargets();
const schemaSql = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const publishQueue = new Queue("publish", { connection: redis });

try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(schemaSql);
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  await publishQueue.obliterate({ force: true }).catch(() => {});

  const userId = Number((await pool.query(
    "insert into users (email, name) values ('qa-gate3@example.test', 'QA Gate 3') returning id",
  )).rows[0].id);
  const channelId = Number((await pool.query(
    `insert into channels (user_id, network, title, handle, is_active)
     values ($1, 'tg', 'QA semantic channel', 'qa_semantic', true) returning id`,
    [userId],
  )).rows[0].id);
  const source = {
    id: "knowledge-446",
    text: "Статья 446 ГПК РФ регулирует исполнительский иммунитет единственного пригодного для постоянного проживания жилья.",
  };
  const text = [
    "Статья 446 ГПК РФ полностью защищает любой бизнес [1].",
    "Она неизменно приводит к предсказуемому решению суда [1].",
    "Суд отказал всем кредиторам [1].",
    "Суд обязан применить её автоматически [1].",
    "Норма полностью снимает имущественные риски для владельца бизнеса [1].",
    "Статья 446 ГПК РФ регулирует исполнительский иммунитет единственного пригодного для постоянного проживания жилья [1].",
  ].join(" ");
  const quality = normalizePostQuality({
    preset: "custom",
    minChars: 300,
    maxChars: 4000,
    hookRequired: false,
    requireConclusion: false,
    maxParagraphSentences: 6,
    factsPolicy: "source_required",
    minCitationShare: 0.5,
    disclaimerRequired: false,
    forbiddenPhrases: [],
    forbiddenTopics: [],
  });
  const result = await assessAutopilotDraft({
    text,
    quality,
    topic: "Исполнительский иммунитет",
    sources: [source],
    citedShare: 1,
    invented: [],
  });
  assert.equal(result.passed, false);
  assert(result.score < 100);
  assert.equal(result.semantic.status, "blocked");
  assert.equal(result.semantic.blockers.length, 5);

  const scheduledAt = new Date(Date.now() + 3_600_000).toISOString();
  const items = [{
    i: 0,
    scheduledAt,
    topic: "Исполнительский иммунитет",
    draft: text,
    status: "pending",
    sources: [source],
    quality: result,
    qualityBlocked: true,
  }];
  const planId = Number((await pool.query(
    `insert into autopilot_plan (user_id, channel_id, week_start, items, status)
     values ($1, $2, current_date, $3::jsonb, 'pending') returning id`,
    [userId, channelId, JSON.stringify(items)],
  )).rows[0].id);
  const operationId = Number((await pool.query(
    `insert into autopilot_approval_operations
       (user_id, channel_id, plan_id, plan_revision, preview_hash,
        idempotency_key, actor_type, status, request_snapshot)
     values ($1, $2, $3, 1, $4, 'qa-semantic-gate', 'web', 'processing', '{}'::jsonb)
     returning id`,
    [userId, channelId, planId, "0".repeat(64)],
  )).rows[0].id);
  const claim = await claimAutopilotPlan(pool, {
    planId,
    userId,
    channelId,
    operationId,
    expectedRevision: 1,
    allowedStatuses: ["pending"],
  });
  assert(claim);
  let enqueueCalls = 0;
  await assert.rejects(
    scheduleAutopilotItem({
      pool,
      enqueue: async (postId, date, scheduleRevision) => {
        enqueueCalls += 1;
        await publishQueue.add("publish", { postId, scheduleRevision }, { delay: Math.max(0, Date.parse(date) - Date.now()) });
      },
      planId,
      userId,
      channelId,
      operationId,
      index: 0,
    }),
    (error) => error?.code === "AUTOPILOT_ITEM_BLOCKED",
  );
  assert.equal(enqueueCalls, 0);
  const counts = (await pool.query(
    `select
       (select count(*)::int from posts where user_id = $1) as posts,
       (select count(*)::int from autopilot_schedule_outbox where user_id = $1) as outbox`,
    [userId],
  )).rows[0];
  assert.deepEqual(counts, { posts: 0, outbox: 0 });
  assert.equal(Object.values(await publishQueue.getJobCounts()).reduce((sum, count) => sum + Number(count), 0), 0);

  console.log(
    "Semantic publication integration passed: five unsupported legal claims blocked with 0 posts/outbox/Redis jobs.",
  );
} finally {
  await publishQueue.obliterate({ force: true }).catch(() => {});
  await publishQueue.close().catch(() => {});
  redis.disconnect(false);
  await pool.end().catch(() => {});
}
