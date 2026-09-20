import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import pg from "pg";
import IORedis from "ioredis";
import { Queue } from "bullmq";
import { migrate } from "./migrate.mjs";
import { PUBLICATION_HEARTBEAT_KEY } from "../worker/publication-heartbeat.mjs";

const databaseUrl = String(process.env.MIGRATION_TEST_DATABASE_URL || "").trim();
const redisUrl = String(process.env.MIGRATION_TEST_REDIS_URL || "").trim();

function assertDisposableTargets() {
  if (!databaseUrl || !redisUrl) throw new Error("disposable PostgreSQL and Redis URLs are required");
  const database = new URL(databaseUrl);
  const redis = new URL(redisUrl);
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  if (
    !localHosts.has(database.hostname)
    || database.pathname.replace(/^\//u, "") !== "aurora_publication_gate_test"
  ) {
    throw new Error("expected disposable aurora_publication_gate_test database");
  }
  if (!localHosts.has(redis.hostname) || Number(redis.port || 6379) === 6379) {
    throw new Error("expected non-default disposable local Redis port");
  }
}

function waitForExit(child, timeoutMs = 10_000) {
  return new Promise((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker did not stop"));
    }, timeoutMs);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolveExit({ code, signal });
    });
  });
}

async function waitFor(predicate, timeoutMs = 12_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("timed out waiting for isolated worker state");
}

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

async function startAndObserveWorker(queue, redis) {
  let output = "";
  const child = spawn(process.execPath, ["worker.mjs"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      REDIS_URL: redisUrl,
      // Keep this gate isolated from unrelated cron/media/site-analysis work. Those workers
      // have their own tests and can legitimately still be active when this short process exits.
      AURORA_WORKER_MODE: "publication",
      PUBLICATION_OVERDUE_GRACE_MS: "300000",
      TG_BOT_TOKEN: "",
      TG_CHAT_ID: "",
      NAVYAI_API_KEY: "",
      OPENAI_API_KEY: "",
      AI_API_KEY: "",
      ANTHROPIC_API_KEY: "",
      GEMINI_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-4_000); });
  try {
    await waitFor(async () => {
      const [heartbeat, delayed] = await Promise.all([
        redis.get(PUBLICATION_HEARTBEAT_KEY),
        queue.getDelayedCount(),
      ]);
      return heartbeat && delayed === 1;
    });
  } catch (error) {
    child.kill("SIGTERM");
    await waitForExit(child).catch(() => {});
    throw new Error(`${error.message}; worker output: ${output.replace(/\s+/gu, " ").trim()}`);
  }
  child.kill("SIGTERM");
  const stopped = await waitForExit(child);
  assert.equal(stopped.code, 0);
}

assertDisposableTargets();
const schemaSql = await readFile(resolve(process.cwd(), "db/schema.sql"), "utf8");
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 3 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const publishQueue = new Queue("publish", { connection: redis });

