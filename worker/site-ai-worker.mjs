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
  const profile = (await pool.query(
    `select p.id, p.site_id, p.analysis_job_id, p.run_revision, p.topics, p.ai_classification, p.refined_at,
            s.user_id, s.confirmed_domain, s.canonical_url, s.verification_state, s.brand_name, s.status as site_status,
            j.result as analysis_result, j.created_at as analysis_created_at
       from site_profiles p
       join sites s on s.id = p.site_id
       left join site_analysis_jobs j on j.id = p.analysis_job_id
      where p.id = $1`,
    [profileId],
  )).rows[0];
  if (!profile || !profile.analysis_job_id) return null;
  const pages = (await pool.query(
    `select url, http_status, title, description, headings, main_content, schema_types, links, ctas, forms, public_comments, technical
       from site_analysis_pages where analysis_id = $1 order by id limit 400`,
    [profile.analysis_job_id],
  )).rows.map(pageFromRow);
  return { profile, pages };
}

/**
 * Уточнение профиля моделью-классификатором. Внутренний контур: результат кэшируется в
 * site_profiles.ai_classification и переиспользуется, пока не появится новый прогон анализа.
 * Детерминированный профиль пересобирается с учётом классификации — источник истины по-прежнему код.
 */
export async function refineSiteProfile(pool, { profileId, force = false }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const context = await loadProfileContext(pool, profileId);
  if (!context) return { ok: false, reason: "profile_context_missing" };
  const { profile, pages } = context;
  if (profile.site_status === "disconnected") return { ok: false, reason: "site_inactive" };
  if (profile.refined_at && !force) return { ok: true, skipped: "already_refined", profileId };

  const inventory = classifySitePages(pages).filter((page) => page.ok);
  const baseline = buildSiteProfile({ confirmedDomain: profile.confirmed_domain, pages, report: profile.analysis_result, checkedAt: profile.analysis_created_at });
  let classification = null;
  let engine = null;
  if (inventory.length) {
    assertWorkerAiCallPolicy("site-page-classifier");
    engine = configuredServiceEngine(dependencies.engine ?? process.env.SITE_CLASSIFIER_ENGINE ?? null);
    const prompt = buildClassifierPrompt({ pages: inventory, topics: baseline.topics, confirmedDomain: profile.confirmed_domain });
    try {
      const completion = await complete({
        system: prompt.system,
        user: prompt.user,
        engine,
        temperature: 0,
        maxTokens: 2_500,
        providerRequestKey: `site-classifier:${profileId}`,
      }, { allowFallback: true, timeoutMs: 90_000 });
      engine = completion.engine || engine;
      classification = parseClassifierResponse(completion.text, {
        knownUrls: inventory.map((page) => page.url),
        knownTopicKeys: baseline.topics.map((topic) => topic.key),
      });
    } catch (error) {
      // Классификатор — необязательный слой: при сбое профиль остаётся детерминированным.
      await pool.query(
        `update site_profiles set ai_classification = $2::jsonb, refined_at = now() where id = $1`,
        [profileId, JSON.stringify({ status: "failed", code: String(error?.code || error?.name || "classifier_failed").slice(0, 80), promptVersion: prompt.promptVersion })],
      );
      return { ok: false, profileId, reason: "classifier_failed" };
    }
  }

  const refined = buildSiteProfile({
    confirmedDomain: profile.confirmed_domain,
    pages,
    report: profile.analysis_result,
    checkedAt: profile.analysis_created_at,
    classification,
  });
  const overrides = classification ? Object.entries(classification.pageTypes).filter(([url, type]) => inventory.find((page) => page.url === url)?.pageType !== type).length : 0;

  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query(
      `update site_profiles
          set page_count = $2, publication_count = $3, topics = $4::jsonb, gaps = $5::jsonb, technical = $6::jsonb,
              linkable_pages = $7::jsonb, summary = $8, ai_classification = $9::jsonb, refined_at = now()
        where id = $1`,
      [
        profileId, refined.pageCount, refined.publicationCount, JSON.stringify(refined.topics), JSON.stringify(refined.gaps),
        JSON.stringify({ ...refined.technical, questions: refined.questions, pageTypeCounts: refined.pageTypeCounts, lastPublishedAt: refined.lastPublishedAt, checkedAt: refined.checkedAt, refined: refined.refined }),
        JSON.stringify(refined.linkablePages), refined.summary,
        JSON.stringify({ status: "ready", engine, promptVersion: "site-classifier-v1", pageTypeOverrides: overrides, topicClusters: classification?.topicClusters?.length || 0, ...classification }),
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
    await client.query("commit");
    return { ok: true, profileId, engine, pageTypeOverrides: overrides, topicClusters: classification?.topicClusters?.length || 0, reportsRebuilt: rebuilt };
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Интерпретация отчёта: видимый результат, поэтому идёт под резервацией лимита пользователя.
 * Детерминированный payload не меняется — интерпретация хранится рядом отдельным полем.
 */
export async function interpretSiteReport(pool, { reportId, force = false }, dependencies = {}) {
  const complete = dependencies.completeAiText || completeAiText;
  const acquire = dependencies.acquireUsage || acquireWorkerAiUsage;
  const commit = dependencies.commitUsage || commitWorkerAiUsage;
  const release = dependencies.releaseUsage || releaseWorkerAiUsage;

  const report = (await pool.query(
    `select r.id, r.site_id, r.kind, r.payload, r.interpretation_status, s.user_id, s.brand_name, s.confirmed_domain, s.status as site_status,
            p.topics
       from site_reports r join sites s on s.id = r.site_id
       left join site_profiles p on p.id = r.profile_id
      where r.id = $1 and r.status = 'ready'`,
    [reportId],
  )).rows[0];
  if (!report) return { ok: false, reason: "report_missing" };
  if (report.interpretation_status === "ready" && !force) return { ok: true, skipped: "already_interpreted", reportId };
  if (report.site_status === "disconnected") return { ok: false, reason: "site_inactive" };

  const usage = await acquire(pool, {
    userId: Number(report.user_id),
    kind: "site_report_interpretation",
    key: workerAiUsageCompositeKey("site-report-interpretation", [String(reportId), force ? `f${Date.now()}` : "v1"]),
    ttlMs: WORKER_AI_RESERVATION_TTL_MS,
  });
  if (usage.state === "limit") throw new SiteAiWorkerError("ai_usage_limit", "Лимит ИИ на сегодня исчерпан.", { retryable: true });
  if (usage.state === "in_progress") throw new SiteAiWorkerError("interpretation_in_progress", "Интерпретация уже выполняется.", { retryable: true });
  if (usage.state === "committed" && !force) return { ok: true, skipped: "already_committed", reportId };
  const reservationId = Number(usage.reservationId);
  assertWorkerAiCallPolicy("site-report-interpretation", reservationId);

  const niche = Array.isArray(report.topics) ? report.topics.slice(0, 6).map((topic) => topic.label).join(", ") : null;
  const engine = configuredServiceEngine(dependencies.engine ?? process.env.SITE_INTERPRETATION_ENGINE ?? null);
  const prompt = buildInterpretationPrompt({ payload: report.payload, brandName: report.brand_name, niche });
  try {
    let validation = null;
    let completionEngine = engine;
    let feedback = null;
    for (let attempt = 1; attempt <= 2 && !validation?.ok; attempt += 1) {
      const completion = await complete({
        system: prompt.system,
        user: feedback ? `${prompt.user}\n\nПРЕДЫДУЩИЙ ОТВЕТ ОТКЛОНЁН: ${feedback}` : prompt.user,
        engine,
        temperature: 0.3,
        maxTokens: 1_800,
        providerRequestKey: `site-interpretation:${reportId}:a${attempt}`,
      }, { allowFallback: true, timeoutMs: 90_000 });
      completionEngine = completion.engine || engine;
      try {
        validation = validateInterpretation(completion.text, { payload: report.payload, engine: completionEngine, promptVersion: prompt.promptVersion });
      } catch (error) {
        feedback = `ответ не является JSON нужной формы (${error.message}).`;
        continue;
      }
      if (!validation.ok) feedback = `слишком мало содержания после удаления недопустимых формулировок: ${validation.issues.map((issue) => issue.code).join(", ")}.`;
    }
    if (!validation?.ok) {
      await pool.query(`update site_reports set interpretation_status = 'failed', interpretation = $2::jsonb where id = $1`, [reportId, JSON.stringify({ status: "failed", issues: validation?.issues || [{ code: "schema_invalid" }] })]);
      await commit(pool, Number(report.user_id), reservationId);
      return { ok: false, reportId, reason: "interpretation_rejected", issues: validation?.issues || [] };
    }
    await pool.query(
      `update site_reports set interpretation = $2::jsonb, interpretation_status = 'ready' where id = $1`,
      [reportId, JSON.stringify({ ...validation.interpretation, issues: validation.issues })],
    );
    await commit(pool, Number(report.user_id), reservationId);
    return { ok: true, reportId, engine: completionEngine, startWith: validation.interpretation.startWith.length, removed: validation.issues.length };
  } catch (error) {
    await release(pool, Number(report.user_id), reservationId).catch(() => undefined);
    if (!(error instanceof SiteAiWorkerError)) {
      await pool.query(`update site_reports set interpretation_status = 'failed' where id = $1 and interpretation_status = 'pending'`, [reportId]).catch(() => undefined);
    }
    throw error;
  }
}

/** Догоняющий проход для отчётов, оставшихся без интерпретации (лимит ИИ, сбой очереди). */
export async function enqueuePendingInterpretations(pool, queue, { olderThanMinutes = 5, limit = 50 } = {}) {
  if (!queue) return { enqueued: 0 };
  const rows = await pool.query(
    `select r.id from site_reports r join sites s on s.id = r.site_id
      where r.status = 'ready' and r.interpretation_status = 'pending' and s.status = 'active'
        and r.created_at < now() - make_interval(mins => $1)
      order by r.created_at limit $2`,
    [olderThanMinutes, limit],
  );
  let enqueued = 0;
  for (const row of rows.rows) {
    await queue.add("interpret", { reportId: Number(row.id) }, {
      jobId: `site-articles-interpret-${row.id}-retry-${new Date().toISOString().slice(0, 13)}`,
      attempts: 2,
      backoff: { type: "exponential", delay: 60_000 },
      removeOnComplete: 100,
      removeOnFail: 100,
    }).then(() => { enqueued += 1; }).catch(() => undefined);
  }
  return { enqueued };
}
