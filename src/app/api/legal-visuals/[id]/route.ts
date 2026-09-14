import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getLegalVisualDesign, updateLegalVisualDesign } from "@/lib/legal-visual-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { legalStudioBody, legalStudioBodyFailure, legalStudioError, legalStudioJson, positiveRouteId } from "../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = positiveRouteId((await context.params).id);
  if (!id) return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const design = await getLegalVisualDesign({ pool: getPool(), actorUserId: user.id, designId: id });
    return legalStudioJson({ ok: true, design }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}

export async function PATCH(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) return legalStudioJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`legal-visual:update:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const id = positiveRouteId((await context.params).id);
  const parsed = await legalStudioBody(request, ["expectedRevision", "config"]);
  if (!parsed.ok) return legalStudioBodyFailure(parsed, requestId);
  const body = parsed.body;
  if (!id || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const design = await updateLegalVisualDesign({
      pool: getPool(), actorUserId: user.id, designId: id,
      expectedRevision: Number(body.expectedRevision), config: body.config,
    });
    return legalStudioJson({ ok: true, design }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
