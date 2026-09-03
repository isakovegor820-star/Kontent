import { NextRequest } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { SITE_FIELDS, serializeSite, type SiteRow } from "@/lib/sites/service";
import {
  SITE_VERIFICATION_METHODS,
  verifySiteOwnership,
  type SiteVerificationMethod,
} from "@/lib/sites/verification";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function parseMethod(value: unknown): SiteVerificationMethod | "auto" | null {
  if (value === undefined || value === null || value === "" || value === "auto") return "auto";
  return (SITE_VERIFICATION_METHODS as readonly string[]).includes(String(value))
    ? (value as SiteVerificationMethod)
    : null;
}

/**
 * Идемпотентная проверка владения доменом. Повторный вызов для уже подтверждённого
 * сайта ничего не меняет; отзыв подтверждения — отдельная операция (не в этом этапе).
 */
export async function POST(req: NextRequest, context: Context) {
  const resolved = await resolveSiteRoute(req, "content.create", { mutation: true, label: "/api/sites/:id/verify POST" });
  if (!resolved.ok) return resolved.response;
  const { requestId, pool, userId, projectId } = resolved.context;

  let body: Record<string, unknown> = {};
  try {
    body = await readJsonBodyValue(req);
  } catch {
    body = {};
  }
  const method = parseMethod(body.method);
  if (!method) return jsonWithRequest({ error: "bad_request" }, 400, requestId);

  try {
    const found = await requireSite(resolved.context, (await context.params).id);
    if (!found.ok) return found.response;
    const site = found.site;
    if (site.verification_state === "verified") {
      return jsonWithRequest({ ok: true, verified: true, replayed: true, site: serializeSite(site) }, 200, requestId);
    }

    const check = await verifySiteOwnership({
      confirmedDomain: site.confirmed_domain,
      canonicalUrl: site.canonical_url,
      verificationToken: site.verification_token,
    }, method);

    if (!check.ok) {
      return jsonWithRequest({
        ok: true,
        verified: false,
        reason: check.reason,
        method: check.method,
        site: serializeSite(site),
      }, 200, requestId);
    }

    const client = await pool.connect();
    try {
      await client.query("begin");
      const updated = await client.query<SiteRow>(
        `update sites
            set verification_state = 'verified', verification_method = $3,
                verified_at = now(), updated_at = now()
          where id = $1 and project_id = $2 and verification_state <> 'verified'
          returning ${SITE_FIELDS}`,
        [site.id, projectId, check.method],
      );
      const row = updated.rows[0];
      if (row) {
        await client.query(
          `insert into audit_events
             (project_id, actor_user_id, action, entity_type, entity_id, safe_data, request_id, idempotency_key)
           values ($1, $2, 'site.verified', 'site', $3, $4::jsonb, $5, $6)
           on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
          [
            projectId,
            userId,
            String(site.id),
            JSON.stringify({ domain: site.confirmed_domain, method: check.method }),
            requestId,
            `site-verified:${projectId}:${site.id}`,
          ],
        );
      }
      await client.query("commit");
      return jsonWithRequest({
        ok: true,
        verified: true,
        replayed: !row,
        method: check.method,
        site: serializeSite(row ?? site),
      }, 200, requestId);
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } catch (error) {
    return siteErrorResponse(error, "/api/sites/:id/verify POST", requestId);
  }
}
