import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { createLegalVisualDesign, listLegalVisualDesigns } from "@/lib/legal-visual-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { legalStudioBody, legalStudioBodyFailure, legalStudioError, legalStudioJson } from "./_shared";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const designs = await listLegalVisualDesigns({ pool: getPool(), actorUserId: user.id });
    return legalStudioJson({ ok: true, designs }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) return legalStudioJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`legal-visual:create:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const parsed = await legalStudioBody(request, ["requestKey", "name", "format", "template", "sourceDraftId", "config"]);
  if (!parsed.ok) return legalStudioBodyFailure(parsed, requestId);
  const body = parsed.body;
  try {
    const result = await createLegalVisualDesign({
      pool: getPool(), actorUserId: user.id, requestKey: body.requestKey,
      name: body.name, format: body.format, template: body.template,
      sourceDraftId: body.sourceDraftId, config: body.config,
    });
    return legalStudioJson({ ok: true, ...result }, result.duplicate ? 200 : 201, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
