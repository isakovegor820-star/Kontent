import { NextRequest, NextResponse } from "next/server";

import { acknowledgeAiUsageResult } from "@/lib/ai-usage";
import { acknowledgeGenerationArtifact } from "@/lib/generation-artifacts";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function ackJson(
  requestId: string,
  payload: Record<string, unknown>,
  status: number,
  headers?: HeadersInit,
) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("cache-control", "no-store");
  responseHeaders.set("x-ai-request-id", requestId);
  return NextResponse.json({ ...payload, requestId }, { status, headers: responseHeaders });
}

/**
 * Second phase of paid text generation. The browser calls this only after it parsed the
 * NDJSON `done` event and reached clean EOF; repeated calls are safe and never double-count.
 */
export async function POST(req: NextRequest) {
  const requestId = crypto.randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return ackJson(requestId, { ok: false, error: "forbidden_origin", retryable: false }, 403);
  }

  let user: Awaited<ReturnType<typeof getSessionUser>>;
  try {
    user = await getSessionUser(req);
  } catch {
    console.error(`[/api/ai/generate/ack] ${JSON.stringify({ requestId, code: "session_unavailable", status: 503 })}`);
    return ackJson(requestId, { ok: false, error: "session_unavailable", retryable: true }, 503);
  }
  if (!user) return ackJson(requestId, { ok: false, error: "unauthorized", retryable: false }, 401);

  const clientKey = req.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9:_-]{8,96}$/u.test(clientKey)) {
    return ackJson(requestId, { ok: false, error: "idempotency_key_required", retryable: false }, 400);
  }

  try {
    const finalized = await acknowledgeAiUsageResult(user.id, `web:${clientKey}`);
    if (finalized.status === "committed" && finalized.result) {
      const generationResultId = await acknowledgeGenerationArtifact(user.id, `web:${clientKey}`);
      if (!generationResultId || finalized.result.generationResultId !== generationResultId) {
        return ackJson(
          requestId,
          { ok: false, error: "generation_artifact_ack_unavailable", retryable: true },
          409,
        );
      }
      return ackJson(
        requestId,
        { ok: true, status: "committed", replayed: !finalized.changed, generationResultId },
        200,
        { "x-ai-acknowledged": "true" },
      );
    }
    if (finalized.status === "reserved") {
      return ackJson(
        requestId,
        { ok: false, error: "terminal_not_prepared", retryable: true, retryAfterSeconds: 2 },
        409,
        { "retry-after": "2" },
      );
    }
    return ackJson(
      requestId,
      { ok: false, error: "terminal_ack_unavailable", retryable: true },
      409,
    );
  } catch {
    console.error(`[/api/ai/generate/ack] ${JSON.stringify({ requestId, code: "usage_ack_unavailable", status: 503 })}`);
    return ackJson(requestId, { ok: false, error: "usage_ack_unavailable", retryable: true }, 503);
  }
}
