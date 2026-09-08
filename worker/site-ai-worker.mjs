import { randomUUID } from "node:crypto";
import { ownedTaskTransaction, startTaskHeartbeat, WorkerTaskLeaseLost } from "./task-heartbeat.mjs";
import { AiWorkAccessError } from "../src/lib/ai-work-access.mjs";
import { requireSiteAiAccess, withSiteAiAccess, siteAiScope } from "./site-ai-access.mjs";
import { completeAiText } from "../src/lib/ai-completion-service.mjs";
import { configuredServiceEngine } from "../src/lib/ai-engine-policy.mjs";
import {
  buildClassifierPrompt,
  buildInterpretationPrompt,
  parseClassifierResponse,
  validateInterpretation,
} from "../src/lib/site-ai/interpretation.mjs";
import { buildSiteProfile, classifySitePages } from "../src/lib/site-profile/profile.mjs";
import { buildInitialAuditReport } from "../src/lib/site-report/initial-audit.mjs";
import { assertWorkerAiCallPolicy } from "./ai-call-policy.mjs";
import {
  WORKER_AI_RESERVATION_TTL_MS,
  acquireWorkerAiUsage,
  commitWorkerAiUsage,
  releaseWorkerAiUsage,
  workerAiUsageCompositeKey,
} from "./ai-usage-reservation.mjs";

