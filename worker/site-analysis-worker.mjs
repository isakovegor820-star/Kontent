import { Worker } from "bullmq";
import { randomUUID } from "node:crypto";

import { SiteCrawlerError, crawlSite } from "../src/lib/site-crawler.mjs";

const SITE_ANALYSIS_QUEUE = "site-analysis";

const RETRYABLE_CODES = new Set([
  "queue_unconfirmed",
  "robots_unavailable",
  "timeout",
  "ECONNRESET",
  "ECONNREFUSED",
  "EAI_AGAIN",
  "ENOTFOUND",
  "worker_failed",
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
    default: return "Не удалось завершить анализ сайта.";
  }
}

function errorCode(error) {
  if (error instanceof SiteCrawlerError && error.code) return String(error.code);
  const candidate = typeof error?.code === "string" ? error.code : "worker_failed";
  return RETRYABLE_CODES.has(candidate) ? candidate : "worker_failed";
}

function statusForStage(stage) {
  if (stage === "analyzing") return "analyzing";
  if (stage === "planning") return "planning";
  if (stage === "ready") return "ready";
  return "crawling";
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
        and status in ('queued', 'crawling', 'analyzing', 'planning')
        and queue_confirmed_at is not null
      returning id, user_id, request_id, target_url, confirmed_domain, limits, run_revision`,
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
            and status in ('queued', 'crawling', 'analyzing', 'planning')
            and queue_confirmed_at is not null
          returning id, user_id, request_id, target_url, confirmed_domain, limits, run_revision`,
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
  const heartbeat = setInterval(() => {
    void pool.query(
      `update site_analysis_jobs set worker_heartbeat_at = now(), updated_at = now()
        where id = $1 and run_revision = $2 and worker_lease_token = $3
          and status in ('crawling', 'analyzing', 'planning')`,
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
        if (stage === "ready") return;
        await pool.query(
          `update site_analysis_jobs
              set status = $4, stage = $5, progress = $6, progress_detail = $7,
                  worker_heartbeat_at = now(), updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $3
              and status not in ('ready', 'failed')`,
          [analysisId, runRevision, leaseToken, statusForStage(stage), stage, progress, String(detail || "").slice(0, 300)],
        );
      },
    });

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
            JSON.stringify(page.technical || {}),
          ],
        );
      }
      const completed = await client.query(
        `update site_analysis_jobs
            set status = 'ready', stage = 'ready', progress = 100,
                progress_detail = 'Анализ и маркетинговый план готовы', result = $3::jsonb,
                error_code = null, error_message = null, completed_at = now(),
                worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
          where id = $1 and run_revision = $2 and worker_lease_token = $4
            and status not in ('ready', 'failed')
          returning id`,
        [analysisId, runRevision, JSON.stringify(output.report), leaseToken],
      );
      if (!completed.rows[0]) {
        await client.query("rollback");
        return { ok: true, skipped: "superseded" };
      }
      await client.query("commit");
      return { ok: true, analysisId, requestId: analysis.request_id, pages: storedUrls.size };
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    const code = errorCode(error);
    const retry = !finalAttempt && RETRYABLE_CODES.has(code);
    await pool.query(
      retry
        ? `update site_analysis_jobs
              set status = 'queued', stage = 'queued', progress_detail = 'Сайт временно недоступен — повторяем автоматически',
                  error_code = null, error_message = null,
                  worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $3 and status <> 'ready'`
        : `update site_analysis_jobs
              set status = 'failed', stage = 'failed', error_code = $3, error_message = $4,
                  progress_detail = null, completed_at = now(),
                  worker_lease_token = null, worker_heartbeat_at = null, updated_at = now()
            where id = $1 and run_revision = $2 and worker_lease_token = $5 and status <> 'ready'`,
      retry
        ? [analysisId, runRevision, leaseToken]
        : [analysisId, runRevision, code, publicErrorMessage(code), leaseToken],
    );
    const wrapped = new Error(publicErrorMessage(code));
    wrapped.code = code;
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
  }));
  worker.on("error", (error) => console.error("[site-analysis] queue error", {
    errorName: error?.name || "Error",
  }));
  return worker;
}
