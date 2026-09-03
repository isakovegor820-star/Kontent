import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { enqueueSiteArticleJob, hasSiteArticlesWorker } from "@/lib/site-articles-queue";
import { createManualArticle, listSiteArticles, serializeSiteArticle } from "@/lib/sites/articles-service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const STATUSES = new Set(["draft", "generating", "needs_review", "approved", "scheduled", "publishing", "published", "failed", "rejected", "retired"]);

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/articles GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  const status = req.nextUrl.searchParams.get("status");
  if (status && !STATUSES.has(status)) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const rows = await listSiteArticles(pool, Number(found.site.id), status);
    return jsonWithRequest({ articles: rows.map((row) => serializeSiteArticle(row)) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/articles GET", requestId);
  }
}

/**
 * Ручной материал (origin = manual) или запуск планирования (`{"plan": true}`).
 * Генерация всегда идёт через worker: у API нет права тратить ИИ-бюджет напрямую.
 */
export async function POST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/articles POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId } = resolved.context;
  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    if (!found.site.latest_profile_id) return jsonWithRequest({ error: "profile_required" }, 409, requestId);
    if (!(await hasSiteArticlesWorker())) return jsonWithRequest({ error: "worker_unavailable" }, 503, requestId);
    if (body.plan === true) {
      await enqueueSiteArticleJob("plan", { siteId: Number(found.site.id) }, { jobId: `site-articles-plan-${found.site.id}-${Date.now()}` });
      return jsonWithRequest({ ok: true, planned: true }, 202, requestId);
    }
    const row = await createManualArticle(pool, { site: found.site, userId, articleType: body.articleType, brief: body.brief, title: body.title });
    await enqueueSiteArticleJob("generate", { articleId: Number(row.id) });
    return jsonWithRequest({ ok: true, article: serializeSiteArticle(row) }, 202, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/articles POST", requestId);
  }
}
