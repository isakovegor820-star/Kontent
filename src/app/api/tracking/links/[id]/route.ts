import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { revokeProjectShortLink } from "@/lib/tracking-service";
import { readTrackingBodyResult, trackingApiError, trackingBodyFailure, trackingJson } from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function DELETE(req: NextRequest, ctx: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return trackingJson({ ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return trackingJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const linkId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(linkId) || linkId <= 0) {
    return trackingJson({ ok: false, error: "bad_id" }, 400, requestId);
  }
  const rate = await checkRateLimit(`tracking:links:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await readTrackingBodyResult(req, ["expectedVersion"]);
  if (!parsed.ok) return trackingBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const result = await revokeProjectShortLink({
      pool: getPool(), actorUserId: user.id, linkId,
      expectedVersion: body.expectedVersion, requestId,
    });
    return trackingJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return trackingApiError(error, requestId);
  }
}
