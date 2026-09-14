import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { normalizeSiteCadence } from "@/lib/site-articles/types.mjs";
import { SITE_FIELDS, serializeSite, type SiteRow } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

/**
 * Настройки сайта: режим публикации, название бренда, квоты. Режим `auto` включается только
 * после серии одобренных без правок материалов (решение 2) — иначе 409.
 */
export async function PATCH(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "project.manage", { mutation: true, label: "/api/sites/:id/settings PATCH" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;
  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return jsonWithRequest({ error: "bad_request" }, 400, requestId);
  }
  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const site = found.site;
    const updates: string[] = [];
    const values: unknown[] = [site.id];
    const changed: Record<string, unknown> = {};

    if (body.publishingMode !== undefined) {
      const mode = String(body.publishingMode);
      if (mode !== "confirm" && mode !== "auto") return jsonWithRequest({ error: "bad_request" }, 400, requestId);
      if (mode === "auto" && Number(site.approved_streak) < Number(site.auto_unlock_streak)) {
        return jsonWithRequest({ error: "auto_mode_locked", approvedStreak: Number(site.approved_streak), required: Number(site.auto_unlock_streak) }, 409, requestId);
      }
      values.push(mode);
      updates.push(`publishing_mode = $${values.length}`);
      changed.publishingMode = mode;
    }
    if (body.brandName !== undefined) {
      const brand = body.brandName === null ? null : String(body.brandName).trim().slice(0, 120) || null;
      values.push(brand);
      updates.push(`brand_name = $${values.length}`);
      changed.brandName = brand;
    }
    if (body.cadence !== undefined) {
      const cadence = normalizeSiteCadence(body.cadence);
      values.push(JSON.stringify(cadence));
      updates.push(`cadence = $${values.length}::jsonb`);
      changed.cadence = cadence;
    }
    if (body.status !== undefined) {
      const status = String(body.status);
      if (status !== "active" && status !== "paused") return jsonWithRequest({ error: "bad_request" }, 400, requestId);
      values.push(status);
      updates.push(`status = $${values.length}`);
      changed.status = status;
    }
    if (!updates.length) return jsonWithRequest({ error: "bad_request" }, 400, requestId);

    const updated = await pool.query<SiteRow>(
      `update sites set ${updates.join(", ")}, updated_at = now() where id = $1 returning ${SITE_FIELDS}`,
      values,
    );
    await pool.query(
      `insert into audit_events (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id)
       values ($1, $2, 'site.settings.updated', 'site', $3, $4::jsonb, $5)`,
      [projectId, userId, String(site.id), JSON.stringify(changed), requestId],
    );
    return jsonWithRequest({ ok: true, site: serializeSite(updated.rows[0]) }, 200, requestId);
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/settings PATCH", requestId);
  }
}
