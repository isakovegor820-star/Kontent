import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";

import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { normalizeSiteAnalysisKey, serializeSiteAnalysis, type SiteAnalysisRow } from "@/lib/site-analysis";
import { enqueueSiteAnalysis, hasSiteAnalysisWorker } from "@/lib/site-analysis-queue";

export const runtime = "nodejs";

const FIELDS = `id, request_id, target_url, confirmed_domain, status, stage, progress,
  progress_detail, limits, result, error_code, error_message, attempts, run_revision,
  queue_confirmed_at, created_at, updated_at, completed_at, last_retry_key`;

function reply(body: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json({ ...body, requestId }, { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return reply({ error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(req);
  if (!user) return reply({ error: "unauthorized" }, 401, requestId);
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) return reply({ error: "bad_id" }, 400, requestId);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return reply({ error: "bad_request" }, 400, requestId);
  }
  const retryKey = normalizeSiteAnalysisKey(req.headers.get("idempotency-key") || body.clientKey);
  if (!retryKey) return reply({ error: "idempotency_key_required" }, 400, requestId);

  const pool = getPool();
  let client: PoolClient;
  try {
    client = await pool.connect();
  } catch (error) {
    console.error("[/api/site-analysis/:id/retry] connect", { requestId, analysisId: id, errorName: error instanceof Error ? error.name : "Error" });
    return reply({ error: "unavailable" }, 503, requestId);
  }
  let row: (SiteAnalysisRow & { last_retry_key?: string | null }) | null = null;
  let replayed = false;
  try {
    await client.query("begin");
    const current = await client.query<SiteAnalysisRow & { last_retry_key: string | null }>(
      `select ${FIELDS} from site_analysis_jobs where id = $1 and user_id = $2 for update`,
      [id, user.id],
    );
    row = current.rows[0] || null;
    if (!row) {
      await client.query("rollback");
      return reply({ error: "not_found" }, 404, requestId);
    }
    if (row.last_retry_key === retryKey || row.status !== "failed") {
      replayed = true;
      await client.query("commit");
    } else {
      if (!(await hasSiteAnalysisWorker())) {
        await client.query("rollback");
        return reply({ error: "worker_unavailable" }, 503, requestId);
      }
      const updated = await client.query<SiteAnalysisRow & { last_retry_key: string | null }>(
        `update site_analysis_jobs
            set status = 'queued', stage = 'queued', progress = 0,
                progress_detail = 'Повторный анализ поставлен в очередь', result = null,
                error_code = null, error_message = null, completed_at = null,
                queue_confirmed_at = null, worker_lease_token = null,
                worker_heartbeat_at = null, run_revision = run_revision + 1,
                last_retry_key = $3, updated_at = now()
          where id = $1 and user_id = $2
          returning ${FIELDS}`,
        [id, user.id, retryKey],
      );
      row = updated.rows[0];
      await client.query("commit");
    }
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    console.error("[/api/site-analysis/:id/retry] POST", { requestId, analysisId: id, errorName: error instanceof Error ? error.name : "Error" });
    return reply({ error: "unavailable" }, 503, requestId);
  } finally {
    client.release();
  }

  if (!row) return reply({ error: "unavailable" }, 503, requestId);
  if (replayed) {
    const terminal = row.status === "ready" || row.status === "failed";
    return reply({ ok: true, replayed: true, analysis: serializeSiteAnalysis(row, row.status === "ready") }, terminal ? 200 : 202, row.request_id);
  }
  try {
    await enqueueSiteAnalysis({ analysisId: Number(row.id), requestId: row.request_id, runRevision: Number(row.run_revision) });
    const confirmed = await pool.query<SiteAnalysisRow>(
      `update site_analysis_jobs set queue_confirmed_at = now(), updated_at = now()
        where id = $1 and user_id = $2 and status = 'queued' and run_revision = $3
        returning ${FIELDS}`,
      [id, user.id, row.run_revision],
    );
    row = confirmed.rows[0] || row;
    return reply({ ok: true, replayed: false, analysis: serializeSiteAnalysis(row) }, 202, row.request_id);
  } catch {
    const failed = await pool.query<SiteAnalysisRow>(
      `update site_analysis_jobs
          set status = 'failed', stage = 'failed', error_code = 'queue_unavailable',
              error_message = 'Фоновый анализ временно недоступен.', completed_at = now(), updated_at = now()
        where id = $1 and user_id = $2 and status = 'queued' and run_revision = $3
        returning ${FIELDS}`,
      [id, user.id, row.run_revision],
    );
    row = failed.rows[0] || row;
    return reply({ error: "queue_unavailable", analysis: serializeSiteAnalysis(row) }, 503, row.request_id);
  }
}
