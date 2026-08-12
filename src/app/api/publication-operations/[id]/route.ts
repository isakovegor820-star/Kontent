import { NextRequest, NextResponse } from "next/server";

import {
  authorizePublicationOperation,
  PublicationOperationNotFoundError,
} from "@/app/api/publication-operations/_project-authorization";
import { getPool } from "@/lib/db";
import { ProjectAccessError } from "@/lib/project-permissions";
import { normalizeProviderId, providerSupportsOperation } from "@/lib/provider-capabilities.mjs";
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

function authorizationResponse(error: unknown) {
  if (error instanceof ProjectAccessError) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  if (error instanceof PublicationOperationNotFoundError) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 404 });
  }
  return null;
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

export async function GET(
  req: NextRequest,
  ctx: OperationRouteContext,
) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const id = await operationId(ctx);
  if (!id) return NextResponse.json({ ok: false, error: "bad_operation" }, { status: 422 });
  const pool = getPool();
  try {
    const { projectId } = await authorizePublicationOperation({
      db: pool,
      userId: user.id,
      operationId: id,
      permission: "project.read",
    });
    const operation = await pool.query<{
      id: number | string;
      draft_id: number | string | null;
      draft_version: number | string;
      status: string;
      scheduled_at: Date | string;
      timezone: string;
      schedule_revision: number | string;
      created_at: Date | string;
      updated_at: Date | string;
    }>(
      `select id, draft_id, draft_version, status, scheduled_at, timezone,
              schedule_revision, created_at, updated_at
         from publication_operations
        where id = $1 and project_id = $2`,
      [id, projectId],
    );
    const row = operation.rows[0];
    if (!row) {
      return NextResponse.json(
        { ok: false, error: "publication_operation_not_found" },
        { status: 404 },
      );
    }
    const destinations = await pool.query<{
      post_id: number | string;
      channel_id: number | string;
      network: string;
      title: string | null;
      post_status: string;
      queue_status: string;
      safe_error_code: string | null;
    }>(
      `select post.id as post_id, post.channel_id, channel.network, channel.title,
              post.status as post_status, outbox.status as queue_status,
              outbox.last_error_code as safe_error_code
         from posts post
         join channels channel
           on channel.id = post.channel_id and channel.project_id = $2
         join publication_outbox outbox on outbox.post_id = post.id
        where post.publication_operation_id = $1 and post.project_id = $2
        order by post.channel_id`,
      [id, projectId],
    );
    const extras = await pool.query<{
      id: number | string;
      post_id: number | string;
      kind: string;
      status: string;
      fingerprint: string;
      external_id: string | null;
      external_url: string | null;
      attempts: number | string;
      last_error_code: string | null;
      last_error_message: string | null;
      completed_at: Date | string | null;
    }>(
      `select extra.id, extra.post_id, extra.kind, extra.status, extra.fingerprint,
              extra.external_id, extra.external_url, extra.attempts,
              extra.last_error_code, extra.last_error_message, extra.completed_at
         from publication_extra_operations extra
        where extra.publication_operation_id = $1 and extra.project_id = $2
        order by extra.post_id, extra.sequence_index, extra.id`,
      [id, projectId],
    );
    const reviews = await pool.query<{
      id: number | string;
      post_id: number | string;
      responsible_user_id: number | string;
      review_at: Date | string;
      timezone: string;
      status: string;
      decision: string | null;
      reminder_status: string;
      reminder_sent_at: Date | string | null;
      update_draft_id: number | string | null;
      network: string;
      can_decide: boolean;
      successful_pin: boolean;
      version: number | string;
    }>(
      `select task.id, task.post_id, task.responsible_user_id, task.review_at,
              task.timezone, task.status, task.decision,
              task.reminder_status, task.reminder_sent_at, task.update_draft_id,
              task.version, channel.network,
              (
                (task.status = 'due' or (task.status = 'scheduled' and task.review_at <= now()))
                and (
                  task.responsible_user_id = $3
                  or exists (
                    select 1 from project_members actor
                     where actor.project_id = task.project_id and actor.user_id = $3
                       and actor.status = 'active' and actor.role in ('owner','publisher')
                  )
                )
              ) as can_decide,
              exists (
                select 1 from publication_extra_operations pin
                 where pin.project_id = task.project_id and pin.post_id = task.post_id
                   and pin.kind = 'pin' and pin.status = 'succeeded'
              ) as successful_pin
         from publication_review_tasks task
         join posts post on post.id = task.post_id and post.project_id = task.project_id
         join channels channel on channel.id = post.channel_id and channel.project_id = task.project_id
        where post.publication_operation_id = $1 and task.project_id = $2
        order by task.post_id, task.id`,
      [id, projectId, user.id],
    );
    return NextResponse.json({
      ok: true,
      operation: {
        id: Number(row.id),
        draftId: row.draft_id == null ? null : Number(row.draft_id),
        draftVersion: Number(row.draft_version),
        status: row.status,
        scheduledAt: new Date(row.scheduled_at).toISOString(),
        timezone: row.timezone,
        scheduleRevision: Number(row.schedule_revision),
        createdAt: new Date(row.created_at).toISOString(),
        updatedAt: new Date(row.updated_at).toISOString(),
        destinations: destinations.rows.map((destination) => ({
          postId: Number(destination.post_id),
          channelId: Number(destination.channel_id),
          network: destination.network,
          title: destination.title,
          postStatus: destination.post_status,
          queueStatus: destination.queue_status,
          error: destination.safe_error_code,
          extraOperations: extras.rows
            .filter((extra) => Number(extra.post_id) === Number(destination.post_id))
            .map((extra) => ({
              id: Number(extra.id),
              kind: extra.kind,
              status: extra.status,
              fingerprint: extra.fingerprint,
              externalId: extra.external_id,
              externalUrl: extra.external_url,
              attempts: Number(extra.attempts),
              error: extra.last_error_code,
              message: extra.last_error_message,
              completedAt: extra.completed_at == null
                ? null
                : new Date(extra.completed_at).toISOString(),
            })),
          review: reviews.rows
            .filter((review) => Number(review.post_id) === Number(destination.post_id))
            .map((review) => {
              const providerId = normalizeProviderId(review.network)
                || String(review.network || "").toLowerCase();
              const canDecide = review.can_decide === true;
              return {
                id: Number(review.id),
                responsibleUserId: Number(review.responsible_user_id),
                reviewAt: new Date(review.review_at).toISOString(),
                timezone: review.timezone,
                status: review.status,
                decision: review.decision,
                reminderStatus: review.reminder_status,
                reminderSentAt: review.reminder_sent_at == null
                  ? null
                  : new Date(review.reminder_sent_at).toISOString(),
                version: Number(review.version),
                updateDraftId: review.update_draft_id == null
                  ? null
                  : Number(review.update_draft_id),
                canDecide,
                canUnpin: canDecide
                  && review.successful_pin === true
                  && providerSupportsOperation(providerId, "pin"),
              };
            })[0] ?? null,
        })),
      },
    });
  } catch (error) {
    const response = authorizationResponse(error);
    if (response) return response;
    console.error("[/api/publication-operations/:id GET]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "operation_not_loaded" }, { status: 500 });
  }
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
  const pool = getPool();
  try {
    const { projectId } = await authorizePublicationOperation({
      db: pool,
      userId: user.id,
      operationId: id,
      permission: "content.publish",
      requireCreator: true,
    });
    const result = await cancelPublicationOperation({
      pool,
      userId: user.id,
      projectId,
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
    const response = authorizationResponse(error);
    if (response) return response;
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
  const pool = getPool();
  try {
    const { projectId } = await authorizePublicationOperation({
      db: pool,
      userId: user.id,
      operationId: id,
      permission: "content.publish",
      requireCreator: true,
    });
    const resolved = resolveLocalSchedule({
      localDate: String(body.localDate || ""),
      localTime: String(body.localTime || ""),
      timezone: String(body.timezone || ""),
      disambiguation: String(body.disambiguation || "reject") as ScheduleDisambiguation,
      offset: typeof body.offset === "string" ? body.offset : null,
    }, typeof body.scheduledAt === "string" ? body.scheduledAt : null);
    const result = await reschedulePublicationOperation({
      pool,
      userId: user.id,
      projectId,
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
      pool,
      operationId: id,
      enqueue: (postId, scheduledAt, scheduleRevision, projectId) => getPublishQueue().add(
        "publish",
        { postId, projectId, scheduleRevision },
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
    const response = authorizationResponse(error);
    if (response) return response;
    console.error("[/api/publication-operations/:id PATCH]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "operation_not_rescheduled" }, { status: 500 });
  }
}
