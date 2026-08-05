import {
  aggregateSiteInterviewReport,
  buildSiteInterviewPrompt,
  createSiteInterviewBatches,
  parseAndValidateSiteInterviewBatch,
  siteInterviewProviderKey,
  siteInterviewSemanticKey,
} from "../src/lib/site-analysis/interview.mjs";
import { siteEvidenceHash } from "../src/lib/site-analysis/evidence.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "../src/lib/site-analysis/questions.data.mjs";
import { assertWorkerAiCallPolicy } from "./ai-call-policy.mjs";
import {
  WORKER_AI_RESERVATION_TTL_MS,
  acquireWorkerAiUsage,
  heartbeatWorkerAiUsage,
  releaseWorkerAiUsage,
  workerAiUsageCompositeKey,
} from "./ai-usage-reservation.mjs";

export class SiteInterviewWorkerError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "SiteInterviewWorkerError";
    this.code = String(code || "site_interview_failed");
    this.retryable = options.retryable === true;
    this.details = Array.isArray(options.details) ? options.details.slice(0, 20) : [];
  }
}
function safeProviderCode(error) {
  const code = String(error?.code || "provider_error");
  if (["provider_timeout", "network_error", "rate_limited", "stream_truncated", "empty_generation", "provider_error", "engine_not_connected", "engine_unsupported"].includes(code)) return code;
  return "provider_error";
}

function retryableProviderError(error) {
  return ["provider_timeout", "network_error", "rate_limited", "stream_truncated", "empty_generation"]
    .includes(safeProviderCode(error)) || Number(error?.status || 0) >= 500;
}

async function loadBatch(pool, input) {
  const existing = await pool.query(
    `select status, request_fingerprint, response_payload
       from site_analysis_ai_batches
      where analysis_id = $1 and run_revision = $2 and batch_id = $3`,
    [input.analysisId, input.runRevision, input.batchId],
  );
  const row = existing.rows[0];
  if (row && row.request_fingerprint !== input.requestFingerprint) {
    throw new SiteInterviewWorkerError(
      "batch_idempotency_conflict",
      "Состав доказательств изменился для уже начатого этапа анализа.",
    );
  }
  return row || null;
}

async function claimBatch(pool, input) {
  await pool.query(
    `insert into site_analysis_ai_batches
       (analysis_id, run_revision, batch_id, semantic_key, provider_request_key,
        request_fingerprint, status, attempts, started_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, 'generating', 1, now(), now())
     on conflict (analysis_id, run_revision, batch_id) do update
       set status = 'generating', attempts = site_analysis_ai_batches.attempts + 1,
           error_code = null, started_at = coalesce(site_analysis_ai_batches.started_at, now()),
           updated_at = now()
     where site_analysis_ai_batches.request_fingerprint = excluded.request_fingerprint
       and site_analysis_ai_batches.status <> 'ready'`,
    [
      input.analysisId,
      input.runRevision,
      input.batchId,
      input.semanticKey,
      input.providerRequestKey,
      input.requestFingerprint,
    ],
  );
}

async function saveBatch(pool, input) {
  const result = await pool.query(
    `update site_analysis_ai_batches
        set status = 'ready', engine = $5, response_payload = $6::jsonb,
            error_code = null, completed_at = now(), updated_at = now()
      where analysis_id = $1 and run_revision = $2 and batch_id = $3
        and request_fingerprint = $4 and status = 'generating'
      returning id`,
    [
      input.analysisId,
      input.runRevision,
      input.batchId,
      input.requestFingerprint,
      input.engine,
      JSON.stringify(input.payload),
    ],
  );
  if (!result.rows[0]) throw new SiteInterviewWorkerError("batch_superseded", "Этап анализа был заменён новым запуском.");
}

async function failBatch(pool, input, code) {
  await pool.query(
    `update site_analysis_ai_batches
        set status = 'failed', error_code = $5, completed_at = now(), updated_at = now()
      where analysis_id = $1 and run_revision = $2 and batch_id = $3
        and request_fingerprint = $4 and status <> 'ready'`,
    [input.analysisId, input.runRevision, input.batchId, input.requestFingerprint, code],
  ).catch(() => undefined);
}

