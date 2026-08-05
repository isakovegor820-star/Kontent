import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { serializeSiteAnalysis, type SiteAnalysisRow } from "@/lib/site-analysis";

export const runtime = "nodejs";

export async function GET(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  const id = Number((await context.params).id);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return NextResponse.json({ error: "bad_id", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  try {
    const result = await getPool().query<SiteAnalysisRow>(
      `select id, request_id, target_url, confirmed_domain, status, stage, progress,
              progress_detail, limits, result, error_code, error_message, attempts,
              run_revision, queue_confirmed_at, created_at, updated_at, completed_at,
              prompt_version, question_catalog_version, snapshot_hash, coverage_mode,
              answered_count, question_count
         from site_analysis_jobs
        where id = $1 and user_id = $2`,
      [id, user.id],
    );
    const row = result.rows[0];
    if (!row) return NextResponse.json({ error: "not_found", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    return NextResponse.json({
      ok: true,
      requestId: row.request_id,
      analysis: serializeSiteAnalysis(row, row.status === "ready"),
    }, { headers: { "x-request-id": row.request_id, "cache-control": "no-store" } });
  } catch (error) {
    console.error("[/api/site-analysis/:id] GET", { requestId, analysisId: id, errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "unavailable", requestId }, { status: 503, headers: { "x-request-id": requestId } });
  }
}
