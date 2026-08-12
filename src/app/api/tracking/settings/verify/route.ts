import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { verifyProjectTrackingSite } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../../_shared";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`tracking:verify:user:${user.id}`, 15, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readTrackingBodyResult(req, ["expectedVersion"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  try {
    const result = await verifyProjectTrackingSite({
      pool: getPool(),
      actorUserId: user.id,
      expectedVersion: parsed.body.expectedVersion,
      requestId,
    });
    return trackingJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}
