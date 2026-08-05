import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  normalizeSiteAnalysisKey,
  serializeSiteAnalysis,
  siteAnalysisFingerprint,
  type SiteAnalysisRow,
} from "@/lib/site-analysis";
import {
  enqueueSiteAnalysis,
  hasSiteAnalysisWorker,
} from "@/lib/site-analysis-queue";
import {
  SiteCrawlerError,
  normalizeSiteLimits,
  normalizeSiteTarget,
} from "@/lib/site-crawler.mjs";

export const runtime = "nodejs";

const SELECT_FIELDS = `id, request_id, target_url, confirmed_domain, status, stage,
  progress, progress_detail, limits, result, error_code, error_message, attempts,
  run_revision, queue_confirmed_at, created_at, updated_at, completed_at,
  prompt_version, question_catalog_version, snapshot_hash, coverage_mode,
  answered_count, question_count`;

function jsonWithRequest(body: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return jsonWithRequest({ error: "unauthorized" }, 401, requestId);
  try {
    const rows = await getPool().query<SiteAnalysisRow>(
      `select ${SELECT_FIELDS}
         from site_analysis_jobs
        where user_id = $1
        order by created_at desc
        limit 25`,
      [user.id],
    );
    return jsonWithRequest({ analyses: rows.rows.map((row) => serializeSiteAnalysis(row)) }, 200, requestId);
  } catch (error) {
    console.error("[/api/site-analysis] GET", { requestId, errorName: error instanceof Error ? error.name : "Error" });
    return jsonWithRequest({ error: "unavailable" }, 503, requestId);
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return jsonWithRequest({ error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(req);
  if (!user) return jsonWithRequest({ error: "unauthorized" }, 401, requestId);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  const key = normalizeSiteAnalysisKey(req.headers.get("idempotency-key") || body.clientKey);
  if (!key) return jsonWithRequest({ error: "idempotency_key_required" }, 400, requestId);

  let target: URL;
  let limits;
  try {
    target = normalizeSiteTarget(body.url, body.confirmedDomain, body.consent);
    limits = normalizeSiteLimits(body.limits as Record<string, unknown> | undefined);
  } catch (error) {
    const code = error instanceof SiteCrawlerError ? error.code : "bad_request";
    return jsonWithRequest({ error: code }, 422, requestId);
  }
  const confirmedDomain = target.hostname.toLowerCase();
  const fingerprint = siteAnalysisFingerprint({
    targetUrl: target.toString(),
    confirmedDomain,
    limits,
  });
  const pool = getPool();

  try {
    const existing = await pool.query<SiteAnalysisRow & { request_fingerprint: string }>(
      `select ${SELECT_FIELDS}, request_fingerprint
         from site_analysis_jobs
        where user_id = $1 and idempotency_key = $2`,
      [user.id, key],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.request_fingerprint !== fingerprint) {
        return jsonWithRequest({ error: "idempotency_conflict" }, 409, requestId);
      }
      const persistedRequestId = row.request_id;
      return jsonWithRequest({
        ok: true,
        replayed: true,
        analysis: serializeSiteAnalysis(row, row.status === "ready"),
      }, row.status === "ready" || row.status === "failed" ? 200 : 202, persistedRequestId);
    }

    if (!(await hasSiteAnalysisWorker())) {
      return jsonWithRequest({ error: "worker_unavailable" }, 503, requestId);
    }

    const inserted = await pool.query<SiteAnalysisRow>(
      `insert into site_analysis_jobs
         (user_id, request_id, idempotency_key, request_fingerprint, target_url,
          confirmed_domain, consented_at, limits)
       values ($1, $2, $3, $4, $5, $6, now(), $7::jsonb)
       on conflict (user_id, idempotency_key) do nothing
       returning ${SELECT_FIELDS}`,
      [user.id, requestId, key, fingerprint, target.toString(), confirmedDomain, JSON.stringify(limits)],
    );
    let row = inserted.rows[0];
    if (!row) {
      const raced = await pool.query<SiteAnalysisRow & { request_fingerprint: string }>(
        `select ${SELECT_FIELDS}, request_fingerprint
           from site_analysis_jobs
          where user_id = $1 and idempotency_key = $2`,
        [user.id, key],
      );
      const existingRow = raced.rows[0];
      if (!existingRow) throw new Error("site_analysis_insert_race");
      if (existingRow.request_fingerprint !== fingerprint) {
        return jsonWithRequest({ error: "idempotency_conflict" }, 409, requestId);
      }
      const terminal = existingRow.status === "ready" || existingRow.status === "failed";
      return jsonWithRequest({
        ok: true,
        replayed: true,
        analysis: serializeSiteAnalysis(existingRow, existingRow.status === "ready"),
      }, terminal ? 200 : 202, existingRow.request_id);
    }

    try {
      await enqueueSiteAnalysis({
        analysisId: Number(row.id),
        requestId: row.request_id,
        runRevision: Number(row.run_revision),
      });
      const confirmed = await pool.query<SiteAnalysisRow>(
        `update site_analysis_jobs
            set queue_confirmed_at = now(), updated_at = now()
          where id = $1 and user_id = $2 and status = 'queued' and run_revision = $3
          returning ${SELECT_FIELDS}`,
        [row.id, user.id, row.run_revision],
      );
      row = confirmed.rows[0] || row;
    } catch {
      const failed = await pool.query<SiteAnalysisRow>(
        `update site_analysis_jobs
            set status = 'failed', stage = 'failed', error_code = 'queue_unavailable',
                error_message = 'Фоновый анализ временно недоступен.', completed_at = now(), updated_at = now()
          where id = $1 and user_id = $2 and status = 'queued' and run_revision = $3
          returning ${SELECT_FIELDS}`,
        [row.id, user.id, row.run_revision],
      );
      row = failed.rows[0] || row;
      return jsonWithRequest({ error: "queue_unavailable", analysis: serializeSiteAnalysis(row) }, 503, row.request_id);
    }

    return jsonWithRequest({ ok: true, replayed: false, analysis: serializeSiteAnalysis(row) }, 202, row.request_id);
  } catch (error) {
    console.error("[/api/site-analysis] POST", { requestId, errorName: error instanceof Error ? error.name : "Error" });
    return jsonWithRequest({ error: "unavailable" }, 503, requestId);
  }
}
