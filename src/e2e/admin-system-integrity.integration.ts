import { randomUUID } from "node:crypto";
import pg, { type PoolClient } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testDatabaseUrl = process.env.SYSTEM_TEST_DATABASE_URL || "";
const target = new URL(testDatabaseUrl);
if (target.hostname !== "127.0.0.1" || target.port !== "57641" || !["/aurora_system_test", "/aurora_system_release_test"].includes(target.pathname)) {
  throw new Error("Requires the dedicated loopback aurora_system_test database on port 57641");
}
const db = new pg.Pool({ connectionString: testDatabaseUrl, max: 1 });
const state = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: state.query }), getDatabasePoolSnapshot: () => ({ waiting: 0, recentAcquireErrors: 0 }) }));
import { loadAdminSystemDiagnostics } from "@/lib/admin-system-diagnostics";

let client: PoolClient;
let projectId: number;
let channelId: number;
const now = Date.now();
const at = (offsetMs = 0) => new Date(now + offsetMs).toISOString();

beforeEach(async () => {
  vi.stubEnv("DATABASE_URL", testDatabaseUrl);
  vi.stubEnv("REDIS_URL", "redis://127.0.0.1:57642/0");
  vi.stubEnv("AI_SERVICE_ENGINE", "local");
  vi.stubEnv("RESEND_API_KEY", "synthetic-config-only-no-request");
  vi.stubEnv("PASSWORD_RESET_FROM", "system-audit@aurora.test");
  vi.stubEnv("APP_URL", "http://localhost:63450");
  vi.stubEnv("TOKENS_MASTER_KEY", "synthetic-test-key-configuration-only");
  vi.stubEnv("TG_BOT_TOKEN", "");
  client = await db.connect();
  await client.query("begin");
  let tail: Promise<unknown> = Promise.resolve();
  state.query.mockImplementation((...args: Parameters<PoolClient["query"]>) => {
    const result = tail.then(() => client.query(...args));
    tail = result.catch(() => undefined);
    return result;
  });
  projectId = Number((await client.query("insert into projects(name,created_by_user_id) values ('System integrity transaction fixture',1) returning id")).rows[0].id);
  await client.query("insert into project_members(project_id,user_id,role,status) values($1,1,'owner','active')", [projectId]);
  channelId = Number((await client.query("insert into channels(user_id,project_id,network,vk_group_id,title) values(1,$1,'vk',123,'Transaction fixture') returning id", [projectId])).rows[0].id);
});
afterEach(async () => { await client.query("rollback"); client.release(); vi.unstubAllEnvs(); });
afterAll(async () => { await db.end(); });

async function report() { return loadAdminSystemDiagnostics({ now: () => now }); }
async function post(status: string, publishedAt: string | null = null) {
  return Number((await client.query("insert into posts(user_id,channel_id,project_id,status,published_at,provider_started_at) values(1,$1,$2,$3,$4,$5) returning id", [channelId, projectId, status, publishedAt, publishedAt ? new Date(Date.parse(publishedAt) - 2500).toISOString() : null])).rows[0].id);
}
async function event(postId: number, offsetMs: number, eventId = randomUUID()) {
  await client.query(`insert into product_events(event_id,project_id,user_id,section_id,feature_id,action,stage,outcome,error_code,operation_id,occurred_at)
    values($1,$2,1,'calendar','publication','scheduled','failed','failure','test_provider_timeout',$3,$4) on conflict do nothing`, [eventId, projectId, `post:${postId}`, at(offsetMs)]);
}

describe.sequential("admin system SQL on the actual schema (transactional synthetic fixtures)", () => {
  it("runs publication SQL without inventing posts.updated_at and reports absent outcomes honestly", async () => {
    const result = await report();
    const publication = result.components.find(c => c.id === "publication_worker")!;
    expect(publication.safeErrorCode).not.toBe("publication_worker_check_failed");
    expect(publication.metrics).toMatchObject({ successes: 0, failures: 0, averageDurationMs: null });
    expect(publication.state).not.toBe("healthy");
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
        values(1,$1,'draft',1,$2,'fixture',1,1,false,100,$3,$4,$5,$6)`, [randomUUID(), provider, outcome, outcome === "failed" ? "test_provider_timeout" : null, randomUUID(), at(offset)]);
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
