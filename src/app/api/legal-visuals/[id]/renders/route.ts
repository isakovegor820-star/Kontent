import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { reconcileLegalVisualRenderOutbox } from "@/lib/legal-visual-render-outbox.mjs";
import { enqueueLegalVisualRenderJob } from "@/lib/legal-visual-render-queue.mjs";
import { requestLegalVisualRender } from "@/lib/legal-visual-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { legalStudioBody, legalStudioBodyFailure, legalStudioError, legalStudioJson, positiveRouteId } from "../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) return legalStudioJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const rate = await checkRateLimit(`legal-visual-render:user:${user.id}`, 30, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const id = positiveRouteId((await context.params).id);
  const parsed = await legalStudioBody(request, ["expectedRevision", "idempotencyKey"]);
  if (!parsed.ok) return legalStudioBodyFailure(parsed, requestId);
  const body = parsed.body;
  if (!id || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
    return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  }
  try {
    const pool = getPool();
    const result = await requestLegalVisualRender({
      pool, actorUserId: user.id, designId: id,
      expectedRevision: Number(body.expectedRevision), idempotencyKey: body.idempotencyKey,
    });
    const dispatch = await reconcileLegalVisualRenderOutbox({
      pool, enqueue: (data: { operationId: number; projectId: number; configHash: string }) => enqueueLegalVisualRenderJob(data),
      operationId: result.operationId, limit: 1,
    }).catch(() => ({ scanned: 0, enqueued: 0, failed: 1 }));
    return legalStudioJson({ ok: true, ...result, dispatch }, result.duplicate ? 200 : 202, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