export class SiteAiWorkerError extends Error {
  constructor(code, message, { retryable = false } = {}) {
    super(message);
    this.name = "SiteAiWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function pageFromRow(row) {
  const technical = row.technical || {};
  const { metadata, ...rest } = technical;
  return {
    url: row.url,
    status: Number(row.http_status || 0),
    title: row.title,
    description: row.description,
    headings: Array.isArray(row.headings) ? row.headings : [],
    mainContent: row.main_content,
    schemaTypes: Array.isArray(row.schema_types) ? row.schema_types : [],
    links: Array.isArray(row.links) ? row.links : [],
    ctas: Array.isArray(row.ctas) ? row.ctas : [],
    forms: Array.isArray(row.forms) ? row.forms : [],
    publicComments: Array.isArray(row.public_comments) ? row.public_comments : [],
    metadata: metadata || {},
    technical: rest,
  };
}

async function loadProfileContext(pool, profileId) {
  const actor = (await pool.query(`select p.site_id, j.user_id from site_profiles p
    join site_analysis_jobs j on j.id = p.analysis_job_id and j.site_id = p.site_id
    join sites s on s.id = p.site_id and s.project_id = j.project_id
    where p.id = $1`, [profileId])).rows[0];
  if (!actor) return null;
  const scope = await siteAiScope(pool, actor.site_id, actor.user_id);
  return withSiteAiAccess(pool, scope, async (client) => {
    const profile = (await client.query(
      `select p.id, p.site_id, p.analysis_job_id, p.run_revision, p.topics, p.ai_classification, p.refined_at,
              j.user_id, s.project_id, s.confirmed_domain, s.canonical_url, s.verification_state, s.brand_name, s.status as site_status,
              j.result as analysis_result, j.created_at as analysis_created_at
         from site_profiles p
         join sites s on s.id = p.site_id
         left join site_analysis_jobs j on j.id = p.analysis_job_id and j.site_id = p.site_id and j.project_id = s.project_id
        where p.id = $1`,
      [profileId],
    )).rows[0];
    if (!profile || !profile.analysis_job_id) return null;
    const pages = (await client.query(
      `select url, http_status, title, description, headings, main_content, schema_types, links, ctas, forms, public_comments, technical
         from site_analysis_pages where analysis_id = $1 order by id limit 400`,
      [profile.analysis_job_id],
    )).rows.map(pageFromRow);
    return { profile, pages, scope };
  });
}

const TRANSIENT_CODES = new Set(["provider_timeout", "provider_error", "provider_unavailable", "network_error", "overall_timeout", "empty_generation", "stream_truncated", "reasoning_without_content", "provider_rate_limited"]);
function failureMetadata(error, attempts) {
  const raw = String(error?.code || "provider_error");
  const code = /^[a-z0-9_]{1,80}$/u.test(raw) ? raw : "provider_error";
  return { status: "failed", code, attempts, retryable: attempts < 3 && (TRANSIENT_CODES.has(code) || Number(error?.status) === 429 || Number(error?.status) >= 500), retryAfter: new Date(Date.now() + 60_000 * attempts).toISOString() };
}

export async function refineSiteProfile(pool, { profileId, force = false }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const context = await loadProfileContext(pool, profileId);
  if (!context) return { ok: false, reason: "profile_context_missing" };
  const { profile, pages, scope } = context;
  if (profile.site_status !== "active") return { ok: false, reason: "site_inactive" };
  if (profile.refined_at && (!force || profile.ai_classification?.status === "ready")) return { ok: true, skipped: "already_refined", profileId };
  const identity = { table: "site_profiles", id: profileId, token: randomUUID() };
  const ownedProfileTransaction = (task) => ownedTaskTransaction(pool, identity, async (client) => {
    await requireSiteAiAccess(client, scope);
    return task(client);
  });
  const attempts = Math.max(0, Number(profile.ai_classification?.attempts) || 0) + 1;
  const claimed = await withSiteAiAccess(pool, scope, (client) => client.query(
    `update site_profiles set worker_lease_token = $2, worker_heartbeat_at = now(), ai_classification = $4::jsonb
      where id = $1 and (refined_at is null or ($3::boolean and ai_classification->>'status' = 'failed'))
        and (worker_lease_token is null or worker_heartbeat_at < now() - interval '2 minutes') returning id`,
    [profileId, identity.token, force, JSON.stringify({ status: "processing", attempts })],
  ));
  if (!claimed.rowCount) return { ok: true, skipped: "already_running", profileId };
  if (attempts > 3) {
    await ownedProfileTransaction((client) => client.query(
      `update site_profiles set ai_classification = $2::jsonb, refined_at = now(), worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
      [profileId, JSON.stringify({ status: "failed", code: "worker_recovery_exhausted", attempts, retryable: false })],
    ));
    return { ok: false, reason: "worker_recovery_exhausted" };
  }
  let heartbeat = null;
  try {
    heartbeat = await (dependencies.startHeartbeat || startTaskHeartbeat)(pool, identity);
    const inventory = classifySitePages(pages).filter((page) => page.ok);
    const baseline = buildSiteProfile({ confirmedDomain: profile.confirmed_domain, pages, report: profile.analysis_result, checkedAt: profile.analysis_created_at });
    let classification = null;
    let engine = null;
    if (inventory.length) {
      assertWorkerAiCallPolicy("site-page-classifier");
      engine = configuredServiceEngine(dependencies.engine ?? process.env.SITE_CLASSIFIER_ENGINE ?? null);
      const prompt = buildClassifierPrompt({ pages: inventory, topics: baseline.topics, confirmedDomain: profile.confirmed_domain });
      try {
        const completion = await complete({ system: prompt.system, user: prompt.user, engine, temperature: 0, maxTokens: 2_500,
          providerRequestKey: `site-classifier:${profileId}:a${attempts}`,
        }, {
          allowFallback: true,
          timeoutMs: 90_000,
          signal: heartbeat.signal,
          spendScope: { pool, userId: Number(profile.user_id), projectId: Number(profile.project_id) },
        });
        engine = completion.engine || engine;
        classification = parseClassifierResponse(completion.text, { knownUrls: inventory.map((page) => page.url), knownTopicKeys: baseline.topics.map((topic) => topic.key) });
      } catch (error) {
        if (error instanceof AiWorkAccessError || String(error?.code || "").startsWith("ai_spend_")) throw error;
        await ownedProfileTransaction((client) => client.query(
          `update site_profiles set ai_classification = $2::jsonb, refined_at = now(), worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
          [profileId, JSON.stringify({ ...failureMetadata(error, attempts), promptVersion: prompt.promptVersion })],
        ));
        return { ok: false, profileId, reason: "classifier_failed" };
      }
    }
    await heartbeat.checkpoint();
    const refined = buildSiteProfile({
      confirmedDomain: profile.confirmed_domain,
      pages,
      report: profile.analysis_result,
      checkedAt: profile.analysis_created_at,
      classification,
    });
    const overrides = classification ? Object.entries(classification.pageTypes).filter(([url, type]) => inventory.find((page) => page.url === url)?.pageType !== type).length : 0;

