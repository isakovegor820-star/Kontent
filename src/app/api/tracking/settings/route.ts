import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { configureProjectTracking, getProjectTrackingSettings } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return trackingJson({ ok: true, tracking: await getProjectTrackingSettings(getPool(), user.id) }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}

export async function PUT(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`tracking:settings:user:${user.id}`, 30, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readTrackingBodyResult(req, ["siteOrigin", "attributionWindowDays", "expectedVersion"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const tracking = await configureProjectTracking({
      pool: getPool(), actorUserId: user.id, siteOrigin: body.siteOrigin,
      attributionWindowDays: body.attributionWindowDays,
      expectedVersion: body.expectedVersion, requestId,
    });
    return trackingJson({ ok: true, tracking }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}