try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(schemaSql);
  await migrate({ env: { ...process.env, DATABASE_URL: databaseUrl }, logger: { log() {} } });

  const userId = Number((await pool.query(
    "insert into users (email, name) values ('qa-gate1@example.test', 'QA Gate 1') returning id",
  )).rows[0].id);
  const projectId = await ensurePersonalProject(pool, userId);
  const channels = (await pool.query(
    `insert into channels (project_id, user_id, network, tg_chat_id, title, handle, is_active)
     values ($1, $2, 'tg', -100910000011, 'QA active', 'qa_active', true),
            ($1, $2, 'tg', -100910000012, 'QA inactive RSS', 'qa_inactive', true)
     returning id`,
    [projectId, userId],
  )).rows.map((row) => Number(row.id));
  const [activeChannelId, inactiveRssChannelId] = channels;

  const inserted = await pool.query(
    `insert into posts
       (project_id, user_id, channel_id, text, scheduled_at, status, publication_origin,
        next_attempt_at, verification_state)
     values
       ($1, $2, $3, 'QA overdue manual', now() - interval '2 hours', 'scheduled', 'manual', null, 'unverified'),
       ($1, $2, $3, 'QA overdue autopilot', now() - interval '3 hours', 'scheduled', 'autopilot', null, 'unverified'),
       ($1, $2, $3, 'QA overdue active RSS', now() - interval '4 hours', 'scheduled', 'rss', null, 'unverified'),
       ($1, $2, $4, 'QA overdue inactive RSS', now() - interval '5 hours', 'scheduled', 'rss', null, 'unverified'),
       ($1, $2, $3, 'QA future scheduled', now() + interval '2 hours', 'scheduled', 'manual', null, 'unverified'),
       ($1, $2, $3, 'QA retry clock', now() - interval '1 hour', 'failed_retry', 'retry', now() + interval '1 hour', 'unverified'),
       ($1, $2, $3, 'QA published', now() - interval '1 day', 'published', 'manual', null, 'verified'),
       ($1, $2, $3, 'QA missing', now() - interval '1 day', 'missing', 'manual', null, 'missing')
     returning id, text`,
    [projectId, userId, activeChannelId, inactiveRssChannelId],
  );
  const postIds = new Map(inserted.rows.map((row) => [row.text, Number(row.id)]));

  const activeFeedId = Number((await pool.query(
    `insert into rss_feeds (user_id, channel_id, url, is_active)
     values ($1, $2, 'https://qa.invalid/active.xml', true) returning id`,
    [userId, activeChannelId],
  )).rows[0].id);
  const inactiveFeedId = Number((await pool.query(
    `insert into rss_feeds (user_id, channel_id, url, is_active)
     values ($1, $2, 'https://qa.invalid/inactive.xml', false) returning id`,
    [userId, inactiveRssChannelId],
  )).rows[0].id);
  await pool.query(
    `insert into rss_items (feed_id, guid, post_id, status)
     values ($1, 'qa-active', $2, 'posted'), ($3, 'qa-inactive', $4, 'posted')`,
    [
      activeFeedId,
      postIds.get("QA overdue active RSS"),
      inactiveFeedId,
      postIds.get("QA overdue inactive RSS"),
    ],
  );

  await startAndObserveWorker(publishQueue, redis);
  const firstJobs = await publishQueue.getJobs(["waiting", "active", "delayed", "failed", "completed"]);
  assert.equal(firstJobs.length, 1);
  assert.equal(Number(firstJobs[0].data.postId), postIds.get("QA future scheduled"));

  const states = (await pool.query(
    `select text, status, quarantine_reason, next_attempt_at
       from posts where project_id = $1 and user_id = $2 order by id`,
    [projectId, userId],
  )).rows;
  const byText = new Map(states.map((row) => [row.text, row]));
  for (const text of [
    "QA overdue manual",
    "QA overdue autopilot",
    "QA overdue active RSS",
    "QA overdue inactive RSS",
  ]) {
    assert.equal(byText.get(text).status, "quarantined");
    assert.equal(byText.get(text).quarantine_reason, "overdue_requires_new_schedule");
  }
  assert.equal(byText.get("QA future scheduled").status, "scheduled");
  assert.equal(byText.get("QA retry clock").status, "failed_retry");
  assert(byText.get("QA retry clock").next_attempt_at);
  assert.equal(byText.get("QA published").status, "published");
  assert.equal(byText.get("QA missing").status, "missing");

  await redis.del(PUBLICATION_HEARTBEAT_KEY);
  await startAndObserveWorker(publishQueue, redis);
  const secondJobs = await publishQueue.getJobs(["waiting", "active", "delayed", "failed", "completed"]);
  assert.equal(secondJobs.length, 1, "second reconciliation duplicated the future job");
  assert.equal(Number(secondJobs[0].data.postId), postIds.get("QA future scheduled"));

  console.log(
    "Publication quarantine integration passed: 4 overdue quarantined, 1 future job, 0 early retry/inactive RSS/duplicates.",
  );
} finally {
  await publishQueue.obliterate({ force: true }).catch(() => {});
  await publishQueue.close().catch(() => {});
  redis.disconnect(false);
  await pool.end().catch(() => {});
}
