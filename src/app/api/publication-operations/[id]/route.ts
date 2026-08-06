import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import {
  cancelPublicationOperation,
  reschedulePublicationOperation,
  type PublicationMutationResult,
} from "@/lib/publication-lifecycle.mjs";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";
import { getPublishQueue, jobIdForPostRevision } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  resolveLocalSchedule,
  ScheduleValidationError,
  type ScheduleDisambiguation,
} from "@/lib/timezone-schedule";

export const runtime = "nodejs";

function mutationResponse(result: PublicationMutationResult) {
  return NextResponse.json(result, { status: result.ok ? 200 : (result.httpStatus ?? 500) });
}

function requestId(req: NextRequest) {
  const value = String(req.headers.get("x-request-id") || "").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

type OperationRouteContext = { params: Promise<{ id: string }> };

async function operationId(ctx: OperationRouteContext) {
  const value = Number((await ctx.params).id);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

async function bestEffortRemoveJobs(postIds: number[] | undefined, revision: number | undefined) {
  if (!postIds?.length || !revision) return;
  const queue = getPublishQueue();
  await Promise.all(postIds.map(async (postId) => {
    try {
      const job = await queue.getJob(jobIdForPostRevision(postId, revision));
      await job?.remove();
    } catch {
      // PostgreSQL status/revision is the safety boundary. A stale delayed job is harmless.
    }
  }));
}

function logPublicationEvent(event: string, result: PublicationMutationResult, req: NextRequest) {
  console.info("[publication_event]", {
    event,
    requestId: requestId(req),
    operationId: result.operationId ?? null,
    revision: result.scheduleRevision ?? null,
    status: result.status ?? result.error ?? "unknown",
  });
}

export async function DELETE(
  req: NextRequest,
  ctx: OperationRouteContext,
) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = await operationId(ctx);
  if (!id) return NextResponse.json({ ok: false, error: "bad_operation" }, { status: 422 });
  const key = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!key) return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as {
    expectedScheduleRevision?: unknown;
    expectedStatus?: unknown;
  } | null;
  const expectedStatus = typeof body?.expectedStatus === "string" ? body.expectedStatus : "";
  if (!expectedStatus) {
    return NextResponse.json({ ok: false, error: "expected_status_required" }, { status: 422 });
  }
  try {
    const result = await cancelPublicationOperation({
      pool: getPool(),
      userId: user.id,
      operationId: id,
      expectedRevision: Number(body?.expectedScheduleRevision),
      expectedStatus,
      idempotencyKey: key,
      requestId: requestId(req),
    });
    if (result.ok && !result.replayed) {
      await bestEffortRemoveJobs(result.postIds, result.previousRevision);
      logPublicationEvent("publication_cancelled", result, req);
    }
    return mutationResponse(result);
  } catch (error) {
    console.error("[/api/publication-operations/:id DELETE]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "operation_not_cancelled" }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  ctx: OperationRouteContext,
) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = await operationId(ctx);
  if (!id) return NextResponse.json({ ok: false, error: "bad_operation" }, { status: 422 });
  const key = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!key) return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  const body = (await req.json().catch(() => null)) as {
    action?: unknown;
    scheduledAt?: unknown;
    localDate?: unknown;
    localTime?: unknown;
    timezone?: unknown;
    disambiguation?: unknown;
    offset?: unknown;
    expectedScheduleRevision?: unknown;
    expectedStatus?: unknown;
  } | null;
  if (body?.action !== "reschedule") {
    return NextResponse.json({ ok: false, error: "unsupported_action" }, { status: 422 });
  }
  const expectedStatus = typeof body.expectedStatus === "string" ? body.expectedStatus : "";
  if (!expectedStatus) {
    return NextResponse.json({ ok: false, error: "expected_status_required" }, { status: 422 });
  }
  try {
    const resolved = resolveLocalSchedule({
      localDate: String(body.localDate || ""),
      localTime: String(body.localTime || ""),
      timezone: String(body.timezone || ""),
      disambiguation: String(body.disambiguation || "reject") as ScheduleDisambiguation,
      offset: typeof body.offset === "string" ? body.offset : null,
    }, typeof body.scheduledAt === "string" ? body.scheduledAt : null);
    const result = await reschedulePublicationOperation({
      pool: getPool(),
      userId: user.id,
      operationId: id,
      expectedRevision: Number(body.expectedScheduleRevision),
      expectedStatus,
      idempotencyKey: key,
      requestId: requestId(req),
      scheduledAt: resolved.scheduledAt,
      timezone: resolved.timezone,
      offset: resolved.offset,
      disambiguation: resolved.disambiguation,
    });
    if (!result.ok) return mutationResponse(result);
    await bestEffortRemoveJobs(result.postIds, result.previousRevision);
    const outbox = await reconcilePublicationOutbox({
      pool: getPool(),
      operationId: id,
      enqueue: (postId, scheduledAt, scheduleRevision) => getPublishQueue().add(
        "publish",
        { postId, scheduleRevision },
        {
          delay: Math.max(0, scheduledAt.getTime() - Date.now()),
          jobId: jobIdForPostRevision(postId, scheduleRevision),
          removeOnComplete: true,
          removeOnFail: false,
        },
      ),
    });
    const operationStatus = outbox.statuses[id] ?? result.operationStatus ?? "pending";
    const queued = operationStatus === "queued";
    const response = {
      ...result,
      ok: queued,
      operationStatus,
      ...(queued ? {} : { error: "publication_worker_unavailable", retryable: true }),
    };
    logPublicationEvent(queued ? "publication_rescheduled" : "publication_operation_partial", response, req);
    return NextResponse.json(response, { status: queued ? 200 : 207 });
  } catch (error) {
    if (error instanceof ScheduleValidationError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: 422 });
    }
    console.error("[/api/publication-operations/:id PATCH]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "operation_not_rescheduled" }, { status: 500 });
  }
}
