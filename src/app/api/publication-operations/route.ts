import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { getPool } from "@/lib/db";
import { draftReviewDecision } from "@/lib/draft-review";
import type { DraftHumanReview } from "@/lib/draft-types";
import { generationBindingValid } from "@/lib/generation-artifacts";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import {
  normalizeOperationDestinations,
  publicationOperationFingerprint,
} from "@/lib/publication-operation";
import { getPublishQueue, jobIdForPostRevision } from "@/lib/queue";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";
import { probeRedisAndPublicationWorker } from "@/lib/readiness-probes";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { buildTelegramPayload } from "@/lib/telegram-payload.mjs";
import { resolveLocalSchedule, ScheduleValidationError } from "@/lib/timezone-schedule";

export const runtime = "nodejs";

type OperationRow = {
  id: string;
  draft_id: string | null;
  draft_version: string;
  fingerprint: string;
  status: string;
  scheduled_at: Date | string;
};

type OperationResult =
  | "operation_not_created"
  | "partial"
  | "queued"
  | "conflict"
  | "worker_unavailable";

function requestId(req: NextRequest) {
  const value = String(req.headers.get("x-request-id") || "").trim();
  return /^[a-zA-Z0-9._:-]{1,128}$/u.test(value) ? value : null;
}

function logOperationEvent(
  event: "publication_operation_created" | "publication_operation_partial",
  response: Awaited<ReturnType<typeof operationResponse>>,
  req: NextRequest,
) {
  const destinations = response.destinations.length > 0 ? response.destinations : [null];
  for (const destination of destinations) {
    console.info("[publication_event]", {
      event,
      requestId: requestId(req),
      operationId: response.operationId,
      postId: destination?.postId ?? null,
      destinationId: destination?.channelId ?? null,
      provider: destination?.network ?? null,
      revision: 1,
      status: response.operationStatus,
    });
  }
}

function operationError(
  error: string,
  status: number,
  result: Exclude<OperationResult, "partial" | "queued"> = "operation_not_created",
  details: Record<string, unknown> = {},
) {
  return NextResponse.json({ ok: false, result, error, ...details }, { status });
}

async function operationResponse(db: Pick<PoolClient, "query">, operation: OperationRow, replayed: boolean) {
  const destinations = await db.query<{
    post_id: string;
    channel_id: string;
    network: string;
    title: string | null;
    post_status: string;
    queue_status: string;
  }>(
    `select p.id as post_id, p.channel_id, c.network, c.title,
            p.status as post_status, o.status as queue_status
       from posts p
       join channels c on c.id = p.channel_id
       join publication_outbox o on o.post_id = p.id
      where p.publication_operation_id = $1
      order by p.channel_id`,
    [operation.id],
  );
  return {
    ok: operation.status === "queued",
    result: operation.status === "queued" ? "queued" : "partial",
    operationId: Number(operation.id),
    operationStatus: operation.status,
    fingerprint: operation.fingerprint,
    draftVersion: Number(operation.draft_version),
    scheduledAt: new Date(operation.scheduled_at).toISOString(),
    replayed,
    destinations: destinations.rows.map((row) => ({
      postId: Number(row.post_id),
      channelId: Number(row.channel_id),
      network: row.network,
      title: row.title,
      postStatus: row.post_status,
      queueStatus: row.queue_status,
    })),
  };
}

