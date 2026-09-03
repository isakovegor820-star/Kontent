import { NextRequest, NextResponse } from "next/server";

import { renderSiteReportExport, SITE_REPORT_EXPORT_FORMATS } from "@/lib/site-report/export.mjs";
import type { SiteReportRow } from "@/lib/sites/service";

import { jsonWithRequest, parseSiteId, requireSite, resolveSiteRoute, siteErrorResponse } from "../../../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string; reportId: string }> };

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/reports/:reportId/export GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  const params = await context.params;
  const reportId = parseSiteId(params.reportId);
  const format = req.nextUrl.searchParams.get("format") || "";
  if (!reportId || !(SITE_REPORT_EXPORT_FORMATS as readonly string[]).includes(format)) {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  try {
    const found = await requireSite(resolved.context, params.id);
    if (!found.ok) return found.response;
    const queried = await pool.query<SiteReportRow>(
      `select id, site_id, kind, profile_id, previous_report_id, payload, summary_ru, status, created_at
         from site_reports
        where id = $1 and site_id = $2 and status = 'ready'`,
      [reportId, found.site.id],
    );
    const row = queried.rows[0];
    if (!row || !row.payload) return jsonWithRequest({ error: "not_found" }, 404, requestId);
    const rendered = await renderSiteReportExport(format, { payload: row.payload, summaryRu: row.summary_ru });
    const filename = `aurora-site-${found.site.confirmed_domain}-${row.kind}-${reportId}.${rendered.extension}`;
    return new NextResponse(new Uint8Array(rendered.bytes), {
      status: 200,
      headers: {
        "content-type": rendered.contentType,
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/reports/:reportId/export GET", requestId);
  }
}
