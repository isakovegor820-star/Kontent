import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import {
  deleteSite,
  loadSiteDetails,
  serializeSite,
  setSiteStatus,
  updateSiteDomain,
} from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

const SITE_STATUSES = ["active", "paused", "disconnected"] as const;
type SiteStatus = (typeof SITE_STATUSES)[number];

async function handleGET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const details = await loadSiteDetails(pool, found.site);
    return jsonWithRequest({ ok: true, ...details }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id GET", requestId);
  }
}

/**
 * Правка адреса и состояния сайта. Домен — часть личности сайта, поэтому смена
 * адреса сбрасывает подтверждение владения и требует пройти проверку заново.
 */
async function handlePATCH(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id PATCH" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  const hasUrl = typeof body.url === "string" && body.url.trim().length > 0;
  const status = body.status === undefined ? null : String(body.status) as SiteStatus;
  if (!hasUrl && status === null) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  if (status !== null && !SITE_STATUSES.includes(status)) return jsonWithRequest({ error: "bad_request" }, 400, requestId);

  const rate = await checkRateLimit(`site:mutate:user:${userId}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const siteId = Number(found.site.id);

    let site = found.site;
    let domainChanged = false;
    if (hasUrl) {
      const result = await updateSiteDomain(pool, { siteId, projectId, url: body.url });
      site = result.site;
      domainChanged = result.domainChanged;
      if (domainChanged) {
        await writeSiteAudit(pool, {
          projectId, userId, requestId,
          action: "site.domain_updated",
          siteId,
          idempotencyKey: `site-domain:${siteId}:${site.confirmed_domain}`,
          safeData: { domain: site.confirmed_domain },
        });
      }
    }
    if (status !== null && status !== found.site.status) {
      site = await setSiteStatus(pool, { siteId, projectId, status });
      await writeSiteAudit(pool, {
        projectId, userId, requestId,
        action: "site.status_changed",
        siteId,
        idempotencyKey: null,
        safeData: { status },
      });
    }

    return jsonWithRequest({ ok: true, domainChanged, site: serializeSite(site) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id PATCH", requestId);
  }
}

/**
 * Удаление сайта. Прогоны анализа остаются в истории проекта (site_id обнуляется
 * схемой), а профили, материалы, отчёты и зонды удаляются каскадом.
 */
async function handleDELETE(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id DELETE" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;

  const rate = await checkRateLimit(`site:delete:user:${userId}`, 20, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const siteId = Number(found.site.id);
    const domain = found.site.confirmed_domain;
    await deleteSite(pool, { siteId, projectId });
    await writeSiteAudit(pool, {
      projectId, userId, requestId,
      action: "site.deleted",
      siteId,
      idempotencyKey: null,
      safeData: { domain },
    });
    return jsonWithRequest({ ok: true, deleted: true }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id DELETE", requestId);
  }
}

async function writeSiteAudit(pool: Parameters<typeof deleteSite>[0], input: {
  projectId: number;
  userId: number;
  requestId: string;
  action: string;
  siteId: number;
  idempotencyKey: string | null;
  safeData: Record<string, unknown>;
}) {
  await pool.query(
    `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id, idempotency_key)
     values ($1, $2, $3, 'site', $4, $5::jsonb, $6, $7)
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      input.projectId, input.userId, input.action, String(input.siteId),
      JSON.stringify(input.safeData), input.requestId, input.idempotencyKey,
    ],
  ).catch(() => undefined);
}

export const GET = withProjectRoute(handleGET);
export const PATCH = withProjectRoute(handlePATCH);
export const DELETE = withProjectRoute(handleDELETE);
