import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { Queue, QueueEvents, Worker } from "bullmq";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadAdminAuroraAnalytics, normalizeAdminAnalyticsQuery } from "@/lib/admin-aurora-analytics";
import { generateSiteArticle } from "../../worker/site-articles-worker.mjs";
import { approveSiteArticle, findSiteArticle } from "@/lib/sites/articles-service";
import { startTaskHeartbeat, ownedTaskTransaction } from "../../worker/task-heartbeat.mjs";
import { createMediaGenerationStore, recoverMediaDeliveries } from "../../worker/media-generation-store.mjs";
import { executeMediaGenerationJob } from "../../worker/media-generation-worker.mjs";
import { interpretSiteReport, enqueuePendingRefinements, refineSiteProfile } from "../../worker/site-ai-worker.mjs";
import { recoverSiteTasks } from "../../worker/site-task-recovery.mjs";
import { buildSiteProfile } from "../../src/lib/site-profile/profile.mjs";
import { buildInitialAuditReport } from "../../src/lib/site-report/initial-audit.mjs";
import { acquireWorkerAiUsage, commitWorkerAiUsage } from "../../worker/ai-usage-reservation.mjs";
import { migrate } from "../../scripts/migrate.mjs";

// Create and remove only this run's own database; never reuse an existing database.
const connection = new URL(process.env.STUDIO_SITES_TEST_POSTGRES_URL || "postgresql://127.0.0.1/postgres");
if (!["localhost", "127.0.0.1", "[::1]"].includes(connection.hostname)) throw new Error("Local PostgreSQL required");
const database = `aurora_studio_sites_qa_${randomUUID().replaceAll("-", "")}`;
const admin = new pg.Pool({ connectionString: connection.href, ssl: false, connectionTimeoutMillis: 15_000 });
connection.pathname = `/${database}`;
const pool = new pg.Pool({ connectionString: connection.href, ssl: false, connectionTimeoutMillis: 15_000 });
let created = false;
let userId: number;
let projectId: number;
const requestId = randomUUID();
const now = new Date("2026-09-08T12:00:00Z");

