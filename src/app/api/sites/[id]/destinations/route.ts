import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { isSiteDestinationKind } from "@/lib/site-destinations/index.mjs";
import {
  disconnectSiteDestination,
  listSiteDestinations,
  serializeSiteDestination,
  upsertSiteDestination,
} from "@/lib/sites/destinations-service";
import { SiteServiceError } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.read", { label: "/api/sites/:id/destinations GET" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool } = resolved.context;
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const rows = await listSiteDestinations(pool, Number(found.site.id));
    return jsonWithRequest({ destinations: rows.map(serializeSiteDestination) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/destinations GET", requestId);
  }
}

/**
 * Настройка назначения требует права управлять проектом: учётные данные CMS — это доступ
 * к чужому сайту, а не обычное создание контента.
 */
export async function PUT(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id/destinations PUT" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  if (!isSiteDestinationKind(body.kind)) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const { row, verification } = await upsertSiteDestination(client, {
        site: found.site,
        userId,
        kind: body.kind,
        baseUrl: body.baseUrl,
        credentials: body.credentials,
        sectionPath: body.sectionPath,
      });
      await client.query(
        `insert into audit_events
           (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id)
         values ($1, $2, 'site.destination.configured', 'site_destination', $3, $4::jsonb, $5)`,
        [projectId, userId, String(row.id), JSON.stringify({ siteId: Number(found.site.id), kind: row.kind, baseUrl: row.base_url }), requestId],
      );
      await client.query("commit");
      return jsonWithRequest({
        ok: true,
        destination: serializeSiteDestination(row),
        verification: { ok: verification.ok, reason: verification.reason, account: verification.account ?? null },
      }, 200, requestId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    if (error instanceof SiteServiceError && "verification" in error) {
      return jsonWithRequest({ error: error.code, verification: (error as { verification: unknown }).verification }, error.status, requestId);
    }
    return siteErrorResponse(error, "/api/sites/:id/destinations PUT", requestId);
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id/destinations DELETE" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;
  const kind = req.nextUrl.searchParams.get("kind");
  if (!isSiteDestinationKind(kind)) return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const row = await disconnectSiteDestination(pool, Number(found.site.id), kind);
    if (!row) return jsonWithRequest({ error: "not_found" }, 404, requestId);
    await pool.query(
      `insert into audit_events (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id)
       values ($1, $2, 'site.destination.disconnected', 'site_destination', $3, $4::jsonb, $5)`,
      [projectId, userId, String(row.id), JSON.stringify({ siteId: Number(found.site.id), kind }), requestId],
    );
    return jsonWithRequest({ ok: true, destination: serializeSiteDestination(row) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/destinations DELETE", requestId);
  }
}
