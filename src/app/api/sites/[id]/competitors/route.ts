import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  addSiteCompetitor,
  listSiteCompetitors,
  removeSiteCompetitor,
} from "@/lib/sites/competitors-service";
import { SITE_COMPETITOR_LIMIT } from "@/lib/site-competitors/summary.mjs";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/** Конкуренты сайта: до трёх доменов, обход — тем же безопасным обходчиком. */
async function handleGET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/competitors GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const competitors = await listSiteCompetitors(pool, Number(found.site.id));
    return jsonWithRequest({ ok: true, competitors, limit: SITE_COMPETITOR_LIMIT }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/competitors GET", requestId);
  }
}

async function handlePUT(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id/competitors PUT" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;

  const rate = await checkRateLimit(`site:competitors:user:${userId}`, 30, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const result = await addSiteCompetitor(pool, {
      siteId: Number(found.site.id),
      projectId,
      userId,
      url: body.url,
    });
    return jsonWithRequest(
      { ok: true, created: result.created, competitor: result.competitor, limit: SITE_COMPETITOR_LIMIT },
      result.created ? 201 : 200,
      requestId,
    );
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/competitors PUT", requestId);
  }
}

async function handleDELETE(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id/competitors DELETE" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId } = resolved.context;

  const rate = await checkRateLimit(`site:competitors:user:${userId}`, 30, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  const id = Number(new URL(req.url).searchParams.get("id"));
  if (!Number.isSafeInteger(id) || id <= 0) return jsonWithRequest({ error: "bad_request" }, 400, requestId);

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    await removeSiteCompetitor(pool, { siteId: Number(found.site.id), id });
    return jsonWithRequest({ ok: true }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/competitors DELETE", requestId);
  }
}

export const GET = withProjectRoute(handleGET);
export const PUT = withProjectRoute(handlePUT);
export const DELETE = withProjectRoute(handleDELETE);