beforeAll(async () => {
  await admin.query(`create database ${database}`);
  created = true;
  await pool.query(await readFile(new URL("../../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: { ...process.env, DATABASE_URL: connection.href }, logger: { log() {} } });
  userId = Number((await pool.query("insert into users (email,name) values ('review@example.test','QA') returning id")).rows[0].id);
  projectId = Number((await pool.query("insert into projects (name,created_by_user_id) values ('QA',$1) returning id", [userId])).rows[0].id);
  const channelId = (await pool.query("insert into channels (user_id,project_id,tg_chat_id,title) values ($1,$2,-999,'QA') returning id", [userId,projectId])).rows[0].id;
  const usageId = (await pool.query("insert into ai_usage (user_id,kind) values ($1,'generate') returning id", [userId])).rows[0].id;
  await pool.query(`insert into generation_operations
    (user_id,ai_usage_id,request_key,server_request_id,request_fingerprint,channel_id,provider_engine,provider_model,status,error_code,created_at,updated_at)
    values ($1,$2,'qa-budget',$3,$4,$5,'qa','qa','failed','ai_operation_budget_exhausted','2026-09-06T13:00Z','2026-09-07T15:00Z')`,
    [userId,usageId,requestId,"a".repeat(64),channelId]);
  await pool.query("insert into aurora_releases (release_key) values ('qa-release')");
  await pool.query(`insert into product_events (event_id,project_id,user_id,section_id,feature_id,action,stage,outcome,error_code,request_id,release_key,occurred_at,safe_context)
    values ($1,$2,$3,'studio','generation','generate','failed','failure','ai_operation_budget_exhausted',$4,'qa-release','2026-09-07T15:01Z','{"source":"api","device":"desktop"}')`,
    [randomUUID(),projectId,userId,requestId]);
}, 180_000);

afterAll(async () => {
  await pool.end();
  if (created) await admin.query(`drop database ${database}`);
  await admin.end();
}, 120_000);

async function analytics(extra: Record<string,string> = {}) {
  return loadAdminAuroraAnalytics(pool, normalizeAdminAnalyticsQuery(new URLSearchParams({ range: "24h", analyticsSection: "studio", ...extra }), now), { now });
}

describe("real PostgreSQL analytics correlation", () => {
  it("counts an operation once, keeps the release, and uses its failure time", async () => {
    const result = await analytics();
    const errors = result.detail!.errors.filter((e) => e.errorCode === "ai_operation_budget_exhausted");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ count: 1, previousCount: 0, affectedUsers: 1, affectedProjects: 1, release: "qa-release", requestId, dependencyId: "aurora_ai" });
  });
  it("keeps supported telemetry filters and isolates projects", async () => {
    expect((await analytics({ release: "qa-release", device: "desktop" })).detail!.errors).toHaveLength(1);
    expect((await analytics({ release: "missing" })).detail!.errors).toHaveLength(0);
    expect((await analytics({ project: String(projectId + 100) })).detail!.errors).toHaveLength(0);
  });
  it("still shows a domain-only failure, in the completion period", async () => {
    await pool.query("delete from product_events where request_id=$1", [requestId]);
    const result = await analytics();
    expect(result.detail!.errors).toHaveLength(1);
    expect(result.detail!.errors[0]).toMatchObject({ count: 1, previousCount: 0, release: null, requestId });
  });
});


describe("stored article quality and quota", () => {
  it("preserves rejected content, refunds the reservation and refuses approval", async () => {
    const site = (await pool.query(`insert into sites (project_id,user_id,confirmed_domain,canonical_url,verification_token)
      values ($1,$2,'example.test','https://example.test/','disposable-verification-token') returning *`, [projectId,userId])).rows[0];
    const articleId = Number((await pool.query(`insert into site_articles (site_id,project_id,user_id,article_type,origin,source_ref,slug)
      values ($1,$2,$3,'company_news','manual','{"kind":"manual","brief":"Тестовая новость"}','qa-draft') returning id`, [site.id,projectId,userId])).rows[0].id);
    const result = await generateSiteArticle(pool, { articleId }, {
      embed: null,
      completeAiText: async () => ({ text: JSON.stringify({ title: "Тестовая новость", bodyMarkdown: "Слишком короткий текст." }), engine: "qa" }),
    });
    expect(result).toMatchObject({ ok: false, reason: "quality" });
    const article = await findSiteArticle(pool, Number(site.id), articleId);
    expect(article).toMatchObject({ title: "Тестовая новость", body_markdown: "Слишком короткий текст.", status: "failed", status_reason: "quality" });
    expect(article!.quality!.issues).toEqual(expect.arrayContaining([expect.objectContaining({ severity: "error", code: "too_short" })]));
    const usage = (await pool.query("select status from ai_usage where user_id=$1 and reservation_key=$2", [userId,`worker:site-article:${articleId}:v1`])).rows;
    expect(usage).toEqual([{ status: "released" }]);
    await expect(approveSiteArticle(pool, { site, article: article!, userId })).rejects.toMatchObject({ code: "article_quality_failed" });
    expect((await pool.query("select count(*)::int as n from site_article_publications where article_id=$1", [articleId])).rows[0].n).toBe(0);
  });
});


async function makeSite() {
  const domain = `${randomUUID()}.example.test`;
  return (await pool.query(`insert into sites (project_id,user_id,confirmed_domain,canonical_url,verification_token)
    values ($1,$2,$3,$4,$5) returning *`, [projectId,userId,domain,`https://${domain}/`,randomUUID()])).rows[0];
}
async function makeMedia(status = "queued", providerJobId: string | null = null) {
  const requestKey = randomUUID();
  const usage = await acquireWorkerAiUsage(pool, { userId, kind: "image", key: `qa:${requestKey}`, ttlMs: 60 * 60_000 });
  const row = (await pool.query(`insert into media_generations
    (user_id,project_id,kind,prompt,model,aspect_ratio,request_key,provider_request_key,ai_usage_reservation_id,status,provider_job_id,queue_confirmed_at,updated_at)
    values ($1,$2,'image','Synthetic test','nano-banana','1:1',$3,$3,$4,$5,$6,now(),now()-interval '3 minutes') returning *`,
    [userId,projectId,requestKey,usage.reservationId,status,providerJobId])).rows[0];
  return { row, job: { generationId: Number(row.id), projectId, requestId: row.request_id, requestKey, providerRequestKey: requestKey } };
}

describe("durable worker ownership and recovery", () => {
  it("renews a short quota past its original expiry and fences an old worker", async () => {
    const { row } = await makeMedia();
    const token = randomUUID();
    await pool.query("update media_generations set worker_lease_token=$2 where id=$1", [row.id,token]);
    const identity = { table: "media_generations", id: row.id, token };
    await pool.query("update ai_usage set expires_at=now()+interval '350 milliseconds' where id=$1", [row.ai_usage_reservation_id]);
    const heartbeat = await startTaskHeartbeat(pool, identity, { userId, reservationId: row.ai_usage_reservation_id, ttlMs: 1200, intervalMs: 100 });
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect((await pool.query("select expires_at > now() as live from ai_usage where id=$1", [row.ai_usage_reservation_id])).rows[0].live).toBe(true);
      await pool.query("update media_generations set worker_lease_token=$2 where id=$1", [row.id,randomUUID()]);
      const write = vi.fn();
      await expect(ownedTaskTransaction(pool, identity, write)).rejects.toMatchObject({ code: "worker_lease_lost" });
      expect(write).not.toHaveBeenCalled();
      await expect(heartbeat.checkpoint()).rejects.toMatchObject({ code: "worker_lease_lost" });
      expect(heartbeat.signal.aborted).toBe(true);
    } finally { await heartbeat.stop(); }
  });

  it("terminates an ambiguous send without another provider request and releases quota", async () => {
    const { row, job } = await makeMedia("submitting");
    const create = vi.fn();
    const store = createMediaGenerationStore(pool, vi.fn());
    await expect(executeMediaGenerationJob(job, { store, provider: { create } })).rejects.toMatchObject({ code: "provider_outcome_unknown" });
    expect(create).not.toHaveBeenCalled();
    expect((await pool.query("select status,error_code,worker_lease_token from media_generations where id=$1", [row.id])).rows[0])
      .toEqual({ status: "failed", error_code: "provider_outcome_unknown", worker_lease_token: null });
    expect((await pool.query("select status from ai_usage where id=$1", [row.ai_usage_reservation_id])).rows[0].status).toBe("released");
  });

  it("resumes a known provider job once and rejects concurrent delivery and wrong projects", async () => {
    const { row, job } = await makeMedia("generating", "provider-existing-qa");
    const create = vi.fn();
    const poll = vi.fn(async () => ({ state: "completed", outputUrl: "https://example.test/synthetic.png" }));
    const persist = vi.fn(async (generation: typeof row) => {
      await ownedTaskTransaction(pool, { table: "media_generations", id: row.id, token: generation.worker_lease_token }, async (client: pg.PoolClient) => {
        await client.query("update media_generations set status='ready', worker_lease_token=null, worker_heartbeat_at=null where id=$1", [row.id]);
        expect(await commitWorkerAiUsage(client, userId, row.ai_usage_reservation_id)).toBe(true);
      });
    });
    const store = createMediaGenerationStore(pool, persist);
    expect(await store.claim({ ...job, projectId: projectId + 100 })).toMatchObject({ state: "skip" });
    const lease = { start: async (generation: typeof row) => {
      expect(await store.claim(job)).toMatchObject({ state: "skip", reason: "worker_active" });
      return startTaskHeartbeat(pool, { table: "media_generations", id: row.id, token: generation.worker_lease_token }, { userId, reservationId: row.ai_usage_reservation_id });
    } };
    const deps = { store, provider: { create, poll }, lease, now: Date.now, wait: async () => {} };
    expect(await executeMediaGenerationJob(job, deps)).toMatchObject({ outcome: "ready" });
    expect(await executeMediaGenerationJob(job, deps)).toMatchObject({ outcome: "skipped" });
    expect(create).not.toHaveBeenCalled(); expect(poll).toHaveBeenCalledTimes(1); expect(persist).toHaveBeenCalledTimes(1);
    expect((await pool.query("select status from ai_usage where id=$1", [row.ai_usage_reservation_id])).rows[0].status).toBe("committed");
  });

  it("does not let an expired owner fail or release its successor's reservation", async () => {
    const { row, job } = await makeMedia();
    const store = createMediaGenerationStore(pool, vi.fn());
    const old = await store.claim(job);
    await pool.query("update media_generations set worker_heartbeat_at=now()-interval '3 minutes',provider_job_id='known' where id=$1", [row.id]);
    const next = await store.claim(job);
    expect(next).toMatchObject({ state: "claimed" });
    await expect(store.failAndRelease(old.generation, { code: "provider_timeout", message: "old" })).rejects.toMatchObject({ code: "worker_lease_lost" });
    expect((await pool.query("select status from ai_usage where id=$1", [row.ai_usage_reservation_id])).rows[0].status).toBe("reserved");
    await store.failAndRelease(next.generation, { code: "qa_cleanup", message: "Synthetic completion" });
  });

  it("recovers missed media, profile and report jobs without calling a provider", async () => {
    const site = await makeSite();
    const analysisId = (await pool.query(`insert into site_analysis_jobs (user_id,project_id,request_id,idempotency_key,request_fingerprint,target_url,confirmed_domain,consented_at)
      values ($1,$2,$3,$3,$3,$4,$5,now()) returning id`, [userId,projectId,randomUUID(),site.canonical_url,site.confirmed_domain])).rows[0].id;
    const profileId = (await pool.query("insert into site_profiles (site_id,analysis_job_id,created_at) values ($1,$2,now()-interval '3 minutes') returning id", [site.id,analysisId])).rows[0].id;
    await pool.query("update sites set latest_profile_id=$2 where id=$1", [site.id,profileId]);
    const queue = { add: vi.fn(async () => ({})) };
    expect(await enqueuePendingRefinements(pool, queue)).toMatchObject({ enqueued: 1 });
    expect(queue.add).toHaveBeenCalledWith("refine", { profileId: Number(profileId), force: false }, expect.any(Object));
    const complete = vi.fn();
    expect(await refineSiteProfile(pool, { profileId: Number(profileId) }, { completeAiText: complete })).toMatchObject({ ok: true });
    expect(complete).not.toHaveBeenCalled(); // No crawled inventory: deterministic baseline is sufficient.
    expect(await enqueuePendingRefinements(pool, queue)).toMatchObject({ enqueued: 0 });
    await makeMedia();
    expect((await recoverMediaDeliveries(pool, queue)).enqueued).toBeGreaterThan(0);
    await expect(recoverSiteTasks(pool, queue)).resolves.toMatchObject({ profiles: { enqueued: 0 } });
  });

  it("refunds a rejected interpretation and accepts only the requested retry revision", async () => {
    const site = await makeSite();
    const baseline = buildSiteProfile({ confirmedDomain: site.confirmed_domain, pages: [] });
    const audit = buildInitialAuditReport({ site: { confirmedDomain: site.confirmed_domain, canonicalUrl: site.canonical_url, verificationState: "unverified" }, profile: baseline });
    const reportId = Number((await pool.query("insert into site_reports (site_id,kind,payload,summary_ru,interpretation_status) values ($1,'initial_audit',$2,'QA','pending') returning id", [site.id,JSON.stringify(audit.payload)])).rows[0].id);
    const complete = vi.fn(async () => ({ text: JSON.stringify({ summary: "Гарантируем рост трафика.", whatItMeans: [], startWith: [], watchOut: [] }), engine: "qa" }));
    expect(await interpretSiteReport(pool, { reportId, revision: 1 }, { completeAiText: complete })).toMatchObject({ ok: false, reason: "interpretation_rejected" });
    expect((await pool.query("select status from ai_usage where reservation_key=$1", [`worker:site-report-interpretation:${reportId}:v1`])).rows[0].status).toBe("released");
    await pool.query("update site_reports set interpretation_status='pending',interpretation_revision=2,interpretation=null where id=$1", [reportId]);
    complete.mockClear();
    expect(await interpretSiteReport(pool, { reportId, revision: 1 }, { completeAiText: complete })).toMatchObject({ skipped: "already_running_or_stale" });
    expect(complete).not.toHaveBeenCalled();
    expect(await interpretSiteReport(pool, { reportId, revision: 2 }, { completeAiText: complete })).toMatchObject({ reason: "interpretation_rejected" });
    expect((await pool.query("select status from ai_usage where reservation_key=$1", [`worker:site-report-interpretation:${reportId}:v2`])).rows[0].status).toBe("released");
  });
});


