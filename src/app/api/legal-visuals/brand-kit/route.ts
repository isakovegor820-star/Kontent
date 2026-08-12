import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getLegalVisualBrandKit, updateLegalVisualBrandKit } from "@/lib/legal-visual-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { legalStudioBody, legalStudioBodyFailure, legalStudioError, legalStudioJson } from "../_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const result = await getLegalVisualBrandKit({ pool: getPool(), actorUserId: user.id });
    return legalStudioJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}

export async function PATCH(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) return legalStudioJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`legal-visual:brand-kit:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await legalStudioBody(request, ["expectedVersion", "brand"]);
  if (!parsed.ok) return legalStudioBodyFailure(parsed, requestId);
  const body = parsed.body;
  if (!Number.isSafeInteger(body.expectedVersion) || Number(body.expectedVersion) < 0) {
    return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const result = await updateLegalVisualBrandKit({
      pool: getPool(), actorUserId: user.id,
      expectedVersion: Number(body.expectedVersion), brand: body.brand,
    });
    return legalStudioJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
