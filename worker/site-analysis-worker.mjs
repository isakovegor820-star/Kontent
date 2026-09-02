import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";

import { SiteCrawlerError, crawlSite } from "../src/lib/site-crawler.mjs";
import { completeAiText } from "../src/lib/ai-completion-service.mjs";
import { isConfiguredEngineId } from "../src/lib/ai-engine-policy.mjs";
import { buildSiteEvidenceSnapshot } from "../src/lib/site-analysis/evidence.mjs";
import {
  SITE_OSINT_PROMPT_VERSION,
} from "../src/lib/site-analysis/interview.mjs";
import {
  SITE_INTERVIEW_CATALOG_VERSION,
  SITE_INTERVIEW_QUESTIONS,
} from "../src/lib/site-analysis/questions.data.mjs";
import { finalizeWorkerAiUsage } from "./ai-usage-reservation.mjs";
import { runSiteInterview, SiteInterviewWorkerError } from "./site-analysis-interview.mjs";
import { persistSiteProfileForAnalysis } from "./site-profile-persistence.mjs";

const SITE_ANALYSIS_QUEUE = "site-analysis";

const RETRYABLE_CODES = new Set([
  "queue_unconfirmed",
  "robots_unavailable",
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "analysis_in_progress",
  "quota_commit_failed",
]);

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

const SAFE_INTERVIEW_CODES = new Set([
  "ai_usage_limit",
  "provider_timeout",
  "network_error",
  "rate_limited",
  "stream_truncated",
  "empty_generation",
  "provider_error",
  "engine_not_connected",
  "engine_unsupported",
  "schema_invalid",
  "batch_idempotency_conflict",
  "stored_batch_invalid",
  "batch_superseded",
  "analysis_in_progress",
  "quota_commit_failed",
]);

function publicErrorMessage(code) {
  switch (code) {
    case "queue_unconfirmed": return "Фоновая очередь не подтвердила запуск анализа.";
    case "robots_denied": return "robots.txt запрещает анализ указанной страницы.";
    case "robots_unavailable": return "Не удалось безопасно проверить robots.txt. Попробуй позже.";
    case "private_address": return "Адрес ведёт во внутреннюю или служебную сеть.";
    case "redirect_forbidden": return "Сайт перенаправил crawler за подтверждённый домен.";
    case "crawl_too_large": return "Сайт превысил безопасный лимит анализа.";
    case "no_pages": return "Не удалось получить ни одной публичной HTML-страницы.";
    case "timeout": return "Сайт не ответил в пределах безопасного времени.";
    case "ENOTFOUND": return "DNS не нашёл указанный домен. Проверь адрес сайта и повтори позже.";
    case "EAI_AGAIN": return "DNS сайта временно не ответил. Аврора сможет повторить анализ.";
    case "ECONNREFUSED": return "Сайт отклонил подключение crawler. Проверь доступность HTTPS с сервера.";
    case "ECONNRESET": return "Сайт разорвал соединение во время проверки. Аврора сможет повторить анализ.";
    case "tls_invalid": return "Не удалось подтвердить TLS-сертификат сайта. Анализ небезопасного соединения остановлен.";
    case "ai_usage_limit": return "Лимит ИИ на сегодня исчерпан. Анализ не был списан повторно.";
    case "provider_timeout": return "Аналитическая модель не ответила вовремя. Лимит ИИ не списан.";
    case "network_error": return "Связь с аналитической моделью оборвалась. Лимит ИИ не списан.";
    case "rate_limited": return "Провайдер временно ограничил запросы. Аврора сможет повторить анализ без повторного списания.";
    case "stream_truncated": return "Ответ аналитической модели оборвался до завершения. Лимит ИИ не списан.";
    case "empty_generation": return "Аналитическая модель не вернула результат. Лимит ИИ не списан.";
    case "schema_invalid": return "Ответ аналитика не прошёл проверку доказательств. Лимит ИИ не списан.";
    case "engine_not_connected": return "Аналитическая модель не подключена. Лимит ИИ не списан.";
    case "engine_unsupported": return "Выбранная аналитическая модель не поддерживается. Лимит ИИ не списан.";
    case "analysis_in_progress": return "Этот анализ уже выполняется в другом worker.";
    case "batch_idempotency_conflict": return "Доказательства изменились внутри одного идемпотентного запуска. Запусти новую ревизию анализа.";
    case "quota_commit_failed": return "Не удалось подтвердить лимит вместе с готовым отчётом. Результат не опубликован и лимит не списан.";
    default: return "Не удалось завершить анализ сайта.";
  }
}