async function dispatchPublicationOperation(operation: OperationRow): Promise<OperationRow> {
  const pool = getPool();
  const result = await reconcilePublicationOutbox({
    pool,
    operationId: Number(operation.id),
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
  return { ...operation, status: result.statuses[Number(operation.id)] ?? operation.status };
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return operationError("forbidden_origin", 403);
  }
  const user = await getSessionUser(req);
  if (!user) return operationError("unauthorized", 401);
  const body = (await req.json().catch(() => null)) as {
    draftId?: unknown;
    draftVersion?: unknown;
    timezone?: unknown;
    operationFingerprint?: unknown;
  } | null;
  const draftId = Number(body?.draftId);
  const draftVersion = Number(body?.draftVersion);
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  const timezone = String(body?.timezone || "UTC").slice(0, 80);
  const expectedFingerprint = typeof body?.operationFingerprint === "string"
    ? body.operationFingerprint
    : null;
  if (!idempotencyKey) {
    return operationError("idempotency_key_required", 400);
  }
  if (!Number.isSafeInteger(draftId) || draftId <= 0 || !Number.isSafeInteger(draftVersion) || draftVersion <= 0) {
    return operationError("bad_draft_revision", 422);
  }

  // Redis can accept a delayed job even when no publication consumer exists. Without
  // this gate the UI reports a successful schedule while the job stays delayed forever.
  // Keep the server draft intact and let the user retry once a live worker heartbeats.
  const publication = await probeRedisAndPublicationWorker();
  if (publication.redis !== "up" || publication.publicationWorker !== "up") {
    return operationError("publication_worker_unavailable", 503, "worker_unavailable", {
      retryable: true,
    });
  }

  const pool = getPool();
  let tx: PoolClient | null = await pool.connect();
  let open = true;
  let operation: OperationRow | null = null;
  let created = false;
  let committed = false;
  try {
    await tx.query("begin");
    const replay = (await tx.query<OperationRow>(
      `select id, draft_id, draft_version, fingerprint, status, scheduled_at
         from publication_operations
        where user_id = $1 and idempotency_key = $2
        for update`,
      [user.id, idempotencyKey],
    )).rows[0];
    if (replay) {
      if (
        Number(replay.draft_id) !== draftId || Number(replay.draft_version) !== draftVersion
        || (expectedFingerprint !== null && replay.fingerprint !== expectedFingerprint)
      ) {
        return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      operation = replay;
      await tx.query("commit");
      open = false;
      committed = true;
      tx.release();
      tx = null;
      const dispatched = await dispatchPublicationOperation(operation);
      const response = await operationResponse(pool as unknown as Pick<PoolClient, "query">, dispatched, true);
      return NextResponse.json(response, { status: dispatched.status === "queued" ? 200 : 207 });
    }

    const snapshot = (await tx.query<{
      id: string;
      version: string;
      text: string;
      media: unknown;
      scheduled_at: Date | string | null;
      scheduled_timezone: string | null;
      scheduled_local_date: string | null;
      scheduled_local_time: string | null;
      scheduled_offset: string | null;
      scheduled_disambiguation: "reject" | "earlier" | "later" | null;
      origin: "manual" | "ai" | "trend" | "idea" | "competitor" | "rss" | "autopilot";
      purpose: "source_context" | "publishable" | "needs_review";
      generation_result_id: string | null;
      generation_result_hash: string | null;
      receipt_result_hash: string | null;
      receipt_payload: unknown;
      review_policy_version: string;
      ai_validation: unknown;
      human_reviewed_version: string | null;
      human_reviewed_at: Date | string | null;
    }>(
      `select d.id, d.version, d.text, d.media, d.scheduled_at,
              d.scheduled_timezone, d.scheduled_local_date::text as scheduled_local_date,
              d.scheduled_local_time::text as scheduled_local_time,
              d.scheduled_offset, d.scheduled_disambiguation,
              d.origin, d.purpose,
              d.generation_result_id, result.result_hash as generation_result_hash,
              receipt.result_hash as receipt_result_hash, receipt.receipt as receipt_payload,
              d.review_policy_version, d.ai_validation,
              d.human_reviewed_version, d.human_reviewed_at
         from drafts d
         left join generation_results result on result.id = d.generation_result_id
         left join validation_receipts receipt on receipt.generation_result_id = result.id
        where d.id = $1 and d.user_id = $2
        for update of d`,
      [draftId, user.id],
    )).rows[0];
    if (!snapshot) {
      return operationError("draft_not_found", 404);
    }
    if (Number(snapshot.version) !== draftVersion) {
      return operationError("draft_version_conflict", 409, "conflict", {
        currentVersion: Number(snapshot.version),
      });
    }
    if (snapshot.purpose === "source_context") {
      return operationError("source_context_not_publishable", 422);
    }
    if (!snapshot.scheduled_at) {
      return operationError("schedule_required", 422);
    }
    if (
      !snapshot.scheduled_timezone || !snapshot.scheduled_local_date
      || !snapshot.scheduled_local_time || !snapshot.scheduled_disambiguation
    ) {
      return operationError("schedule_metadata_required", 422);
    }
    let authoritativeSchedule;
    try {
      authoritativeSchedule = resolveLocalSchedule({
        localDate: String(snapshot.scheduled_local_date).slice(0, 10),
        localTime: String(snapshot.scheduled_local_time).slice(0, 5),
        timezone: snapshot.scheduled_timezone,
        disambiguation: snapshot.scheduled_disambiguation,
        offset: snapshot.scheduled_offset,
      }, new Date(snapshot.scheduled_at).toISOString());
    } catch (error) {
      return operationError(
        error instanceof ScheduleValidationError ? error.code : "bad_time",
        422,
      );
    }
    if (timezone !== authoritativeSchedule.timezone) {
      return operationError("schedule_timezone_conflict", 409, "conflict");
    }
    const scheduledAt = new Date(authoritativeSchedule.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60_000) {
      return operationError("past", 422);
    }
    const destinationRows = (await tx.query<{ channel_id: string; network: string }>(
      `select dd.channel_id, c.network
         from draft_destinations dd join channels c on c.id = dd.channel_id
        where dd.draft_id = $1 and c.user_id = $2
          and c.is_active = true and c.status = 'active'
        order by dd.channel_id`,
      [draftId, user.id],
    )).rows;
    const destinationIds = normalizeOperationDestinations(
      destinationRows.map((row) => Number(row.channel_id)),
    );
    if (!destinationIds.length) {
      return operationError("destination_required", 422);
    }
    const reviewedVersion = Number(snapshot.human_reviewed_version);
    const humanReview: DraftHumanReview | null = Number.isSafeInteger(reviewedVersion)
      && reviewedVersion > 0 && snapshot.human_reviewed_at != null
      ? {
          policy_version: 1,
          draft_version: reviewedVersion,
          attested_at: new Date(snapshot.human_reviewed_at).toISOString(),
        }
      : null;
    const review = draftReviewDecision({
      origin: snapshot.origin,
      purpose: snapshot.purpose,
      generation_result_id: snapshot.generation_result_id == null ? null : Number(snapshot.generation_result_id),
      generation_binding_valid: generationBindingValid({
        generationResultId: snapshot.generation_result_id,
        text: snapshot.text,
        resultHash: snapshot.generation_result_hash,
        receiptHash: snapshot.receipt_result_hash,
        aiValidation: snapshot.ai_validation,
        receipt: snapshot.receipt_payload,
      }),
      version: Number(snapshot.version),
      review_policy_version: Number(snapshot.review_policy_version),
      ai_validation: snapshot.ai_validation,
      human_review: humanReview,
    });
    if (review !== "allowed") {
      return operationError(
        review === "blocked" ? "ai_draft_blocked" : "ai_draft_review_required",
        422,
      );
    }
    const media = snapshot.media && typeof snapshot.media === "object"
      ? snapshot.media as Record<string, unknown>
      : null;
    const telegramPayload = destinationRows.some((destination) => destination.network === "tg")
      ? buildTelegramPayload({
          text: snapshot.text,
          hasAsset: Number.isSafeInteger(Number(media?.assetId)) && Number(media?.assetId) > 0,
        })
      : null;
    const telegramParts = telegramPayload?.parts.map((part) => ({
      ...part,
      payloadHash: createHash("sha256")
        .update(`${part.type}\0${part.payloadHtml || ""}`)
        .digest("hex"),
    })) ?? [];
    const operationOptions = telegramPayload
      ? {
          telegramPayloadVersion: 1,
          telegramParts: telegramParts.map((part) => ({
            index: part.index,
            type: part.type,
            entityLength: part.entityLength,
            payloadHash: part.payloadHash,
          })),
        }
      : {};
    const normalizedScheduledAt = scheduledAt.toISOString();
    const fingerprint = publicationOperationFingerprint({
      userId: user.id,
      draftId,
      draftVersion,
      text: snapshot.text,
      media: snapshot.media,
      destinationIds,
      scheduledAt: normalizedScheduledAt,
      timezone: authoritativeSchedule.timezone,
      options: operationOptions,
    });
    if (expectedFingerprint !== null && expectedFingerprint !== fingerprint) {
      return operationError("operation_fingerprint_conflict", 409, "conflict");
    }

    const inserted = await tx.query<OperationRow>(
      `insert into publication_operations
         (user_id, draft_id, draft_version, idempotency_key, fingerprint,
          text, media, scheduled_at, timezone, schedule_offset, schedule_disambiguation,
          destination_ids, options, status)
       values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11,
               $12::jsonb, $13::jsonb, 'pending')
       on conflict do nothing
       returning id, draft_id, draft_version, fingerprint, status, scheduled_at`,
      [
        user.id,
        draftId,
        draftVersion,
        idempotencyKey,
        fingerprint,
        snapshot.text,
        snapshot.media == null ? null : JSON.stringify(snapshot.media),
        normalizedScheduledAt,
        authoritativeSchedule.timezone,
        authoritativeSchedule.offset,
        authoritativeSchedule.disambiguation,
        JSON.stringify(destinationIds),
        JSON.stringify(operationOptions),
      ],
    );
    if (inserted.rowCount !== 1) {
      const existing = (await tx.query<OperationRow>(
        `select id, draft_id, draft_version, fingerprint, status, scheduled_at
           from publication_operations
          where user_id = $1 and (idempotency_key = $2 or (draft_id = $3 and draft_version = $4))
          order by case when idempotency_key = $2 then 0 else 1 end
          limit 1 for update`,
        [user.id, idempotencyKey, draftId, draftVersion],
      )).rows[0];
      if (!existing || existing.fingerprint !== fingerprint) {
        return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      operation = existing;
      await tx.query("commit");
      open = false;
      committed = true;
      tx.release();
      tx = null;
      const dispatched = await dispatchPublicationOperation(operation);
      return NextResponse.json(
        await operationResponse(pool as unknown as Pick<PoolClient, "query">, dispatched, true),
        { status: dispatched.status === "queued" ? 200 : 207 },
      );
    }
    operation = inserted.rows[0];
    created = true;
    for (const destination of destinationRows) {
      const channelId = Number(destination.channel_id);
      const post = await tx.query<{ id: string; schedule_revision: string }>(
        `insert into posts
           (user_id, channel_id, text, media, scheduled_at, status,
            idempotency_key, request_fingerprint, publication_origin,
            publication_operation_id, publication_draft_version,
            scheduled_timezone, scheduled_offset, scheduled_disambiguation)
         values ($1, $2, $3, $4::jsonb, $5, 'scheduled', $6, $7, $8, $9, $10,
                 $11, $12, $13)
         returning id, schedule_revision`,
        [
          user.id,
          channelId,
          snapshot.text,
          snapshot.media == null ? null : JSON.stringify(snapshot.media),
          normalizedScheduledAt,
          `publication:${operation.id}:destination:${channelId}`,
          `${fingerprint}:${channelId}`,
          snapshot.origin,
          operation.id,
          draftVersion,
          authoritativeSchedule.timezone,
          authoritativeSchedule.offset,
          authoritativeSchedule.disambiguation,
        ],
      );
      await tx.query(
        `insert into publication_outbox (operation_id, post_id)
         values ($1, $2)`,
        [operation.id, post.rows[0].id],
      );
      if (destination.network === "tg") {
        for (const part of telegramParts) {
          await tx.query(
            `insert into publication_parts
               (post_id, part_index, part_type, payload_html, payload_hash, entity_length)
             values ($1, $2, $3, $4, $5, $6)`,
            [
              post.rows[0].id,
              part.index,
              part.type,
              part.payloadHtml,
              part.payloadHash,
              part.entityLength,
            ],
          );
        }
      }
    }
    await tx.query("commit");
    open = false;
    committed = true;
  } catch (error) {
    if (open && tx) {
      await tx.query("rollback").catch(() => {});
      open = false;
    }
    console.error("[/api/publication-operations]", {
      errorName: error instanceof Error ? error.name : "Error",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    if (committed && operation) {
      return operationError("publication_dispatch_unavailable", 503, "worker_unavailable", {
        retryable: true,
        operationId: Number(operation.id),
      });
    }
    return operationError("operation_not_created", 500);
  } finally {
    if (open && tx) await tx.query("rollback").catch(() => {});
    tx?.release();
    tx = null;
  }

  if (!created || !operation) throw new Error("publication operation missing");
  try {
    operation = await dispatchPublicationOperation(operation);
    const response = await operationResponse(pool as unknown as Pick<PoolClient, "query">, operation, false);
    logOperationEvent(
      operation.status === "queued" ? "publication_operation_created" : "publication_operation_partial",
      response,
      req,
    );
    return NextResponse.json(response, { status: operation.status === "queued" ? 201 : 207 });
  } catch (error) {
    console.error("[publication_event]", {
      event: "publication_operation_partial",
      requestId: requestId(req),
      operationId: Number(operation.id),
      postId: null,
      destinationId: null,
      provider: null,
      revision: 1,
      status: "dispatch_unavailable",
      safeErrorCode: error && typeof error === "object" && "code" in error
        ? String(error.code).slice(0, 80)
        : "publication_dispatch_unavailable",
    });
    return operationError("publication_dispatch_unavailable", 503, "worker_unavailable", {
      retryable: true,
      operationId: Number(operation.id),
    });
  }
}
