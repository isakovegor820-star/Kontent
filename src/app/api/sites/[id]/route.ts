import { withProjectRoute } from "@/lib/project-route";
import { NextRequest } from "next/server";

import { loadSiteDetails } from "@/lib/sites/service";

import { jsonWithRequest, requireSite, resolveSiteRoute, siteErrorResponse } from "../_shared";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

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

export const GET = withProjectRoute(handleGET);
