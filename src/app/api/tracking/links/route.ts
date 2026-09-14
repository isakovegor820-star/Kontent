import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { createProjectShortLink, listProjectShortLinks } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../_shared";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    return trackingJson({ ok: true, links: await listProjectShortLinks(getPool(), user.id) }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`tracking:links:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readTrackingBodyResult(req, ["destination", "utmValues", "templateId", "expiresAt"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const link = await createProjectShortLink({
      pool: getPool(), actorUserId: user.id, destination: body.destination,
      utmValues: body.utmValues, templateId: body.templateId, expiresAt: body.expiresAt,
      idempotencyKey: req.headers.get("idempotency-key"), requestId,
    });
    return trackingJson({ ok: true, link }, 201, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}
