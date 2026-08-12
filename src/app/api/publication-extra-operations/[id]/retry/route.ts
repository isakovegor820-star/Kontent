import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import {
  PublicationReviewError,
  retryPublicationExtraOperation,
} from "@/lib/publication-review-service";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
type RouteContext = { params: Promise<{ id: string }> };
const MAX_RETRY_BODY_BYTES = 8 * 1024;

async function readRetryBody(req: Request) {
  if (req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    return null;
  }
  try {
    const bytes = await readRequestBodyLimited(req.body, MAX_RETRY_BODY_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    return Object.keys(body).every((key) => ["expectedFingerprint", "verifiedAbsent"].includes(key))
      ? body
      : null;
  } catch (error) {
    if (error instanceof BoundedBodyError || error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

function errorResponse(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    return NextResponse.json({ ok: false, error: "forbidden", requestId }, { status: 403 });
  }
  if (error instanceof PublicationReviewError) {
    const status: Record<PublicationReviewError["code"], number> = {
      invalid_review_task: 422,
      invalid_operation: 422,
      invalid_decision: 422,
      invalid_version: 422,
      invalid_note: 422,
      review_not_found: 404,
      review_not_due: 409,
      version_conflict: 409,
      idempotency_conflict: 409,
      post_not_published: 409,
      review_decision_forbidden: 403,
      pin_not_confirmed: 409,
      operation_not_found: 404,
      operation_not_retryable: 409,
      fingerprint_conflict: 409,
      provider_confirmation_required: 409,
    };
    return NextResponse.json({ ok: false, error: error.code, requestId }, { status: status[error.code] });
  }
  console.error("[publication-extra-retry] failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return NextResponse.json({ ok: false, error: "server", requestId }, { status: 500 });
}

export async function POST(req: NextRequest, ctx: RouteContext) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin", requestId }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized", requestId }, { status: 401 });
  }
  const rate = await checkRateLimit(`publication-extra-retry:user:${user.id}`, 60, 3_600, {
    failureMode: "closed",
  });
  if (!rate.allowed) return rateLimitResponse(rate);
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!idempotencyKey) {
    return NextResponse.json(
      { ok: false, error: "idempotency_key_required", requestId },
      { status: 400 },
    );
  }
  const body = await readRetryBody(req);
  if (!body || Array.isArray(body)) {
    return NextResponse.json({ ok: false, error: "bad_request", requestId }, { status: 400 });
  }
  try {
    const result = await retryPublicationExtraOperation({
      pool: getPool(),
      actorUserId: user.id,
      operationId: (await ctx.params).id,
      expectedFingerprint: body.expectedFingerprint,
      verifiedAbsent: body.verifiedAbsent,
      idempotencyKey,
      requestId,
    });
    return NextResponse.json({ ok: true, ...result, requestId }, { status: 200 });
  } catch (error) {
    return errorResponse(error, requestId);
  }
}
