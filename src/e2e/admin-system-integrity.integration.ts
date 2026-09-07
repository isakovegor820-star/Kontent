import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import pg, { type PoolClient } from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrate } from "../../scripts/migrate.mjs";
import { PUBLICATION_HEARTBEAT_KEY, serializePublicationHeartbeat } from "../../worker/publication-heartbeat.mjs";
import { countQueueWorkersForDatabase } from "@/lib/queue-worker-availability.mjs";
import { SCHEMA_MANIFEST } from "@/lib/schema-manifest.mjs";

const testDatabaseUrl = String(process.env.SYSTEM_TEST_DATABASE_URL || "").trim();
const target = testDatabaseUrl ? new URL(testDatabaseUrl) : null;
const testRedisUrl = String(process.env.SYSTEM_TEST_REDIS_URL || "").trim();
const redisTarget = testRedisUrl ? new URL(testRedisUrl) : null;
if (!target || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || !["postgres:", "postgresql:"].includes(target.protocol) || target.pathname !== "/aurora_admin_system_test") {
  throw new Error("Requires explicit disposable loopback SYSTEM_TEST_DATABASE_URL for aurora_admin_system_test");
}
if (!redisTarget || !["localhost", "127.0.0.1", "[::1]"].includes(redisTarget.hostname)
  || redisTarget.protocol !== "redis:" || redisTarget.pathname !== "/13") {
  throw new Error("Requires explicit isolated loopback SYSTEM_TEST_REDIS_URL logical database 13");
}
const db = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
const redis = new Redis(testRedisUrl, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500 });
const connection = {
  host: redisTarget.hostname,
  port: Number(redisTarget.port || 6379),
  db: 13,
  username: redisTarget.username ? decodeURIComponent(redisTarget.username) : undefined,
  password: redisTarget.password ? decodeURIComponent(redisTarget.password) : undefined,
  maxRetriesPerRequest: null,
};
let queue: Queue | undefined;
let worker: Worker<unknown, unknown> | undefined;
let initialRedisKeys = new Set<string>();
let ownRedisFixture = false;
let attemptedJobs = 0;
const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: state.query }), getDatabasePoolSnapshot: () => ({ waiting: 0, recentAcquireErrors: 0 }) }));
import { ADMIN_QUEUE_NAMES, loadAdminSystemDiagnostics } from "@/lib/admin-system-diagnostics";

let client: PoolClient;
let userId: number;
let projectId: number;
let channelId: number;
let now = Date.now();
const at = (offsetMs = 0) => new Date(now + offsetMs).toISOString();
const externalFetch = vi.fn(async () => { throw new Error("Unexpected external request from read-only diagnostics"); });

beforeAll(async () => {
  await redis.connect();
  initialRedisKeys = new Set(await redis.keys("*"));
  // The assigned logical DB may retain empty BullMQ metadata from another completed
  // synthetic suite. Preserve it, and refuse any jobs, heartbeat or live consumer.
  const emptyMetadata = new RegExp(`^bull:(${ADMIN_QUEUE_NAMES.join("|")}):(meta|id|events|marker)$`, "u");
  expect([...initialRedisKeys].every(key => emptyMetadata.test(key))).toBe(true);
  ownRedisFixture = true;
  for (const name of ADMIN_QUEUE_NAMES) {
    const probe = new Queue(name, { connection });
    try {
      expect(await countQueueWorkersForDatabase(probe)).toBe(0);
      const counts = await probe.getJobCounts("wait", "active", "delayed", "prioritized", "paused", "waiting-children", "completed", "failed");
      expect(Object.values(counts).every(count => count === 0)).toBe(true);
    } finally { await probe.close(); }
  }
  await db.query("drop schema public cascade");
  await db.query("create schema public");
  await db.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { DATABASE_URL: testDatabaseUrl }, logger: { log() {} } });
  expect(Number((await db.query("select count(*) as count from schema_migrations")).rows[0].count)).toBe(SCHEMA_MANIFEST.migrations.length);
  queue = new Queue("publish", { connection });
  // This is a real registered BullMQ consumer, deliberately idle: no publication
  // callback/provider is imported, and any unexpected job makes the suite fail.
  worker = new Worker<unknown, unknown>("publish", async () => { attemptedJobs += 1; throw new Error("unexpected_fixture_job"); }, { connection });
  await worker.waitUntilReady();
  await vi.waitFor(async () => { expect(await countQueueWorkersForDatabase(queue!)).toBe(1); }, { timeout: 3000 });
});

