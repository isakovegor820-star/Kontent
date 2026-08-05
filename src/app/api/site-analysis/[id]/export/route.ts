import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  buildSiteAnalysisExportSnapshot,
  renderSiteAnalysisExport,
  SITE_ANALYSIS_EXPORT_FORMATS,
} from "@/lib/site-analysis/export.mjs";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
type ExportRow = {
  id: string | number;
  request_id: string;
  target_url: string;
  confirmed_domain: string;
  run_revision: string | number;
  result: Record<string, unknown> | null;
  completed_at: Date | string | null;
};

export async function GET(req: NextRequest, context: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized", requestId }, { status: 401, headers: { "x-request-id": requestId } });
  const id = Number((await context.params).id);
  const format = req.nextUrl.searchParams.get("format") || "";
  if (!Number.isSafeInteger(id) || id <= 0 || !SITE_ANALYSIS_EXPORT_FORMATS.includes(format as never)) {
    return NextResponse.json({ error: "bad_request", requestId }, { status: 400, headers: { "x-request-id": requestId } });
  }
  try {
    const queried = await getPool().query<ExportRow>(
      `select id, request_id, target_url, confirmed_domain, run_revision, result, completed_at
         from site_analysis_jobs
        where id = $1 and user_id = $2 and status = 'ready'`,
      [id, user.id],
    );
    const row = queried.rows[0];
    if (!row) return NextResponse.json({ error: "not_found", requestId }, { status: 404, headers: { "x-request-id": requestId } });
    const snapshot = buildSiteAnalysisExportSnapshot({
      analysisId: Number(row.id),
      runRevision: Number(row.run_revision),
      requestId: row.request_id,
      targetUrl: row.target_url,
      confirmedDomain: row.confirmed_domain,
      completedAt: row.completed_at,
      result: row.result,
    });
    const rendered = await renderSiteAnalysisExport(format, snapshot);
    const snapshotHash = (snapshot.analysis as { snapshotHash?: string } | undefined)?.snapshotHash || "";
    const filename = `aurora-site-osint-${id}-r${Number(row.run_revision)}.${rendered.extension}`;
    return new NextResponse(new Uint8Array(rendered.bytes), {
      status: 200,
      headers: {
        "content-type": rendered.contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": row.request_id,
        "x-aurora-snapshot-hash": snapshotHash,
      },
    });
  } catch (error) {
    console.error("[/api/site-analysis/:id/export] GET", {
      requestId,
      analysisId: id,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "unavailable", requestId }, { status: 503, headers: { "x-request-id": requestId } });
  }
}