describe("real Redis recovery handoff", () => {
  it("deduplicates one recovery sweep and delivers again after an earlier job is completed", async () => {
    const redis = new URL(process.env.STUDIO_SITES_TEST_REDIS_URL || "redis://127.0.0.1:6379");
    if (!["localhost", "127.0.0.1", "[::1]"].includes(redis.hostname)) throw new Error("Local Redis required");
    const redisConnection = { host: redis.hostname, port: Number(redis.port || 6379), maxRetriesPerRequest: null };
    const queueName = `studio-sites-qa-${randomUUID()}`;
    const queue = new Queue(queueName, { connection: redisConnection });
    const events = new QueueEvents(queueName, { connection: redisConnection });
    let worker: Worker | null = null;
    try {
      await queue.waitUntilReady();
      const { job } = await makeMedia("generating", "qa-existing-provider-job");
      await recoverMediaDeliveries(pool, queue);
      await recoverMediaDeliveries(pool, queue);
      const jobs = await queue.getJobs(["wait", "delayed"]);
      const own = jobs.filter((item) => item.data.generationId === job.generationId);
      expect(own).toHaveLength(1);
      expect(own[0].data).toMatchObject(job);
      await events.waitUntilReady();
      worker = new Worker(queueName, async () => ({ synthetic: true }), { connection: redisConnection });
      await own[0].waitUntilFinished(events, 5000);
      await worker.close(); worker = null;
      expect(await own[0].getState()).toBe("completed");
      const future = Date.now() + 61_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(future);
      try { await recoverMediaDeliveries(pool, queue); }
      finally { clock.mockRestore(); }
      const retried = (await queue.getJobs(["wait", "delayed"])).filter((item) => item.data.generationId === job.generationId);
      expect(retried).toHaveLength(1);
      expect(retried[0].id).not.toBe(own[0].id);
    } finally {
      await worker?.close();
      await events.close();
      await queue.obliterate({ force: true }); // Only this random, synthetic test queue.
      await queue.close();
    }
  });
});


describe("concurrent article approval", () => {
  it("counts one approval per version even when two requests arrive together", async () => {
    const site = await makeSite();
    const articleId = Number((await pool.query(`insert into site_articles
      (site_id,project_id,user_id,article_type,origin,source_ref,slug,title,body_markdown,status,quality)
      values ($1,$2,$3,'company_news','manual','{"kind":"manual"}','qa-approval','Тестовая статья','Текст одобренного материала','needs_review','{"issues":[]}') returning id`,
      [site.id,projectId,userId])).rows[0].id);
    const approve = async () => {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const article = await findSiteArticle(client, Number(site.id), articleId, true);
        await approveSiteArticle(client, { site, article: article!, userId });
        await client.query("commit");
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    };
    await Promise.all([approve(), approve()]);
    expect((await pool.query("select approved_streak from sites where id=$1", [site.id])).rows[0].approved_streak).toBe(1);
    expect((await pool.query("select count(*)::int as n from site_article_revisions where article_id=$1 and change_kind='approved'", [articleId])).rows[0].n).toBe(1);
  });
});
