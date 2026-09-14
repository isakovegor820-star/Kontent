import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { normalizeSiteAnalysisKey } from "@/lib/site-analysis";
import { startSiteAnalysis } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Повторный прогон анализа и пересборка профиля сайта. */
export async function POST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/analyze POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId } = resolved.context;

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    body = {};
  }
  const clientKey = normalizeSiteAnalysisKey(req.headers.get("idempotency-key") || body.clientKey);
  if (!clientKey) return jsonWithRequest({ error: "idempotency_key_required" }, 400, requestId);

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (found.site.status === "disconnected") return jsonWithRequest({ error: "site_disconnected" }, 409, requestId);
    const result = await startSiteAnalysis(pool, { site: found.site, userId, requestId, clientKey });
    return jsonWithRequest({ ok: true, replayed: result.replayed, analysis: result.analysis }, result.replayed ? 200 : 202, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/analyze POST", requestId);
  }
}