    return ownedProfileTransaction(async (client) => {
      await client.query(
        `update site_profiles
            set page_count = $2, publication_count = $3, topics = $4::jsonb, gaps = $5::jsonb, technical = $6::jsonb,
                linkable_pages = $7::jsonb, summary = $8, ai_classification = $9::jsonb, refined_at = now(), worker_lease_token = null, worker_heartbeat_at = null
          where id = $1`,
        [
          profileId, refined.pageCount, refined.publicationCount, JSON.stringify(refined.topics), JSON.stringify(refined.gaps),
          JSON.stringify({ ...refined.technical, questions: refined.questions, pageTypeCounts: refined.pageTypeCounts, lastPublishedAt: refined.lastPublishedAt, checkedAt: refined.checkedAt, refined: refined.refined }),
          JSON.stringify(refined.linkablePages), refined.summary,
          JSON.stringify({ status: "ready", attempts, engine, promptVersion: "site-classifier-v1", pageTypeOverrides: overrides, topicClusters: classification?.topicClusters?.length || 0, ...classification }),
        ],
      );
      // Отчёты, построенные детерминированно по этому профилю, пересобираются по той же формуле —
      // чтобы интерпретация читала уже уточнённые темы и пробелы.
      const reports = await client.query(
        `select id, kind, payload from site_reports where profile_id = $1 and kind in ('initial_audit', 'on_demand') and status = 'ready'
          and (payload->>'reportVersion') = 'site-report-v1' and payload->'period' = 'null'::jsonb`,
        [profileId],
      );
      let rebuilt = 0;
      for (const row of reports.rows) {
        const report = buildInitialAuditReport({
          site: { confirmedDomain: profile.confirmed_domain, canonicalUrl: profile.canonical_url, verificationState: profile.verification_state },
          profile: refined,
          analysis: row.payload?.analysis || {},
          generatedAt: row.payload?.generatedAt || null,
        });
        await client.query(
          `update site_reports set payload = $2::jsonb, summary_ru = $3 where id = $1`,
          [row.id, JSON.stringify(row.kind === "on_demand" ? { ...report.payload, kind: "on_demand" } : report.payload), report.summaryRu],
        );
        rebuilt += 1;
      }
      return { ok: true, profileId, engine, pageTypeOverrides: overrides, topicClusters: classification?.topicClusters?.length || 0, reportsRebuilt: rebuilt };
    });
  } catch (error) {
    if (!(error instanceof WorkerTaskLeaseLost)) {
      await ownedProfileTransaction((client) => client.query(
        `update site_profiles set ai_classification = $2::jsonb, refined_at = now(), worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
        [profileId, JSON.stringify(failureMetadata(error, attempts))],
      )).catch(() => undefined);
    }
    throw error;
  } finally { await heartbeat?.stop(); }
}

/** @param {any} pool
 * @param {{reportId: number, force?: boolean, revision?: number|null}} job
 * @param {any} dependencies
 */
export async function interpretSiteReport(pool, { reportId, force = false, revision = null }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const acquire = dependencies.acquireUsage || acquireWorkerAiUsage;
  const commit = dependencies.commitUsage || commitWorkerAiUsage;
  const release = dependencies.releaseUsage || releaseWorkerAiUsage;
  const actor = (await pool.query(`select r.site_id, coalesce(r.requested_by_user_id, j.user_id) as user_id
    from site_reports r
    left join site_profiles p on p.id = r.profile_id and p.site_id = r.site_id
    left join site_analysis_jobs j on j.id = p.analysis_job_id and j.site_id = r.site_id
    where r.id = $1`, [reportId])).rows[0];
  if (!actor) return { ok: false, reason: "report_missing" };
  const scope = await siteAiScope(pool, actor.site_id, actor.user_id);
  const report = await withSiteAiAccess(pool, scope, async (client) => (await client.query(
    `select r.id, r.site_id, r.kind, r.payload, r.interpretation, r.interpretation_status, r.interpretation_revision,
            coalesce(r.requested_by_user_id, j.user_id) as user_id, s.project_id, s.brand_name, s.confirmed_domain,
            s.status as site_status, p.topics
       from site_reports r
       join sites s on s.id = r.site_id
       left join site_profiles p on p.id = r.profile_id and p.site_id = r.site_id
       left join site_analysis_jobs j on j.id = p.analysis_job_id and j.site_id = p.site_id and j.project_id = s.project_id
      where r.id = $1 and r.status = 'ready'`,
    [reportId],
  )).rows[0]);
  if (!report) return { ok: false, reason: "report_missing" };
  if (report.interpretation_status === "ready") return { ok: true, skipped: "already_interpreted", reportId };
  if (report.site_status !== "active") return { ok: false, reason: "site_inactive" };
  const currentRevision = Number(report.interpretation_revision || 1);
  const identity = { table: "site_reports", id: reportId, token: randomUUID() };
  const ownedReportTransaction = (task) => ownedTaskTransaction(pool, identity, async (client) => {
    await requireSiteAiAccess(client, scope);
    return task(client);
  });
  const attempts = Math.max(0, Number(report.interpretation?.attempts) || 0) + 1;
  const claimed = await withSiteAiAccess(pool, scope, (client) => client.query(
    `update site_reports set worker_lease_token = $2, worker_heartbeat_at = now(), interpretation_status = 'pending', interpretation = $5::jsonb
      where id = $1 and interpretation_revision = $3 and ($6::integer is null or interpretation_revision = $6)
        and interpretation_status <> 'ready' and ($4::boolean or interpretation_status = 'pending' or interpretation->>'retryable' = 'true')
        and (worker_lease_token is null or worker_heartbeat_at < now() - interval '2 minutes') returning id`,
    [reportId, identity.token, currentRevision, force, JSON.stringify({ status: "processing", attempts }), revision],
  ));
  if (!claimed.rowCount) return { ok: true, skipped: "already_running_or_stale", reportId };
  if (attempts > 3) {
    await ownedReportTransaction((client) => client.query(
      `update site_reports set interpretation_status = 'failed', interpretation = $2::jsonb, worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
      [reportId, JSON.stringify({ status: "failed", code: "worker_recovery_exhausted", attempts, retryable: false })],
    ));
    return { ok: false, reason: "worker_recovery_exhausted" };
  }
  let reservationId = null;
  let heartbeat = null;
  try {
    const usage = await acquire(pool, {
      userId: Number(report.user_id), kind: "site_report_interpretation",
      key: workerAiUsageCompositeKey("site-report-interpretation", [String(reportId), `v${currentRevision}`]), ttlMs: WORKER_AI_RESERVATION_TTL_MS,
    });
    if (usage.state === "limit" || usage.state === "in_progress") {
      const code = usage.state === "limit" ? "ai_usage_limit" : "interpretation_in_progress";
      await ownedReportTransaction((client) => client.query(
        `update site_reports set interpretation = $2::jsonb, worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
        [reportId, JSON.stringify({ status: "pending", code, attempts: attempts - 1 })],
      ));
      throw new SiteAiWorkerError(code, "Интерпретация ожидает доступного лимита.", { retryable: true });
    }
    if (usage.state === "committed") {
      await ownedReportTransaction((client) => client.query(
        `update site_reports set interpretation_status = 'failed', interpretation = $2::jsonb, worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
        [reportId, JSON.stringify({ status: "failed", code: "generation_already_accounted", attempts, retryable: false })],
      ));
      return { ok: false, reportId, reason: "generation_already_accounted" };
    }
    reservationId = Number(usage.reservationId);
    assertWorkerAiCallPolicy("site-report-interpretation", reservationId);
    heartbeat = await (dependencies.startHeartbeat || startTaskHeartbeat)(pool, identity, { userId: Number(report.user_id), reservationId });
    const niche = Array.isArray(report.topics) ? report.topics.slice(0, 6).map((topic) => topic.label).join(", ") : null;
    const engine = configuredServiceEngine(dependencies.engine ?? process.env.SITE_INTERPRETATION_ENGINE ?? null);
    const prompt = buildInterpretationPrompt({ payload: report.payload, brandName: report.brand_name, niche });
    let validation = null;
    let completionEngine = engine;
    let feedback = null;
    for (let attempt = 1; attempt <= 2 && !validation?.ok; attempt += 1) {
      await heartbeat.checkpoint();
      const completion = await complete({
        system: prompt.system, user: feedback ? `${prompt.user}\n\nПРЕДЫДУЩИЙ ОТВЕТ ОТКЛОНЁН: ${feedback}` : prompt.user,
        engine, temperature: 0.3, maxTokens: 1_800,
        providerRequestKey: `site-interpretation:${reportId}:v${currentRevision}:run${attempts}:a${attempt}`,
      }, {
        allowFallback: true,
        timeoutMs: 90_000,
        signal: heartbeat.signal,
        spendScope: { pool, userId: Number(report.user_id), projectId: Number(report.project_id) },
      });
      completionEngine = completion.engine || engine;
      try { validation = validateInterpretation(completion.text, { payload: report.payload, engine: completionEngine, promptVersion: prompt.promptVersion }); }
      catch (error) { validation = null; feedback = `ответ не является JSON нужной формы (${error.message}).`; continue; }
      if (!validation.ok) feedback = `слишком мало содержания после удаления недопустимых формулировок: ${validation.issues.map((issue) => issue.code).join(", ")}.`;
    }
    await heartbeat.checkpoint();
    if (!validation?.ok) {
      await ownedReportTransaction(async (client) => {
        await client.query(
          `update site_reports set interpretation_status = 'failed', interpretation = $2::jsonb, worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
          [reportId, JSON.stringify({ status: "failed", attempts, retryable: false, issues: validation?.issues || [{ code: "schema_invalid" }] })],
        );
        await release(client, Number(report.user_id), reservationId);
      });
      return { ok: false, reportId, reason: "interpretation_rejected", issues: validation?.issues || [] };
    }
    await ownedReportTransaction(async (client) => {
      await client.query(
        `update site_reports set interpretation = $2::jsonb, interpretation_status = 'ready', worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
        [reportId, JSON.stringify({ ...validation.interpretation, issues: validation.issues, attempts })],
      );
      if (!await commit(client, Number(report.user_id), reservationId)) throw new WorkerTaskLeaseLost();
    });
    return { ok: true, reportId, engine: completionEngine, startWith: validation.interpretation.startWith.length, removed: validation.issues.length };
  } catch (error) {
    if (!(error instanceof SiteAiWorkerError) && !(error instanceof WorkerTaskLeaseLost)) {
      await ownedReportTransaction(async (client) => {
        await client.query(
          `update site_reports set interpretation_status = 'failed', interpretation = $2::jsonb, worker_lease_token = null, worker_heartbeat_at = null where id = $1`,
          [reportId, JSON.stringify(failureMetadata(error, attempts))],
        );
        if (reservationId) await release(client, Number(report.user_id), reservationId);
      }).catch(() => undefined);
    }
    throw error;
  } finally { await heartbeat?.stop(); }
}

/** Bounded recovery of missed enqueues, abandoned leases and transient failures. */
export async function enqueuePendingInterpretations(pool, queue, { olderThanMinutes = 2, limit = 50 } = {}) {
  if (!queue) return { enqueued: 0 };
  const rows = await pool.query(
    `select r.id, r.interpretation_revision from site_reports r join sites s on s.id = r.site_id
      where r.status = 'ready' and s.status = 'active'
        and (r.worker_lease_token is null or r.worker_heartbeat_at < now() - interval '2 minutes')
        and r.created_at < now() - make_interval(mins => $1)
        and (r.interpretation_status = 'pending' or (r.interpretation_status = 'failed' and r.interpretation->>'retryable' = 'true'))
        and (r.interpretation->>'retryAfter' is null or r.interpretation->>'retryAfter' < to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      order by r.created_at limit $2`, [olderThanMinutes, limit],
  );
  let enqueued = 0;
  for (const row of rows.rows) {
    await queue.add("interpret", { reportId: Number(row.id), revision: Number(row.interpretation_revision || 1) }, {
      jobId: `site-articles-interpret-${row.id}-v${row.interpretation_revision || 1}-retry-${Math.floor(Date.now() / 60_000)}`,
      attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 100, removeOnFail: 100,
    });
    enqueued += 1;
  }
  return { enqueued };
}

export async function enqueuePendingRefinements(pool, queue) {
  if (!queue) return { enqueued: 0 };
  const rows = await pool.query(
    `select p.id, p.refined_at from site_profiles p join sites s on s.id = p.site_id
      where s.status = 'active' and s.latest_profile_id = p.id and p.analysis_job_id is not null
        and p.created_at < now() - interval '2 minutes'
        and (p.worker_lease_token is null or p.worker_heartbeat_at < now() - interval '2 minutes')
        and (p.refined_at is null or p.ai_classification->>'retryable' = 'true')
        and (p.ai_classification->>'retryAfter' is null or p.ai_classification->>'retryAfter' < to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      order by p.created_at limit 50`,
  );
  for (const row of rows.rows) await queue.add("refine", { profileId: Number(row.id), force: Boolean(row.refined_at) }, {
    jobId: `site-articles-refine-${row.id}-retry-${Math.floor(Date.now() / 60_000)}`,
    attempts: 2, backoff: { type: "exponential", delay: 60_000 }, removeOnComplete: 100, removeOnFail: 100,
  });
  return { enqueued: rows.rows.length };
}
