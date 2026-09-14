import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { undoProjectTypographyRun } from "@/lib/typography-service";
import { readTypographyBody, typographyApiError, typographyJson } from "../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) {
    return typographyJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  }
  const user = await getSessionUser(request);
  if (!user) return typographyJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`typography:undo:user:${user.id}`, 120, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const runId = Number((await context.params).id);
  const body = await readTypographyBody(request, ["currentText"]);
  if (!Number.isSafeInteger(runId) || runId <= 0 || !body) {
    return typographyJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const result = await undoProjectTypographyRun({
      pool: getPool(),
      actorUserId: user.id,
      runId,
      currentText: body.currentText,
      requestId,
    });
    return typographyJson({ ok: true, ...result }, 200, requestId);
  } catch (error) {
    return typographyApiError(error, requestId);
  }
}
