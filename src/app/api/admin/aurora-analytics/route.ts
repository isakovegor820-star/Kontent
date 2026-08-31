import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import {
  AdminAnalyticsQueryError,
  loadAdminAuroraAnalytics,
  normalizeAdminAnalyticsQuery,
} from "@/lib/admin-aurora-analytics";
import { recordAdminObservation } from "@/lib/admin-observation-audit";
import { getPool } from "@/lib/db";
import { productEventRetentionDays } from "@/lib/product-events";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function json(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "no-store", "x-request-id": requestId },
  });
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return json(requestId, { error: "unauthorized", requestId }, 401);
  if (!hasAuroraAdminAccess(user)) return json(requestId, { error: "access_denied", requestId }, 403);

  const rate = await checkRateLimit(`admin-aurora-analytics:${user.id}`, 60, 60, { failureMode: "closed" });
  if (!rate.allowed) {
    const limited = rateLimitResponse(rate);
    limited.headers.set("cache-control", "no-store");
    limited.headers.set("x-request-id", requestId);
    return limited;
  }

  let filters;
  try {
    filters = normalizeAdminAnalyticsQuery(req.nextUrl.searchParams);
  } catch (error) {
    const code = error instanceof AdminAnalyticsQueryError ? error.code : "analytics_query_invalid";
    return json(requestId, { error: code, requestId }, 422);
  }

  const pool = getPool();
  try {
    const payload = await loadAdminAuroraAnalytics(pool, filters, {
      rawRetentionDays: productEventRetentionDays(),
    });
    await recordAdminObservation({
      db: pool,
      actorUserId: user.id,
      action: "admin.aurora_analytics.read",
      targetType: filters.sectionId ? "section" : filters.projectId ? "project" : "runtime",
      targetId: filters.sectionId ?? filters.projectId,
      requestId,
      filters: {
        range: filters.range,
        from: filters.from,
        to: filters.to,
        projectId: filters.projectId,
        segment: filters.segment,
        tenure: filters.tenure,
        device: filters.device,
        appVersion: filters.appVersion,
        release: filters.release,
        sectionId: filters.sectionId,
        tab: filters.tab,
      },
    });
    return json(requestId, payload as unknown as Record<string, unknown>);
  } catch (error) {
    console.error("[/api/admin/aurora-analytics]", {
      requestId,
      code: "admin_aurora_analytics_unavailable",
      errorName: error instanceof Error ? error.name : "Error",
    });
    return json(requestId, { error: "admin_aurora_analytics_unavailable", requestId }, 503);
  }
}