function errorCode(error) {
  if (error instanceof SiteCrawlerError && error.code) {
    const code = String(error.code);
    return TLS_ERROR_CODES.has(code) ? "tls_invalid" : code;
  }
  if (error instanceof SiteInterviewWorkerError && SAFE_INTERVIEW_CODES.has(String(error.code))) return String(error.code);
  const candidate = typeof error?.code === "string" ? error.code : "worker_failed";
  return RETRYABLE_CODES.has(candidate) ? candidate : "worker_failed";
}

function publicFailureStage(stage) {
  switch (stage) {
    case "robots": return "Проверка robots.txt";
    case "sitemap": return "Чтение карты сайта";
    case "crawling": return "Загрузка публичных страниц";
    case "extracting": return "Извлечение доказательств";
    case "resolving_entities": return "Связывание сущностей";
    case "answering": return "Аналитическое интервью";
    case "validating": return "Проверка доказательств";
    case "planning": return "Формирование плана";
    case "saving": return "Сохранение результата";
    default: return "Фоновый анализ";
  }
}

function safeTechnicalError(error) {
  const pgCode = typeof error?.code === "string" && /^[0-9A-Z]{5}$/u.test(error.code)
    ? error.code
    : null;
  const constraint = typeof error?.constraint === "string" && /^[a-z0-9_]{1,128}$/u.test(error.constraint)
    ? error.constraint
    : null;
  const errorName = typeof error?.name === "string" ? error.name.slice(0, 80) : "Error";
  return Object.freeze({ pgCode, constraint, errorName });
}

function statusForStage(stage) {
  if (["extracting", "resolving_entities", "researching_external", "answering", "validating"].includes(stage)) return "analyzing";
  if (stage === "planning") return "planning";
  if (stage === "saving") return "saving";
  if (stage === "ready") return "ready";
  return "crawling";
}

function configuredInterviewEngine(dependencies = {}, env = process.env) {
  const candidate = dependencies.engine ?? env.SITE_ANALYSIS_ENGINE ?? env.AI_SEMANTIC_ENGINE;
  return isConfiguredEngineId(candidate) ? candidate : undefined;
}