beforeEach(async () => {
  now = Date.now();
  vi.stubEnv("DATABASE_URL", testDatabaseUrl);
  vi.stubEnv("REDIS_URL", testRedisUrl);
  vi.stubEnv("AI_SERVICE_ENGINE", "local");
  vi.stubEnv("RESEND_API_KEY", "synthetic-config-only-no-request");
  vi.stubEnv("PASSWORD_RESET_FROM", "system-audit@aurora.test");
  vi.stubEnv("APP_URL", "http://localhost:63450"); // Configuration only; no web runtime required.
  vi.stubEnv("TOKENS_MASTER_KEY", "synthetic-test-key-configuration-only");
  vi.stubEnv("TG_BOT_TOKEN", "");
  vi.stubEnv("AURORA_OUTBOUND_DISABLED", "1");
  externalFetch.mockClear();
  vi.stubGlobal("fetch", externalFetch);
  await redis.set(PUBLICATION_HEARTBEAT_KEY, serializePublicationHeartbeat(now), "EX", 30);
  client = await db.connect();
  await client.query("begin");
  let tail: Promise<unknown> = Promise.resolve();
  state.query.mockImplementation((...args: Parameters<PoolClient["query"]>) => {
    const result = tail.then(() => client.query(...args));
    tail = result.catch(() => undefined);
    return result;
  });
  userId = Number((await client.query("insert into users(email,name) values($1,'Standalone system fixture') returning id", [`system-${randomUUID()}@aurora.test`])).rows[0].id);
  projectId = Number((await client.query("insert into projects(name,created_by_user_id) values ('System integrity transaction fixture',$1) returning id", [userId])).rows[0].id);
  await client.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'owner','active')", [projectId, userId]);
  channelId = Number((await client.query("insert into channels(user_id,project_id,network,vk_group_id,title) values($1,$2,'vk',123,'Transaction fixture') returning id", [userId, projectId])).rows[0].id);
});
afterEach(async () => {
  try { if (client) { await client.query("rollback"); client.release(); } }
  finally { vi.unstubAllEnvs(); vi.unstubAllGlobals(); }
  expect(externalFetch).not.toHaveBeenCalled();
  expect(attemptedJobs).toBe(0);
});
afterAll(async () => {
  await worker?.close();
  await queue?.close();
  if (ownRedisFixture) {
    const createdKeys = (await redis.keys("*")).filter(key => !initialRedisKeys.has(key));
    if (createdKeys.length) await redis.del(...createdKeys);
  }
  redis.disconnect();
  await db.end();
});

async function report() { return loadAdminSystemDiagnostics({ now: () => now }); }
async function post(status: string, publishedAt: string | null = null) {
  return Number((await client.query("insert into posts(user_id,channel_id,project_id,status,published_at,provider_started_at) values($1,$2,$3,$4,$5,$6) returning id", [userId, channelId, projectId, status, publishedAt, publishedAt ? new Date(Date.parse(publishedAt) - 2500).toISOString() : null])).rows[0].id);
}
async function event(postId: number, offsetMs: number, eventId = randomUUID()) {
  await client.query(`insert into product_events(event_id,project_id,user_id,section_id,feature_id,action,stage,outcome,error_code,operation_id,occurred_at)
    values($1,$2,$3,'calendar','publication','scheduled','failed','failure','test_provider_timeout',$4,$5) on conflict do nothing`, [eventId, projectId, userId, `post:${postId}`, at(offsetMs)]);
}

describe.sequential("admin system SQL on the actual schema (transactional synthetic fixtures)", () => {
  it("runs publication SQL without inventing posts.updated_at and reports absent outcomes honestly", async () => {
    const result = await report();
    const publication = result.components.find(c => c.id === "publication_worker")!;
    expect(publication.safeErrorCode).not.toBe("publication_worker_check_failed");
    expect(publication.metrics).toMatchObject({ successes: 0, failures: 0, averageDurationMs: null });
    expect(publication.state).toBe("unobserved");
    expect(publication.metrics?.heartbeatAgeMs).toBe(0);
    expect(publication.queues?.[0]).toMatchObject({ name: "publish", workers: 1, state: "unobserved", waiting: 0, active: 0, completed: 0 });
    // A registered consumer/heartbeat cannot prove delivery or missing processors.
    expect(result.components.find(c => c.id === "background_workers")).toMatchObject({ state: "degraded", safeErrorCode: "cron_schedule_missing_or_changed" });
    expect(result.components.find(c => c.id === "database_schema")).toMatchObject({ state: "healthy" });
    expect(result.components.find(c => c.id === "mail_delivery")?.state).toBe("unobserved");
  });
  it("uses exact time boundaries, preserves failed records and keeps event history after recovery", async () => {
    const recovered = await post("published", at(-1000));
    await post("published", at(-86_400_000));
    await post("published", at(-86_400_001));
    await post("failed");
    const id = randomUUID();
    await event(recovered, -120_000, id);
    await event(recovered, -120_000, id); // ingestion duplicate is one journal event
    await event(recovered, -60_000);
    await event(recovered, -86_400_001); // outside the half-open historical window
    const result = await report();
    const publication = result.components.find(c => c.id === "publication_worker")!;
    expect(publication.metrics).toMatchObject({ successes: 2, failures: 1, averageDurationMs: 2500 });
    expect(publication.history).toEqual([{ code: "test_provider_timeout", count: 2, firstSeenAt: at(-120_000), lastSeenAt: at(-60_000), affectedRecords: 0, examples: [`post:${recovered}`] }]);
    expect(publication.state).toBe("degraded");
    expect(publication.safeErrorCode).toBe("publication_failed_records");
  });
  it("detects a current partial AI failure even when another route succeeded, then recovers without deleting history", async () => {
    async function attempt(provider: string, outcome: string, offset: number) {
      await client.query(`insert into ai_provider_attempts(user_id,logical_operation_id,phase,attempt_index,provider,model,input_tokens,output_tokens,usage_estimated,latency_ms,outcome,safe_error_code,request_correlation_id,created_at)
        values($1,$2,'draft',1,$3,'fixture',1,1,false,100,$4,$5,$6,$7)`, [userId, randomUUID(), provider, outcome, outcome === "failed" ? "test_provider_timeout" : null, randomUUID(), at(offset)]);
    }
    await attempt("route-a", "succeeded", -120_000);
    await attempt("route-b", "failed", -60_000);
    const failed = (await report()).components.find(c => c.id === "aurora_ai")!;
    expect(failed.state).toBe("degraded");
    expect(failed.metrics).toMatchObject({ recentSuccesses: 1, recentFailures: 1 });
    await attempt("route-b", "succeeded", -1000);
    const recovered = (await report()).components.find(c => c.id === "aurora_ai")!;
    expect(recovered.state).toBe("healthy");
    expect(recovered.metrics).toMatchObject({ recentSuccesses: 2, recentFailures: 1 });
  });
});
