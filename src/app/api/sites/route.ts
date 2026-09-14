import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { normalizeSiteAnalysisKey } from "@/lib/site-analysis";
import { SiteCrawlerError } from "@/lib/site-crawler.mjs";
import {
  createSite,
  listSitesForProject,
  loadSiteDetails,
  normalizeSiteInput,
  startSiteAnalysis,
} from "@/lib/sites/service";

import { jsonWithRequest, resolveSiteRoute, siteErrorResponse } from "./_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites GET" });
  if (!resolved.ok) return resolved.response;
  const { pool, projectId, requestId } = resolved.context;
  try {
    const sites = await listSitesForProject(pool, projectId);
    return jsonWithRequest({ sites }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites GET", requestId);
  }
}

/**
 * Подключает сайт к проекту и сразу запускает первый анализ. Домен ещё не подтверждён —
 * это ограничивает только публикацию (этап 2), а стартовый аудит публичных страниц
 * доступен любому участнику проекта с правом создавать контент.
 */
export async function POST(req: NextRequest) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites POST" });
  if (!resolved.ok) return resolved.response;
  const { pool, projectId, userId, requestId } = resolved.context;

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  const clientKey = normalizeSiteAnalysisKey(req.headers.get("idempotency-key") || body.clientKey);
  if (!clientKey) return jsonWithRequest({ error: "idempotency_key_required" }, 400, requestId);

  let normalized: ReturnType<typeof normalizeSiteInput>;
  try {
    normalized = normalizeSiteInput(body.url, body.consent);
  } catch (error) {
    const code = error instanceof SiteCrawlerError ? error.code : "bad_request";
    return jsonWithRequest({ error: code }, 422, requestId);
  }

  try {
    const { site, created } = await createSite(pool, { projectId, userId, ...normalized });
    let analysis: Awaited<ReturnType<typeof startSiteAnalysis>> | null = null;
    let analysisError: string | null = null;
    try {
      analysis = await startSiteAnalysis(pool, { site, userId, requestId, clientKey });
    } catch (error) {
      // Сайт уже создан; ошибка запуска анализа не должна прятать карточку сайта.
      if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
        analysisError = error.code;
      } else {
        throw error;
      }
    }
    const details = await loadSiteDetails(pool, site);
    return jsonWithRequest({
      ok: true,
      created,
      ...details,
      latestAnalysis: analysis?.analysis ?? details.latestAnalysis,
      analysisError,
    }, created ? 201 : 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites POST", requestId);
  }
}