export async function processSiteAnalysisJob(pool, data, dependencies = {}) {
  const analysisId = Number(data?.analysisId);
  const runRevision = Number(data?.runRevision);
  const leaseToken = dependencies.leaseToken || randomUUID();
  const finalAttempt = dependencies.finalAttempt !== false;
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) throw new Error("site-analysis: bad analysis id");
  if (!Number.isSafeInteger(runRevision) || runRevision <= 0) throw new Error("site-analysis: bad run revision");

  let claimed = await pool.query(
    `update site_analysis_jobs
        set status = 'crawling', stage = 'robots', progress = 1,
            progress_detail = 'Проверяем правила robots.txt', attempts = attempts + 1,
            error_code = null, error_message = null, completed_at = null,
            worker_lease_token = $3, worker_heartbeat_at = now(), updated_at = now()
      where id = $1 and run_revision = $2
        and status in ('queued', 'crawling', 'analyzing', 'planning', 'saving')
        and queue_confirmed_at is not null
      returning id, user_id, request_id, target_url, confirmed_domain, limits, run_revision, created_at, site_id`,
    [analysisId, runRevision, leaseToken],
  );
  if (!claimed.rows[0]) {
    const pending = await pool.query(
      `select status, run_revision, queue_confirmed_at
         from site_analysis_jobs
        where id = $1`,
      [analysisId],
    );
    const state = pending.rows[0];
    if (
      state
      && Number(state.run_revision) === runRevision
      && state.status === "queued"
      && state.queue_confirmed_at
    ) {
      // The producer may have confirmed the durable row between our first claim and
      // the diagnostic read. Claim once more so that this delivery cannot be lost.
      claimed = await pool.query(
        `update site_analysis_jobs
            set status = 'crawling', stage = 'robots', progress = 1,
                progress_detail = 'Проверяем правила robots.txt', attempts = attempts + 1,
                error_code = null, error_message = null, completed_at = null,
                worker_lease_token = $3, worker_heartbeat_at = now(), updated_at = now()
          where id = $1 and run_revision = $2
            and status in ('queued', 'crawling', 'analyzing', 'planning', 'saving')
            and queue_confirmed_at is not null
          returning id, user_id, request_id, target_url, confirmed_domain, limits, run_revision, created_at, site_id`,
        [analysisId, runRevision, leaseToken],
      );
    } else if (
      state
      && Number(state.run_revision) === runRevision
      && state.status === "queued"
      && !state.queue_confirmed_at
    ) {
      if (finalAttempt) {
        await pool.query(
          `update site_analysis_jobs
              set status = 'failed', stage = 'failed', error_code = 'queue_unconfirmed',
                  error_message = $3, progress_detail = null, completed_at = now(), updated_at = now()
            where id = $1 and run_revision = $2 and status = 'queued'
              and queue_confirmed_at is null`,
          [analysisId, runRevision, publicErrorMessage("queue_unconfirmed")],
        );
      }
      const error = new Error(publicErrorMessage("queue_unconfirmed"));
      error.code = "queue_unconfirmed";
      throw error;
    }
  }
  const analysis = claimed.rows[0];
  if (!analysis) return { ok: true, skipped: "stale_or_terminal" };

  const crawl = dependencies.crawl || crawlSite;
  const buildSnapshot = dependencies.buildSnapshot || buildSiteEvidenceSnapshot;
  const interviewRunner = dependencies.runInterview || runSiteInterview;
  const finalizeUsage = dependencies.finalizeUsage || finalizeWorkerAiUsage;
  const persistSiteProfile = dependencies.persistSiteProfile || persistSiteProfileForAnalysis;
  let interviewRun = null;
  let failureStage = "robots";
  const heartbeat = setInterval(() => {
    void pool.query(
      `update site_analysis_jobs set worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status in ('crawling', 'analyzing', 'planning', 'saving')`,
      [analysisId, runRevision, leaseToken],
    ).catch(() => undefined);
  }, 10_000);
  heartbeat.unref?.();
  try {
    const output = await crawl({
      targetUrl: analysis.target_url,
      confirmedDomain: analysis.confirmed_domain,
      consent: true,
      limits: analysis.limits,
    }, {
      onProgress: async ({ stage, progress, detail }) => {
        failureStage = stage;
        if (["analyzing", "planning", "ready"].includes(stage)) return;
        const boundedProgress = Math.min(58, Math.max(1, Number(progress || 0)));
        await pool.query(
          `update site_analysis_jobs
              set status = $4, stage = $5, progress = $6, progress_detail = $7,
                  worker_heartbeat_at = now(), updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $3
              and status not in ('ready', 'failed')`,
          [analysisId, runRevision, leaseToken, statusForStage(stage), stage, boundedProgress, String(detail || "").slice(0, 300)],
        );
      },
    });

    await pool.query(
      `update site_analysis_jobs
          set status = 'analyzing', stage = 'extracting', progress = 60,
              progress_detail = 'Нормализуем источники и доказательства',
              worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status not in ('ready', 'failed')`,
      [analysisId, runRevision, leaseToken],
    );
    failureStage = "extracting";
    const snapshot = buildSnapshot({
      confirmedDomain: analysis.confirmed_domain,
      pages: output.pages,
      checkedAt: analysis.created_at || new Date().toISOString(),
      coverageMode: "site_only",
    });
    failureStage = "resolving_entities";
    await pool.query(
      `update site_analysis_jobs
          set status = 'analyzing', stage = 'resolving_entities', progress = 64,
              progress_detail = 'Связываем организацию, экспертов, продукты и события',
              snapshot_hash = $4, prompt_version = $5, question_catalog_version = $6,
              coverage_mode = 'site_only', question_count = $7,
              worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status not in ('ready', 'failed')`,
      [
        analysisId,
        runRevision,
        leaseToken,
        snapshot.snapshotHash,
        SITE_OSINT_PROMPT_VERSION,
        SITE_INTERVIEW_CATALOG_VERSION,
        SITE_INTERVIEW_QUESTIONS.length,
      ],
    );
    interviewRun = await interviewRunner(pool, {
      analysisId,
      runRevision,
      userId: Number(analysis.user_id),
      requestId: analysis.request_id,
      snapshot,
      engine: configuredInterviewEngine(dependencies),
    }, {
      completeAiText: dependencies.completeAiText || completeAiText,
      onProgress: async ({ progress, detail }) => {
        failureStage = "answering";
        await pool.query(
          `update site_analysis_jobs
              set status = 'analyzing', stage = 'answering', progress = $4,
                  progress_detail = $5, worker_heartbeat_at = now(), updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $3
              and status not in ('ready', 'failed')`,
          [analysisId, runRevision, leaseToken, Math.min(89, Math.max(66, Number(progress || 66))), String(detail || "").slice(0, 300)],
        );
      },
      telemetry: dependencies.telemetry,
    });
    failureStage = "validating";
    await pool.query(
      `update site_analysis_jobs
          set status = 'analyzing', stage = 'validating', progress = 91,
              progress_detail = 'Проверяем полноту интервью и ссылки на доказательства',
              worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status not in ('ready', 'failed')`,
      [analysisId, runRevision, leaseToken],
    );
    const osintReport = interviewRun.report;
    if (osintReport?.reportStatus !== "complete" || osintReport?.answers?.length !== SITE_INTERVIEW_QUESTIONS.length) {
      throw new SiteInterviewWorkerError("schema_invalid", "Интервью не содержит полного набора ответов.");
    }
    await pool.query(
      `update site_analysis_jobs
          set status = 'planning', stage = 'planning', progress = 94,
              progress_detail = 'Собираем доказательный план продвижения',
              worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status not in ('ready', 'failed')`,
      [analysisId, runRevision, leaseToken],
    );
    failureStage = "planning";

    const terminalProjection = {
      ...output.report,
      osint: osintReport,
      snapshot,
    };

    await pool.query(
      `update site_analysis_jobs
          set status = 'saving', stage = 'saving', progress = 97,
              progress_detail = 'Сохраняем полный проверенный срез',
              worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status not in ('ready', 'failed')`,
      [analysisId, runRevision, leaseToken],
    );
    failureStage = "saving";

    const client = await pool.connect();
    try {
      await client.query("begin");
      const current = await client.query(
        `select status, run_revision, worker_lease_token from site_analysis_jobs where id = $1 for update`,
        [analysisId],
      );
      const state = current.rows[0];
      if (
        !state
        || Number(state.run_revision) !== runRevision
        || state.worker_lease_token !== leaseToken
        || state.status === "failed"
        || state.status === "ready"
      ) {
        await client.query("rollback");
        return { ok: true, skipped: "superseded" };
      }
      await client.query(`delete from site_analysis_pages where analysis_id = $1`, [analysisId]);
      const storedUrls = new Set();
      for (const page of output.pages) {
        if (storedUrls.has(page.url)) continue;
        storedUrls.add(page.url);
        await client.query(
          `insert into site_analysis_pages
             (analysis_id, url, http_status, title, description, headings, main_content,
              schema_types, links, ctas, forms, public_comments, technical)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10::jsonb,
                   $11::jsonb, $12::jsonb, $13::jsonb)`,
          [
            analysisId,
            page.url,
            Number(page.status || 0),
            page.title || null,
            page.description || null,
            JSON.stringify(page.headings || []),
            page.mainContent || null,
            page.schemaTypes || [],
            JSON.stringify(page.links || []),
            JSON.stringify(page.ctas || []),
            JSON.stringify(page.forms || []),
            JSON.stringify(page.publicComments || []),
            JSON.stringify({ ...(page.technical || {}), metadata: page.metadata || {} }),
          ],
        );
      }

      const sourceIds = new Map();
      for (const source of snapshot.sources) {
        const stored = await client.query(
          `insert into site_analysis_sources
             (analysis_id, run_revision, source_key, source_kind, url, title, page_type,
              is_primary, published_at, modified_at, checked_at, quality, content_hash, metadata)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb)
           on conflict (analysis_id, run_revision, source_key) do update
             set source_kind = excluded.source_kind, url = excluded.url, title = excluded.title,
                 page_type = excluded.page_type, is_primary = excluded.is_primary,
                 published_at = excluded.published_at, modified_at = excluded.modified_at,
                 checked_at = excluded.checked_at, quality = excluded.quality,
                 content_hash = excluded.content_hash, metadata = excluded.metadata
           returning id`,
          [
            analysisId, runRevision, source.id, source.kind, source.url, source.title,
            source.pageType, source.primary, source.publishedAt, source.modifiedAt,
            source.checkedAt, source.quality, source.contentHash,
            JSON.stringify({ snapshotVersion: snapshot.version }),
          ],
        );
        sourceIds.set(source.id, Number(stored.rows[0].id));
      }
      for (const evidence of snapshot.evidence) {
        const sourceId = sourceIds.get(evidence.sourceId);
        if (!sourceId) throw new SiteInterviewWorkerError("schema_invalid", "Доказательство ссылается на отсутствующий источник.");
        await client.query(
          `insert into site_analysis_evidence
             (analysis_id, run_revision, source_id, evidence_key, evidence_hash,
              evidence_type, fact_type, value, extracted_by, quality, currentness,
              checked_at, published_at, injection_signal)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14)
           on conflict (analysis_id, run_revision, evidence_key) do update
             set source_id = excluded.source_id, evidence_hash = excluded.evidence_hash,
                 evidence_type = excluded.evidence_type, fact_type = excluded.fact_type,
                 value = excluded.value, extracted_by = excluded.extracted_by,
                 quality = excluded.quality, currentness = excluded.currentness,
                 checked_at = excluded.checked_at, published_at = excluded.published_at,
                 injection_signal = excluded.injection_signal`,
          [
            analysisId, runRevision, sourceId, evidence.id, evidence.hash,
            evidence.type, evidence.factType, JSON.stringify(evidence.value),
            evidence.extractedBy, evidence.quality, evidence.currentness,
            evidence.checkedAt, evidence.publishedAt, evidence.injectionSignal,
          ],
        );
      }
      for (const entity of snapshot.entities) {
        await client.query(
          `insert into site_analysis_entities
             (analysis_id, run_revision, entity_key, entity_type, canonical_key, name,
              attributes, evidence_keys, confidence)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9)
           on conflict (analysis_id, run_revision, entity_key) do update
             set entity_type = excluded.entity_type, canonical_key = excluded.canonical_key,
                 name = excluded.name, attributes = excluded.attributes,
                 evidence_keys = excluded.evidence_keys, confidence = excluded.confidence`,
          [
            analysisId, runRevision, entity.id, entity.type, entity.canonicalKey, entity.name,
            JSON.stringify(entity.attributes || {}), JSON.stringify(entity.evidenceIds || []), entity.confidence,
          ],
        );
      }
      for (const relation of snapshot.relations) {
        await client.query(
          `insert into site_analysis_relations
             (analysis_id, run_revision, relation_key, from_entity_key, to_entity_key,
              relation_type, relation_status, valid_from, valid_to, evidence_keys, confidence)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11)
           on conflict (analysis_id, run_revision, relation_key) do update
             set from_entity_key = excluded.from_entity_key, to_entity_key = excluded.to_entity_key,
                 relation_type = excluded.relation_type, relation_status = excluded.relation_status,
                 valid_from = excluded.valid_from, valid_to = excluded.valid_to,
                 evidence_keys = excluded.evidence_keys, confidence = excluded.confidence`,
          [
            analysisId, runRevision, relation.id, relation.fromEntityId, relation.toEntityId,
            relation.type, relation.status, relation.validFrom, relation.validTo,
            JSON.stringify(relation.evidenceIds || []), relation.confidence,
          ],
        );
      }
      const questionVersions = new Map(SITE_INTERVIEW_QUESTIONS.map((question) => [question.id, question.version]));
      for (const answer of osintReport.answers) {
        await client.query(
          `insert into site_analysis_answers
             (analysis_id, run_revision, question_id, question_version, status,
              short_answer, explanation, facts, evidence_keys, confidence,
              contradictions, gaps, required_integrations, recommendation_hooks)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10,
                   $11::jsonb, $12::jsonb, $13::jsonb, $14::jsonb)
           on conflict (analysis_id, run_revision, question_id) do update
             set question_version = excluded.question_version, status = excluded.status,
                 short_answer = excluded.short_answer, explanation = excluded.explanation,
                 facts = excluded.facts, evidence_keys = excluded.evidence_keys,
                 confidence = excluded.confidence, contradictions = excluded.contradictions,
                 gaps = excluded.gaps, required_integrations = excluded.required_integrations,
                 recommendation_hooks = excluded.recommendation_hooks`,
          [
            analysisId, runRevision, answer.questionId, questionVersions.get(answer.questionId),
            answer.status, answer.shortAnswer, answer.explanation, JSON.stringify(answer.facts),
            JSON.stringify(answer.evidenceIds), answer.confidence,
            JSON.stringify(answer.contradictions), JSON.stringify(answer.gaps),
            JSON.stringify(answer.requiredIntegrations), JSON.stringify(answer.recommendationHooks),
          ],
        );
      }
      for (const recommendation of osintReport.recommendations || []) {
        await client.query(
          `insert into site_analysis_recommendations
             (analysis_id, run_revision, recommendation_key, question_id, kind,
              rationale, confidence, entity_keys, evidence_keys)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
           on conflict (analysis_id, run_revision, recommendation_key) do update
             set question_id = excluded.question_id, kind = excluded.kind,
                 rationale = excluded.rationale, confidence = excluded.confidence,
                 entity_keys = excluded.entity_keys, evidence_keys = excluded.evidence_keys`,
          [
            analysisId, runRevision, recommendation.key, recommendation.questionId,
            recommendation.kind, recommendation.rationale, recommendation.confidence,
            JSON.stringify(recommendation.entityIds || []), JSON.stringify(recommendation.evidenceIds || []),
          ],
        );
      }
      const completed = await client.query(
        `update site_analysis_jobs
            set status = 'ready', stage = 'ready', progress = 100,
                progress_detail = 'OSINT-интервью и маркетинговый план готовы', result = $3::jsonb,
                prompt_version = $5, question_catalog_version = $6,
                snapshot_hash = $7, coverage_mode = 'site_only',
                answered_count = $8, question_count = $9,
                ai_usage_reservation_id = $10,
                error_code = null, error_message = null, completed_at = now(),
                worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
          where id = $1 and run_revision = $2 and worker_lease_token = $4
            and status not in ('ready', 'failed')
          returning id`,
        [
          analysisId, runRevision, JSON.stringify(terminalProjection), leaseToken,
          SITE_OSINT_PROMPT_VERSION, SITE_INTERVIEW_CATALOG_VERSION, snapshot.snapshotHash,
          osintReport.answers.length, SITE_INTERVIEW_QUESTIONS.length, interviewRun.reservationId,
        ],
      );
      if (!completed.rows[0]) {
        await client.query("rollback");
        await interviewRun.release?.();
        return { ok: true, skipped: "superseded" };
      }
      // Прогон от имени сайта достраивает профиль и отчёт в той же транзакции:
      // «готово» без профиля пользователь увидеть не должен.
      const siteProfile = analysis.site_id
        ? await persistSiteProfile(client, {
          analysisId,
          runRevision,
          siteId: Number(analysis.site_id),
          pages: output.pages,
          report: output.report,
          snapshotHash: snapshot.snapshotHash,
          checkedAt: analysis.created_at || new Date().toISOString(),
        })
        : null;
      const quota = await finalizeUsage(
        client,
        Number(analysis.user_id),
        Number(interviewRun.reservationId),
        "committed",
      );
      if (quota?.status !== "committed") {
        throw new SiteInterviewWorkerError("quota_commit_failed", "Quota commit did not reach committed state.", { retryable: true });
      }
      await client.query("commit");
      return {
        ok: true,
        analysisId,
        requestId: analysis.request_id,
        pages: storedUrls.size,
        questions: osintReport.answers.length,
        snapshotHash: snapshot.snapshotHash,
        siteProfile,
      };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      await interviewRun?.release?.();
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code = errorCode(error);
    const technical = safeTechnicalError(error);
    const retry = !finalAttempt && (RETRYABLE_CODES.has(code) || error?.retryable === true);
    await pool.query(
      retry
        ? `update site_analysis_jobs
              set status = 'queued', stage = 'queued', progress_detail = 'Временная ошибка — повторяем анализ автоматически',
                  error_code = null, error_message = null,
                  worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $3 and status <> 'ready'`
        : `update site_analysis_jobs
              set status = 'failed', stage = 'failed', error_code = $3, error_message = $4,
                  progress_detail = $5, completed_at = now(),
                  worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $6 and status <> 'ready'`,
      retry
        ? [analysisId, runRevision, leaseToken]
        : [analysisId, runRevision, code, publicErrorMessage(code), `Этап остановки: ${publicFailureStage(failureStage)}`, leaseToken],
    );
    const wrapped = new Error(publicErrorMessage(code));
    wrapped.code = code;
    wrapped.technical = technical;
    throw wrapped;
  } finally {
    clearInterval(heartbeat);
  }
}

export function createSiteAnalysisWorker({ connection, pool, concurrency = 1 }) {
  const worker = new Worker(
    SITE_ANALYSIS_QUEUE,
    async (job) => processSiteAnalysisJob(pool, job.data, {
      finalAttempt: job.attemptsMade + 1 >= Number(job.opts.attempts || 1),
    }),
    { connection, concurrency },
  );
  worker.on("ready", () => console.log("[site-analysis] очередь анализа сайтов слушается"));
  worker.on("failed", (job, error) => console.error("[site-analysis] job failed", {
    analysisId: job?.data?.analysisId || job?.id || null,
    requestId: job?.data?.requestId || null,
    code: error?.code || error?.name || "worker_failed",
    pgCode: error?.technical?.pgCode || null,
    constraint: error?.technical?.constraint || null,
    errorName: error?.technical?.errorName || error?.name || "Error",
  }));
  worker.on("error", (error) => console.error("[site-analysis] queue error", {
    errorName: error?.name || "Error",
  }));
  return worker;
}
