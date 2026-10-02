import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { DEFAULT_SITE_CRAWL_LIMITS } from "@/lib/site-crawler.mjs";
import { normalizeSiteAnalysisKey } from "@/lib/site-analysis";
import { startSiteAnalysis } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Повторный прогон анализа и пересборка профиля сайта. */
async function handlePOST(req: NextRequest, context: Context) {
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

  // Обход сайта — самая дорогая операция раздела: без ограничителя один аккаунт
  // может держать очередь занятой бесконечно.
  const rate = await checkRateLimit(`site:analyze:user:${userId}`, 12, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  // Лимит обхода приходит из интерфейса: 20 страниц по умолчанию, до 50 осознанно.
  const requestedPages = Number(body.maxPages);
  const maxPages = Number.isFinite(requestedPages)
    ? Math.min(50, Math.max(1, Math.round(requestedPages)))
    : null;

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (found.site.status === "disconnected") return jsonWithRequest({ error: "site_disconnected" }, 409, requestId);
    const result = await startSiteAnalysis(pool, { site: found.site, userId, requestId, clientKey, maxPages });
    return jsonWithRequest({
      ok: true,
      replayed: result.replayed,
      analysis: result.analysis,
      maxPages: result.analysis.limits?.maxPages ?? maxPages ?? DEFAULT_SITE_CRAWL_LIMITS.maxPages,
    }, result.replayed ? 200 : 202, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/analyze POST", requestId);
  }
}

export const POST = withProjectRoute(handlePOST);