export async function runSiteInterview(pool, input, dependencies = {}) {
  const analysisId = Number(input?.analysisId);
  const runRevision = Number(input?.runRevision);
  const userId = Number(input?.userId);
  if (!Number.isSafeInteger(analysisId) || analysisId <= 0) throw new TypeError("site interview worker: invalid analysis id");
  if (!Number.isSafeInteger(runRevision) || runRevision <= 0) throw new TypeError("site interview worker: invalid revision");
  if (!Number.isSafeInteger(userId) || userId <= 0) throw new TypeError("site interview worker: invalid user id");
  if (!input?.snapshot?.snapshotHash) throw new TypeError("site interview worker: snapshot required");

  const acquire = dependencies.acquireUsage || acquireWorkerAiUsage;
  const release = dependencies.releaseUsage || releaseWorkerAiUsage;
  const heartbeat = dependencies.heartbeatUsage || heartbeatWorkerAiUsage;
  const complete = dependencies.completeAiText;
  if (typeof complete !== "function") throw new TypeError("site interview worker: completion dependency required");
  const onProgress = typeof dependencies.onProgress === "function" ? dependencies.onProgress : async () => {};
  const quotaKey = workerAiUsageCompositeKey("site-analysis", [String(analysisId), `r${runRevision}`]);
  const usage = await acquire(pool, {
    userId,
    kind: "site_analysis",
    key: quotaKey,
    ttlMs: dependencies.reservationTtlMs || WORKER_AI_RESERVATION_TTL_MS,
  });
  if (usage.state === "limit") {
    throw new SiteInterviewWorkerError("ai_usage_limit", "Лимит ИИ на сегодня исчерпан.");
  }
  if (usage.state === "in_progress") {
    throw new SiteInterviewWorkerError("analysis_in_progress", "Этот анализ уже выполняется.", { retryable: true });
  }
  const reservationId = Number(usage.reservationId);
  assertWorkerAiCallPolicy("site-analysis-interview", reservationId);
  let released = false;
  const releaseOnce = async () => {
    if (released || usage.state === "committed") return false;
    released = true;
    return release(pool, userId, reservationId);
  };
  const heartbeatTimer = usage.state === "acquired"
    ? setInterval(() => {
        void heartbeat(pool, userId, reservationId, dependencies.reservationTtlMs || WORKER_AI_RESERVATION_TTL_MS).catch(() => undefined);
      }, Math.max(5_000, Math.round((dependencies.reservationTtlMs || WORKER_AI_RESERVATION_TTL_MS) / 3)))
    : null;
  heartbeatTimer?.unref?.();

  try {
    const batches = createSiteInterviewBatches(SITE_INTERVIEW_QUESTIONS, dependencies.maxQuestionsPerBatch || 6);
    const completed = [];
    for (const [index, batch] of batches.entries()) {
      await onProgress({
        batchId: batch.id,
        current: index + 1,
        total: batches.length,
        progress: 66 + Math.round(((index + 1) / batches.length) * 22),
        detail: `Интервью: блок ${index + 1} из ${batches.length}`,
      });
      const prompt = buildSiteInterviewPrompt({
        snapshot: input.snapshot,
        questions: batch.questions,
        batchId: batch.id,
        maxEvidence: dependencies.maxEvidence,
        maxCharacters: dependencies.maxCharacters,
      });
      const keyInput = {
        analysisId,
        runRevision,
        batchId: batch.id,
        snapshotHash: input.snapshot.snapshotHash,
      };
      const semanticKey = siteInterviewSemanticKey(keyInput);
      const providerRequestKey = siteInterviewProviderKey(keyInput);
      const requestFingerprint = siteEvidenceHash({
        system: prompt.system,
        user: prompt.user,
        engine: input.engine || null,
      });
      const identity = { analysisId, runRevision, batchId: batch.id, semanticKey, providerRequestKey, requestFingerprint };
      const stored = await loadBatch(pool, identity);
      if (stored?.status === "ready" && stored.response_payload) {
        const replay = parseAndValidateSiteInterviewBatch(JSON.stringify(stored.response_payload), {
          batchId: batch.id,
          questions: batch.questions,
          evidenceIds: prompt.evidenceIds,
          entityIds: prompt.entityIds,
        });
        if (!replay.ok) throw new SiteInterviewWorkerError("stored_batch_invalid", "Сохранённый этап анализа не прошёл проверку.", { details: replay.errors });
        completed.push(replay.value);
        continue;
      }
      await claimBatch(pool, identity);
      let completion;
      try {
        completion = await complete({
          system: prompt.system,
          user: prompt.user,
          engine: input.engine,
          temperature: 0.1,
          maxTokens: dependencies.maxTokens || 7_000,
          providerRequestKey,
          providerRequestId: input.requestId,
        }, {
          signal: dependencies.signal,
          allowFallback: false,
          timeoutMs: dependencies.timeoutMs || 90_000,
          telemetry: (event) => dependencies.telemetry?.({
            ...event,
            analysisId,
            runRevision,
            batchId: batch.id,
            requestId: input.requestId,
          }),
        });
      } catch (error) {
        const code = safeProviderCode(error);
        await failBatch(pool, identity, code);
        throw new SiteInterviewWorkerError(code, "Провайдер не завершил этап OSINT-интервью.", {
          retryable: retryableProviderError(error),
        });
      }
      const validated = parseAndValidateSiteInterviewBatch(completion.text, {
        batchId: batch.id,
        questions: batch.questions,
        evidenceIds: prompt.evidenceIds,
        entityIds: prompt.entityIds,
      });
      if (!validated.ok) {
        await failBatch(pool, identity, "schema_invalid");
        throw new SiteInterviewWorkerError("schema_invalid", "Ответ аналитика не прошёл формальную проверку.", { details: validated.errors });
      }
      await saveBatch(pool, { ...identity, engine: completion.engine, payload: validated.value });
      completed.push(validated.value);
    }
    const report = aggregateSiteInterviewReport({
      questions: SITE_INTERVIEW_QUESTIONS,
      batches: completed,
      snapshotHash: input.snapshot.snapshotHash,
      coverage: input.snapshot.coverage,
    });
    return Object.freeze({
      report,
      reservationId,
      userId,
      quotaState: usage.state,
      release: releaseOnce,
    });
  } catch (error) {
    await releaseOnce();
    throw error;
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
  }
}
