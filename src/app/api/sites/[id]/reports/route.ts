import { NextRequest } from "next/server";

import { enqueueSiteArticleJob, hasSiteArticlesWorker } from "@/lib/site-articles-queue";
import { serializeSiteReport, type SiteReportRow } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/reports GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const rows = await pool.query<SiteReportRow>(
      `select id, site_id, kind, profile_id, previous_report_id, payload, summary_ru, status, interpretation, interpretation_status, created_at
         from site_reports where site_id = $1 order by created_at desc, id desc limit 36`,
      [found.site.id],
    );
    return jsonWithRequest({ reports: rows.rows.map((row) => serializeSiteReport(row, true)) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/reports GET", requestId);
  }
}

/** Отчёт по запросу за последние 30 дней — собирается worker'ом тем же кодом, что и ежемесячный. */
export async function POST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/reports POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (!found.site.latest_profile_id) return jsonWithRequest({ error: "profile_required" }, 409, requestId);
    if (!(await hasSiteArticlesWorker())) return jsonWithRequest({ error: "worker_unavailable" }, 503, requestId);
    await enqueueSiteArticleJob("report", { siteId: Number(found.site.id) }, { jobId: `site-articles-report-${found.site.id}-${Date.now()}` });
    return jsonWithRequest({ ok: true, queued: true }, 202, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/reports POST", requestId);
  }
}
