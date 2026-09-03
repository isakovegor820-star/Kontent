import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";
import type { Pool } from "pg";

import { getPool } from "@/lib/db";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
  type ProjectPermission,
} from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { SiteServiceError, findSiteForProject, type SiteRow } from "@/lib/sites/service";

export function jsonWithRequest(body: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export type SiteRouteContext = {
  requestId: string;
  pool: Pool;
  userId: number;
  projectId: number;
};

export type SiteRouteResolution =
  | { ok: true; context: SiteRouteContext }
  | { ok: false; response: NextResponse };

export async function resolveSiteRoute(
  req: NextRequest,
  permission: ProjectPermission,
  options: { mutation?: boolean; label: string },
): Promise<SiteRouteResolution> {
  const requestId = randomUUID();
  if (options.mutation && !hasTrustedMutationOrigin(req)) {
    return { ok: false, response: jsonWithRequest({ error: "forbidden_origin" }, 403, requestId) };
  }
  const user = await getSessionUser(req);
  if (!user) return { ok: false, response: jsonWithRequest({ error: "unauthorized" }, 401, requestId) };
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, permission);
    return { ok: true, context: { requestId, pool, userId: user.id, projectId: membership.projectId } };
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return { ok: false, response: jsonWithRequest({ error: "access_denied" }, 403, requestId) };
    }
    console.error(`[${options.label}] project scope`, { requestId, errorName: error instanceof Error ? error.name : "Error" });
    return { ok: false, response: jsonWithRequest({ error: "unavailable" }, 503, requestId) };
  }
}

export function parseSiteId(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export async function requireSite(
  context: SiteRouteContext,
  rawId: string | undefined,
): Promise<{ ok: true; site: SiteRow } | { ok: false; response: NextResponse }> {
  const id = parseSiteId(rawId);
  if (!id) return { ok: false, response: jsonWithRequest({ error: "bad_request" }, 400, context.requestId) };
  const site = await findSiteForProject(context.pool, id, context.projectId);
  if (!site) return { ok: false, response: jsonWithRequest({ error: "not_found" }, 404, context.requestId) };
  return { ok: true, site };
}

export function siteErrorResponse(error: unknown, label: string, requestId: string) {
  if (error instanceof SiteServiceError) {
    return jsonWithRequest({ error: error.code }, error.status, requestId);
  }
  console.error(`[${label}]`, { requestId, errorName: error instanceof Error ? error.name : "Error" });
  return jsonWithRequest({ error: "unavailable" }, 503, requestId);
}
