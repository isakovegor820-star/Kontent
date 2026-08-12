import { NextRequest, NextResponse } from "next/server";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { getPool } from "@/lib/db";
import { draftReviewDecision } from "@/lib/draft-review";
import type { DraftHumanReview } from "@/lib/draft-types";
import {
  draftRevisionContentHash,
  EditorialValidationError,
  requireCurrentDraftApproval,
} from "@/lib/editorial-approval";
import type { DraftTrackingSelection } from "@/lib/draft-types";
import { generationBindingValid } from "@/lib/generation-artifacts";
import { configuredAppUrl } from "@/lib/password-reset";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";
import { resolveProviderLiveWriteBoundary } from "@/lib/provider-write-boundary.mjs";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import {
  normalizeOperationDestinations,
  publicationOperationFingerprint,
} from "@/lib/publication-operation";
import {
  parseApprovedPublicationPreferences,
  renderPublicationForDestination,
  type DestinationPublicationRender,
} from "@/lib/publication-destination-render";
import {
  persistPublicationExtraSpecs,
  persistPublicationReviewTask,
} from "@/lib/publication-extra-operations.mjs";
import { getPublishQueue, jobIdForPostRevision } from "@/lib/queue";
import { reconcilePublicationOutbox } from "@/lib/publication-outbox.mjs";
import { probeRedisAndPublicationWorker } from "@/lib/readiness-probes";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { createShortLinkSlug } from "@/lib/tracked-links";
import { buildTelegramCarouselParts, buildTelegramPayload } from "@/lib/telegram-payload.mjs";
import { resolveLocalSchedule, ScheduleValidationError } from "@/lib/timezone-schedule";
import {
  recheckTypographyForPublication,
  TypographyPublicationError,
} from "@/lib/typography-service";
import { normalizeTrackingDestination, normalizeUtmValues, sameUtmValues } from "@/lib/utm";

export const runtime = "nodejs";

type OperationRow = {
  id: string;
  project_id: string;
  draft_id: string | null;
  draft_version: string;
  approved_revision_id: string | null;
  approved_draft_version: string | null;
  approved_content_hash: string | null;
  fingerprint: string;
  status: string;
  scheduled_at: Date | string;
  timezone: string;
  schedule_offset: string | null;
  schedule_disambiguation: "reject" | "earlier" | "later";
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

const TRACKING_PLACEMENTS = new Set<DraftTrackingSelection["placement"]>([
  "post",
  "first_comment",
  "cta",
  "source",
]);
const SHORT_LINK_PATH = /^\/r\/[A-Za-z0-9_-]{20,64}$/u;
const SCHEDULE_OVERRIDE_KEYS = new Set([
  "scheduledAt",
  "localDate",
  "localTime",
  "timezone",
  "disambiguation",
  "offset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function scheduleOverride(value: unknown) {
  if (value == null) return null;
  if (
    !isRecord(value)
    || Object.keys(value).length !== SCHEDULE_OVERRIDE_KEYS.size
    || Object.keys(value).some((key) => !SCHEDULE_OVERRIDE_KEYS.has(key))
  ) throw new ScheduleValidationError("schedule_contract_required");
  const required = (field: "scheduledAt" | "localDate" | "localTime" | "timezone", maxLength: number) => {
    const fieldValue = value[field];
    if (typeof fieldValue !== "string" || !fieldValue || fieldValue.length > maxLength) {
      throw new ScheduleValidationError("schedule_contract_required");
    }
    return fieldValue;
  };
  const disambiguation = value.disambiguation;
  if (disambiguation !== "reject" && disambiguation !== "earlier" && disambiguation !== "later") {
    throw new ScheduleValidationError("schedule_disambiguation_required");
  }
  if (value.offset != null && (typeof value.offset !== "string" || value.offset.length > 6)) {
    throw new ScheduleValidationError("bad_schedule_offset");
  }
  return resolveLocalSchedule({
    localDate: required("localDate", 10),
    localTime: required("localTime", 5),
    timezone: required("timezone", 80),
    disambiguation,
    offset: value.offset == null || value.offset === "" ? null : value.offset,
  }, required("scheduledAt", 64));
}

const PUBLICATION_ORIGINS = new Set([
  "manual", "ai", "trend", "idea", "competitor", "rss", "autopilot",
]);
const PUBLICATION_PURPOSES = new Set(["source_context", "publishable", "needs_review"]);

function approvedPublicationSnapshot(value: unknown) {
  if (!isRecord(value) || Number(value.schemaVersion) !== 3 || !isRecord(value.schedule)) {
    throw new Error("approved_publication_snapshot_invalid");
  }
  if (
    typeof value.text !== "string"
    || typeof value.origin !== "string" || !PUBLICATION_ORIGINS.has(value.origin)
    || typeof value.purpose !== "string" || !PUBLICATION_PURPOSES.has(value.purpose)
    || !Array.isArray(value.channelIds)
  ) throw new Error("approved_publication_snapshot_invalid");
  const channelIds = [...new Set(value.channelIds.map(Number))]
    .filter((id) => Number.isSafeInteger(id) && id > 0)
    .sort((left, right) => left - right);
  if (channelIds.length !== value.channelIds.length || channelIds.length === 0) {
    throw new Error("approved_publication_snapshot_invalid");
  }
  const schedule = value.schedule;
  const nullableString = (field: string) => {
    const fieldValue = schedule[field];
    if (fieldValue == null) return null;
    if (typeof fieldValue !== "string") throw new Error("approved_publication_snapshot_invalid");
    return fieldValue;
  };
  return {
    text: value.text,
    media: value.media ?? null,
    tracking: value.tracking ?? null,
    origin: value.origin as "manual" | "ai" | "trend" | "idea" | "competitor" | "rss" | "autopilot",
    purpose: value.purpose as "source_context" | "publishable" | "needs_review",
    schedule: {
      scheduledAt: nullableString("scheduledAt"),
      timezone: nullableString("timezone"),
      localDate: nullableString("localDate"),
      localTime: nullableString("localTime"),
      offset: nullableString("offset"),
      disambiguation: nullableString("disambiguation"),
    },
    channelIds,
    publicationPreferences: value.publicationPreferences,
  };
}

function publicationTrackingSnapshot(value: unknown): DraftTrackingSelection | null {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_tracking_snapshot");
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length === 0) return null;
  const shortLinkId = record.shortLinkId == null ? null : Number(record.shortLinkId);
  const shortUrlPath = record.shortUrlPath == null ? null : String(record.shortUrlPath);
  const placement = record.placement;
  if (
    (shortLinkId != null && (!Number.isSafeInteger(shortLinkId) || shortLinkId <= 0))
    || (shortLinkId == null && shortUrlPath != null)
    || (shortLinkId != null && (!shortUrlPath || !SHORT_LINK_PATH.test(shortUrlPath)))
    || typeof placement !== "string"
    || !TRACKING_PLACEMENTS.has(placement as DraftTrackingSelection["placement"])
    || typeof record.utmValues !== "object"
    || record.utmValues == null
    || Array.isArray(record.utmValues)
  ) throw new Error("invalid_tracking_snapshot");
  return {
    shortLinkId,
    shortUrlPath,
    destination: normalizeTrackingDestination(String(record.destination ?? "")),
    utmValues: normalizeUtmValues(record.utmValues as DraftTrackingSelection["utmValues"]),
    placement: placement as DraftTrackingSelection["placement"],
  };
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
        and p.project_id = $2
        and c.project_id = $2
      order by p.channel_id`,
    [operation.id, operation.project_id],
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

async function bindMonthlyCampaignPost(
  db: Pick<PoolClient, "query">,
  input: { projectId: number; draftId: number; postId: number | string },
) {
  await db.query(
    `update monthly_campaign_items item
        set post_id = $3,
            updated_at = case when item.post_id is distinct from $3::bigint then now() else item.updated_at end
      where item.project_id = $1 and item.draft_id = $2
        and (item.post_id is null or item.post_id = $3)
      returning item.id`,
    [input.projectId, input.draftId, input.postId],
  );
  const conflict = await db.query(
    `select item.id
       from monthly_campaign_items item
      where item.project_id = $1 and item.draft_id = $2
        and item.post_id is distinct from $3::bigint
      limit 1
      for update`,
    [input.projectId, input.draftId, input.postId],
  );
  if (conflict.rows[0]) throw new Error("monthly_campaign_lineage_conflict");
}

async function dispatchPublicationOperation(operation: OperationRow): Promise<OperationRow> {
  const pool = getPool();
  const result = await reconcilePublicationOutbox({
    pool,
    operationId: Number(operation.id),
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
    schedule?: unknown;
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

  const pool = getPool();
  let projectId: number;
  try {
    projectId = (await requireSelectedProjectPermission(pool, user.id, "content.publish")).projectId;
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return operationError("forbidden", 403);
    }
    throw error;
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

  let tx: PoolClient | null = await pool.connect();
  let open = true;
  let operation: OperationRow | null = null;
  let created = false;
  let committed = false;
  try {
    await tx.query("begin");
    // Only rows created before approved-revision lineage existed may replay by the
    // historical actor/idempotency contract. Every new publication is resolved by
    // its immutable approval below, independently of the publisher who clicked it.
    const legacyReplay = (await tx.query<OperationRow>(
      `with lock_scope as materialized (
         select pg_advisory_xact_lock(hashtextextended($4, 0))
       )
       select operation.id, operation.project_id, operation.draft_id,
              operation.draft_version, operation.approved_revision_id,
              operation.approved_draft_version, operation.approved_content_hash,
              operation.fingerprint, operation.status,
              operation.scheduled_at, operation.timezone, operation.schedule_offset,
              operation.schedule_disambiguation
         from publication_operations operation
         cross join lock_scope
        where operation.project_id = $1 and operation.user_id = $2
          and operation.idempotency_key = $3
          and operation.approved_revision_id is null
        for update of operation`,
      [projectId, user.id, idempotencyKey, `publication:${projectId}:${user.id}:${idempotencyKey}`],
    )).rows[0];
    if (legacyReplay) {
      if (
        Number(legacyReplay.draft_id) !== draftId
        || Number(legacyReplay.draft_version) !== draftVersion
        || (expectedFingerprint !== null && legacyReplay.fingerprint !== expectedFingerprint)
      ) {
        return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      if (body?.schedule != null) {
        const replayApproval = await requireCurrentDraftApproval(
          tx,
          user.id,
          projectId,
          draftId,
        );
        const exactApproval = await tx.query(
          `select 1
             from draft_revisions revision
            where revision.id = $1 and revision.project_id = $2 and revision.draft_id = $3
              and revision.content_hash = $4
            limit 1 for share`,
          [replayApproval.revisionId, projectId, draftId, replayApproval.contentHash],
        );
        if (!exactApproval.rows[0]) return operationError("approval_required", 422);
        let requestedSchedule;
        try {
          requestedSchedule = scheduleOverride(body.schedule);
        } catch (error) {
          return operationError(error instanceof ScheduleValidationError ? error.code : "bad_time", 422);
        }
        if (!requestedSchedule) return operationError("schedule_contract_required", 422);
        if (new Date(requestedSchedule.scheduledAt).getTime() < Date.now() - 60_000) {
          return operationError("past", 422);
        }
        if (
          new Date(legacyReplay.scheduled_at).toISOString() !== requestedSchedule.scheduledAt
          || legacyReplay.timezone !== requestedSchedule.timezone
          || legacyReplay.schedule_offset !== requestedSchedule.offset
          || legacyReplay.schedule_disambiguation !== requestedSchedule.disambiguation
        ) return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      const replayPost = await tx.query<{ id: string }>(
        `select post.id
           from posts post
          where post.publication_operation_id = $1 and post.project_id = $2
          order by post.channel_id, post.id
          limit 1
          for update`,
        [legacyReplay.id, projectId],
      );
      if (replayPost.rows[0]) {
        await bindMonthlyCampaignPost(tx, {
          projectId,
          draftId,
          postId: replayPost.rows[0].id,
        });
      }
      operation = legacyReplay;
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
      project_id: string;
      user_id: string;
      version: string;
      text: string;
      media: unknown;
      tracking: unknown;
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
      personal_owner_user_id: string | null;
    }>(
      `select d.id, d.project_id, d.user_id, d.version, d.text, d.media, d.tracking, d.scheduled_at,
              d.scheduled_timezone, d.scheduled_local_date::text as scheduled_local_date,
              d.scheduled_local_time::text as scheduled_local_time,
              d.scheduled_offset, d.scheduled_disambiguation,
              d.origin, d.purpose,
              d.generation_result_id, result.result_hash as generation_result_hash,
              receipt.result_hash as receipt_result_hash, receipt.receipt as receipt_payload,
              d.review_policy_version, d.ai_validation,
              d.human_reviewed_version, d.human_reviewed_at,
              project.personal_owner_user_id
         from drafts d
         join projects project on project.id = d.project_id
         left join generation_results result on result.id = d.generation_result_id
         left join validation_receipts receipt on receipt.generation_result_id = result.id
        where d.id = $1 and d.project_id = $2
        for update of d`,
      [draftId, projectId],
    )).rows[0];
    if (!snapshot) {
      return operationError("draft_not_found", 404);
    }
    const editorialApproval = await requireCurrentDraftApproval(
      tx,
      user.id,
      projectId,
      draftId,
    );
    const approvedRevision = (await tx.query<{
      draft_version: string;
      content_hash: string;
      snapshot: Record<string, unknown>;
    }>(
      `select revision.draft_version, revision.content_hash, revision.snapshot
         from draft_revisions revision
        where revision.id = $1 and revision.project_id = $2 and revision.draft_id = $3
          and revision.content_hash = $4
        limit 1 for share`,
      [editorialApproval.revisionId, projectId, draftId, editorialApproval.contentHash],
    )).rows[0];
    if (!approvedRevision) {
      return operationError("approval_required", 422);
    }
    const approvedDraftVersion = Number(approvedRevision.draft_version);
    if (
      !Number.isSafeInteger(approvedDraftVersion)
      || approvedDraftVersion <= 0
      || approvedRevision.content_hash !== editorialApproval.contentHash
    ) {
      return operationError("publication_snapshot_invalid", 422);
    }
    const lineageReplay = (await tx.query<OperationRow>(
      `select operation.id, operation.project_id, operation.draft_id,
              operation.draft_version, operation.approved_revision_id,
              operation.approved_draft_version, operation.approved_content_hash,
              operation.fingerprint, operation.status,
              operation.scheduled_at, operation.timezone, operation.schedule_offset,
              operation.schedule_disambiguation
         from publication_operations operation
        where operation.project_id = $1 and operation.draft_id = $2
          and operation.approved_revision_id = $3
        limit 1
        for update`,
      [projectId, draftId, editorialApproval.revisionId],
    )).rows[0];
    if (lineageReplay) {
      if (
        Number(lineageReplay.approved_draft_version) !== approvedDraftVersion
        || lineageReplay.approved_content_hash !== approvedRevision.content_hash
        || (expectedFingerprint !== null && lineageReplay.fingerprint !== expectedFingerprint)
      ) {
        return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      if (body?.schedule != null) {
        let requestedSchedule;
        try {
          requestedSchedule = scheduleOverride(body.schedule);
        } catch (error) {
          return operationError(error instanceof ScheduleValidationError ? error.code : "bad_time", 422);
        }
        if (!requestedSchedule) return operationError("schedule_contract_required", 422);
        if (new Date(requestedSchedule.scheduledAt).getTime() < Date.now() - 60_000) {
          return operationError("past", 422);
        }
        if (
          new Date(lineageReplay.scheduled_at).toISOString() !== requestedSchedule.scheduledAt
          || lineageReplay.timezone !== requestedSchedule.timezone
          || lineageReplay.schedule_offset !== requestedSchedule.offset
          || lineageReplay.schedule_disambiguation !== requestedSchedule.disambiguation
        ) return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      const replayPost = await tx.query<{ id: string }>(
        `select post.id
           from posts post
          where post.publication_operation_id = $1 and post.project_id = $2
          order by post.channel_id, post.id
          limit 1
          for update`,
        [lineageReplay.id, projectId],
      );
      if (replayPost.rows[0]) {
        await bindMonthlyCampaignPost(tx, {
          projectId,
          draftId,
          postId: replayPost.rows[0].id,
        });
      }
      operation = lineageReplay;
      await tx.query("commit");
      open = false;
      committed = true;
      tx.release();
      tx = null;
      const dispatched = await dispatchPublicationOperation(operation);
      const response = await operationResponse(
        pool as unknown as Pick<PoolClient, "query">,
        dispatched,
        true,
      );
      return NextResponse.json(response, { status: dispatched.status === "queued" ? 200 : 207 });
    }
    if (Number(snapshot.version) !== draftVersion) {
      return operationError("draft_version_conflict", 409, "conflict", {
        currentVersion: Number(snapshot.version),
      });
    }
    let approvedSnapshot;
    try {
      approvedSnapshot = approvedPublicationSnapshot(approvedRevision.snapshot);
    } catch {
      return operationError("publication_snapshot_invalid", 422);
    }
    let requestedScheduleOverride;
    try {
      requestedScheduleOverride = scheduleOverride(body?.schedule);
    } catch (error) {
      return operationError(error instanceof ScheduleValidationError ? error.code : "bad_time", 422);
    }
    let publicationPreferences;
    try {
      publicationPreferences = parseApprovedPublicationPreferences(
        approvedSnapshot.publicationPreferences ?? {
          version: 0,
          selectedBlocks: [],
          firstCommentFallback: "skip",
          commentsMode: "provider_default",
          pinAfterPublish: false,
          reviewAt: null,
          reviewResponsibleUserId: null,
        },
        projectId,
      );
    } catch {
      return operationError("publication_preferences_invalid", 422);
    }
    if (approvedSnapshot.purpose === "source_context") {
      return operationError("source_context_not_publishable", 422);
    }
    let authoritativeSchedule;
    if (requestedScheduleOverride) {
      authoritativeSchedule = requestedScheduleOverride;
    } else {
      if (!approvedSnapshot.schedule.scheduledAt) {
        return operationError("schedule_required", 422);
      }
      if (
        !approvedSnapshot.schedule.timezone || !approvedSnapshot.schedule.localDate
        || !approvedSnapshot.schedule.localTime
        || (
          approvedSnapshot.schedule.disambiguation !== "reject"
          && approvedSnapshot.schedule.disambiguation !== "earlier"
          && approvedSnapshot.schedule.disambiguation !== "later"
        )
      ) {
        return operationError("schedule_metadata_required", 422);
      }
      try {
        authoritativeSchedule = resolveLocalSchedule({
          localDate: approvedSnapshot.schedule.localDate.slice(0, 10),
          localTime: approvedSnapshot.schedule.localTime.slice(0, 5),
          timezone: approvedSnapshot.schedule.timezone,
          disambiguation: approvedSnapshot.schedule.disambiguation,
          offset: approvedSnapshot.schedule.offset,
        }, new Date(approvedSnapshot.schedule.scheduledAt).toISOString());
      } catch (error) {
        return operationError(
          error instanceof ScheduleValidationError ? error.code : "bad_time",
          422,
        );
      }
    }
    if (!requestedScheduleOverride && timezone !== authoritativeSchedule.timezone) {
      return operationError("schedule_timezone_conflict", 409, "conflict");
    }
    const scheduledAt = new Date(authoritativeSchedule.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime()) || scheduledAt.getTime() < Date.now() - 60_000) {
      return operationError("past", 422);
    }
    if (publicationPreferences.reviewAt) {
      if (new Date(publicationPreferences.reviewAt).getTime() <= scheduledAt.getTime()) {
        return operationError("review_must_follow_publication", 422);
      }
      const responsible = await tx.query(
        `select 1 from project_members
          where project_id = $1 and user_id = $2 and status = 'active' limit 1`,
        [projectId, publicationPreferences.reviewResponsibleUserId],
      );
      if (!responsible.rows[0]) {
        return operationError("review_responsible_unavailable", 422);
      }
    }
    const destinationRows = (await tx.query<{ channel_id: string; network: string }>(
      `select channel.id as channel_id, channel.network
         from channels channel
        where channel.id = any($1::bigint[]) and channel.project_id = $2
          and channel.is_active = true and channel.status = 'active'
        order by channel.id`,
      [approvedSnapshot.channelIds, projectId],
    )).rows;
    const blockedDestination = destinationRows
      .map((destination) => ({
        destination,
        boundary: resolveProviderLiveWriteBoundary(destination.network),
      }))
      .find(({ boundary }) => !boundary.allowed);
    if (blockedDestination) {
      return operationError(
        blockedDestination.boundary.error || "provider_operation_unsupported",
        blockedDestination.boundary.error === "official_access_required" ? 409 : 422,
        "operation_not_created",
        {
          providerId: blockedDestination.boundary.providerId,
          code: blockedDestination.boundary.code,
          terminal: blockedDestination.boundary.terminal,
          retryable: blockedDestination.boundary.retryable,
          exportAvailable: blockedDestination.boundary.exportAvailable,
          livePublished: false,
        },
      );
    }
    const destinationIds = normalizeOperationDestinations(
      destinationRows.map((row) => Number(row.channel_id)),
    );
    if (
      !destinationIds.length
      || destinationIds.length !== approvedSnapshot.channelIds.length
      || destinationIds.some((id, index) => id !== approvedSnapshot.channelIds[index])
    ) {
      return operationError("destination_unavailable", 422);
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
      origin: approvedSnapshot.origin,
      purpose: approvedSnapshot.purpose,
      generation_result_id: snapshot.generation_result_id == null ? null : Number(snapshot.generation_result_id),
      generation_binding_valid: generationBindingValid({
        generationResultId: snapshot.generation_result_id,
        text: approvedSnapshot.text,
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
    if (review === "blocked") {
      return operationError("ai_draft_blocked", 422);
    }
    // The immutable revision reached this point through exact editorial approval.
    // Internal AI quality checks may guide generation, but they do not take a
    // generated post away from the user after the post is ready.
    let typographySnapshot;
    try {
      typographySnapshot = await recheckTypographyForPublication({
        db: tx,
        projectId,
        text: approvedSnapshot.text,
        // The exact immutable revision has already been approved by an authorized
        // editor. Composer no longer exposes a second typography-review panel, so
        // that approval is the durable decision to keep the wording as written.
        allowPublishAsIs: true,
      });
    } catch (error) {
      if (error instanceof TypographyPublicationError) {
        return operationError(error.code, 422, "operation_not_created", {
          dictionaryVersion: error.dictionaryVersion,
          suggestionCount: error.suggestionCount,
        });
      }
      throw error;
    }
    const media = approvedSnapshot.media && typeof approvedSnapshot.media === "object"
      ? approvedSnapshot.media as Record<string, unknown>
      : null;
    const carouselItems = media?.kind === "carousel" && Array.isArray(media.items)
      ? media.items.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item))
      : [];
    let carouselAssets: Array<{ id: number; sha256: string; mimeType: string }> = [];
    let trackingSnapshot: DraftTrackingSelection | null;
    try {
      trackingSnapshot = publicationTrackingSnapshot(approvedSnapshot.tracking);
    } catch {
      return operationError("tracking_snapshot_invalid", 500);
    }
    if (trackingSnapshot?.shortLinkId != null) {
      const link = (await tx.query<{
        slug: string;
        destination_url: string;
        utm_values: unknown;
      }>(
        `select slug, destination_url, utm_values
           from short_links
          where id = $1 and project_id = $2 and status = 'active'
            and revoked_at is null and (expires_at is null or expires_at > now())
          for share`,
        [trackingSnapshot.shortLinkId, projectId],
      )).rows[0];
      let matchesApprovedSnapshot = false;
      try {
        matchesApprovedSnapshot = Boolean(link)
          && trackingSnapshot.shortUrlPath === `/r/${link.slug}`
          && trackingSnapshot.destination === normalizeTrackingDestination(link.destination_url)
          && sameUtmValues(
            trackingSnapshot.utmValues,
            link.utm_values as DraftTrackingSelection["utmValues"],
          );
      } catch {
        matchesApprovedSnapshot = false;
      }
      if (!matchesApprovedSnapshot) {
        return operationError("tracking_link_unavailable", 422);
      }
    }
    const destinationTrackingSnapshots = new Map<number, DraftTrackingSelection | null>();
    const destinationRenders = new Map<number, DestinationPublicationRender>();
    try {
      for (const destination of destinationRows) {
        const channelId = Number(destination.channel_id);
        // A saved short link can be reused across drafts, but every published
        // destination receives an opaque server-owned redirect identity. This is
        // the only URL rendered into the post and makes click attribution exact.
        const destinationTracking = trackingSnapshot?.shortLinkId == null
          ? trackingSnapshot
          : { ...trackingSnapshot, shortUrlPath: `/r/${createShortLinkSlug()}` };
        destinationTrackingSnapshots.set(channelId, destinationTracking);
        destinationRenders.set(channelId, renderPublicationForDestination({
          projectId,
          body: approvedSnapshot.text,
          providerId: destination.network,
          preferences: publicationPreferences,
          tracking: destinationTracking,
          appUrl: configuredAppUrl() ?? req.nextUrl.origin,
        }));
      }
    } catch {
      return operationError("publication_snapshot_invalid", 422);
    }
    const primaryRender = destinationRenders.get(destinationIds[0]);
    if (!primaryRender) return operationError("publication_snapshot_invalid", 422);
    const primaryTrackingSnapshot = destinationTrackingSnapshots.get(destinationIds[0]) ?? null;
    const primaryTrackingSnapshotHash = primaryTrackingSnapshot == null
      ? null
      : draftRevisionContentHash({ schemaVersion: 1, ...primaryTrackingSnapshot });
    const mediaAssetId = Number(media?.assetId);
    if (media?.kind === "carousel") {
      if (destinationRows.some((destination) => destination.network !== "tg")) {
        return operationError("media_unsupported_for_destination", 422);
      }
      const assetIds = carouselItems.map((item) => Number(item.assetId));
      if (
        assetIds.length < 3 || assetIds.length > 7
        || assetIds.some((id) => !Number.isSafeInteger(id) || id <= 0)
        || new Set(assetIds).size !== assetIds.length
      ) {
        return operationError("media_not_found", 404);
      }
      const rows = (await tx.query<{
        id: number | string;
        kind: string;
        sha256: string;
        mime_type: string;
      }>(
        `select asset.id, asset.kind, asset.sha256, asset.mime_type
           from media_assets asset
           join drafts draft
             on draft.id = $2 and draft.project_id = $3
            and draft.project_id = asset.project_id
          where asset.id = any($1::bigint[])
          order by array_position($1::bigint[], asset.id)
          for share of asset`,
        [assetIds, draftId, projectId],
      )).rows;
      if (
        rows.length !== assetIds.length
        || rows.some((row, index) => row.kind !== "image" || Number(row.id) !== assetIds[index])
      ) {
        return operationError("media_not_found", 404);
      }
      carouselAssets = rows.map((row) => ({ id: Number(row.id), sha256: row.sha256, mimeType: row.mime_type }));
      const renderOperationId = Number(media.renderOperationId);
      if (Number.isSafeInteger(renderOperationId) && renderOperationId > 0) {
        const lineage = (await tx.query<{ asset_ids: Array<number | string> }>(
          `select array_agg(card.media_asset_id order by card.card_order) as asset_ids
             from legal_visual_render_operations operation
             join legal_visual_render_cards card
               on card.operation_id = operation.id
              and card.project_id = operation.project_id
              and card.design_id = operation.design_id
            where operation.id = $1 and operation.project_id = $2 and operation.status = 'ready'
            group by operation.id`,
          [renderOperationId, projectId],
        )).rows[0];
        if (!lineage || lineage.asset_ids.map(Number).join(",") !== assetIds.join(",")) {
          return operationError("media_not_found", 404);
        }
      }
    } else if (Number.isSafeInteger(mediaAssetId) && mediaAssetId > 0) {
      const mediaAsset = await tx.query<{ kind: string }>(
        `select asset.kind
           from media_assets asset
          join drafts draft
             on draft.id = $2
            and draft.project_id = $3
            and draft.project_id = asset.project_id
          where asset.id = $1
          limit 1
          for share of asset`,
        [mediaAssetId, draftId, projectId],
      );
      if (mediaAsset.rows[0]?.kind !== media?.kind) {
        return operationError("media_not_found", 404);
      }
    }
    const telegramRender = destinationRows
      .filter((destination) => destination.network === "tg")
      .map((destination) => destinationRenders.get(Number(destination.channel_id)))
      .find((render): render is DestinationPublicationRender => render != null);
    const telegramParts = (telegramRender
      ? carouselAssets.length > 0
        ? buildTelegramCarouselParts({
            assetCount: carouselAssets.length,
            text: telegramRender.mainText,
          })
        : buildTelegramPayload({
            text: telegramRender.mainText,
            hasAsset: Number.isSafeInteger(Number(media?.assetId)) && Number(media?.assetId) > 0,
          }).parts
      : []).map((part) => ({
      ...part,
      payloadHash: createHash("sha256")
        .update(`${part.type}\0${part.payloadHtml || ""}`)
        .digest("hex"),
    }));
    const operationOptions = {
      fingerprintVersion: 2,
      editorialApproval: {
        revisionId: editorialApproval.revisionId,
        draftVersion: approvedDraftVersion,
        contentHash: editorialApproval.contentHash,
      },
      typography: typographySnapshot,
      tracking: primaryTrackingSnapshot == null
        ? null
        : {
            ...primaryTrackingSnapshot,
            snapshotHash: primaryTrackingSnapshotHash,
            publicUrl: primaryRender.publicUrl,
            firstCommentText: primaryRender.firstCommentText,
          },
      publicationSettings: {
        version: publicationPreferences.version,
        firstCommentFallback: publicationPreferences.firstCommentFallback,
        commentsMode: publicationPreferences.commentsMode,
        pinAfterPublish: publicationPreferences.pinAfterPublish,
        reviewAt: publicationPreferences.reviewAt,
        reviewResponsibleUserId: publicationPreferences.reviewResponsibleUserId,
        destinations: destinationRows.map((destination) => {
          const channelId = Number(destination.channel_id);
          const rendered = destinationRenders.get(channelId);
          const destinationTracking = destinationTrackingSnapshots.get(channelId) ?? null;
          if (!rendered) throw new Error("publication_snapshot_invalid");
          return {
            channelId,
            providerId: destination.network,
            mainTextHash: createHash("sha256").update(rendered.mainText, "utf8").digest("hex"),
            firstCommentText: rendered.firstCommentText,
            tracking: destinationTracking == null
              ? null
              : {
                  shortLinkId: destinationTracking.shortLinkId,
                  shortUrlPath: destinationTracking.shortUrlPath,
                  snapshotHash: draftRevisionContentHash({ schemaVersion: 1, ...destinationTracking }),
                  publicUrl: rendered.publicUrl,
                },
            blockSnapshot: rendered.blockSnapshot,
            capabilities: rendered.capabilities,
          };
        }),
      },
      ...(telegramRender
        ? {
            telegramPayloadVersion: 1,
            telegramParts: telegramParts.map((part) => ({
              index: part.index,
              type: part.type,
              entityLength: part.entityLength,
              payloadHash: part.payloadHash,
            })),
          }
        : {}),
      ...(carouselAssets.length > 0
        ? {
            telegramCarousel: {
              version: 1,
              assets: carouselAssets,
            },
          }
        : {}),
    };
    const normalizedScheduledAt = scheduledAt.toISOString();
    // Fingerprint v2 describes the approved publication, not the employee who
    // happened to press Publish. The immutable revision lineage is already part
    // of operationOptions, so all authorized publishers derive the same digest.
    const fingerprint = publicationOperationFingerprint({
      userId: 0,
      draftId,
      draftVersion: approvedDraftVersion,
      text: primaryRender.mainText,
      media: approvedSnapshot.media,
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
         (project_id, user_id, draft_id, draft_version, idempotency_key, fingerprint,
          text, media, scheduled_at, timezone, schedule_offset, schedule_disambiguation,
          destination_ids, options, approved_revision_id, approved_draft_version,
          approved_content_hash, status)
       values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12,
               $13::jsonb, $14::jsonb, $15, $16, $17, 'pending')
       on conflict do nothing
       returning id, project_id, draft_id, draft_version,
                 approved_revision_id, approved_draft_version, approved_content_hash,
                 fingerprint, status, scheduled_at, timezone, schedule_offset,
                 schedule_disambiguation`,
      [
        projectId,
        user.id,
        draftId,
        approvedDraftVersion,
        idempotencyKey,
        fingerprint,
        primaryRender.mainText,
        approvedSnapshot.media == null ? null : JSON.stringify(approvedSnapshot.media),
        normalizedScheduledAt,
        authoritativeSchedule.timezone,
        authoritativeSchedule.offset,
        authoritativeSchedule.disambiguation,
        JSON.stringify(destinationIds),
        JSON.stringify(operationOptions),
        editorialApproval.revisionId,
        approvedDraftVersion,
        approvedRevision.content_hash,
      ],
    );
    if (inserted.rowCount !== 1) {
      const existing = (await tx.query<OperationRow>(
        `select id, project_id, draft_id, draft_version,
                approved_revision_id, approved_draft_version, approved_content_hash,
                fingerprint, status, scheduled_at, timezone, schedule_offset,
                schedule_disambiguation
           from publication_operations
          where project_id = $1 and draft_id = $2 and approved_revision_id = $3
          limit 1 for update`,
        [projectId, draftId, editorialApproval.revisionId],
      )).rows[0];
      if (
        !existing
        || existing.fingerprint !== fingerprint
        || Number(existing.approved_revision_id) !== editorialApproval.revisionId
        || Number(existing.approved_draft_version) !== approvedDraftVersion
        || existing.approved_content_hash !== approvedRevision.content_hash
      ) {
        return operationError("idempotency_fingerprint_conflict", 409, "conflict");
      }
      operation = existing;
      const replayPost = await tx.query<{ id: string }>(
        `select post.id
           from posts post
          where post.publication_operation_id = $1 and post.project_id = $2
          order by post.channel_id, post.id
          limit 1
          for update`,
        [operation.id, projectId],
      );
      if (replayPost.rows[0]) {
        await bindMonthlyCampaignPost(tx, {
          projectId,
          draftId,
          postId: replayPost.rows[0].id,
        });
      }
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
      const destinationRender = destinationRenders.get(channelId);
      const destinationTracking = destinationTrackingSnapshots.get(channelId) ?? null;
      if (!destinationRender) throw new Error("publication_snapshot_invalid");
      const post = await tx.query<{ id: string; schedule_revision: string }>(
        `insert into posts
           (project_id, user_id, channel_id, text, media, scheduled_at, status,
            idempotency_key, request_fingerprint, publication_origin,
            publication_operation_id, publication_draft_version,
            scheduled_timezone, scheduled_offset, scheduled_disambiguation)
         values ($1, $2, $3, $4, $5::jsonb, $6, 'scheduled', $7, $8, $9, $10, $11,
                 $12, $13, $14)
         returning id, schedule_revision`,
        [
          projectId,
          user.id,
          channelId,
          destinationRender.mainText,
          approvedSnapshot.media == null ? null : JSON.stringify(approvedSnapshot.media),
          normalizedScheduledAt,
          `publication:${operation.id}:destination:${channelId}`,
          `${fingerprint}:${channelId}`,
          approvedSnapshot.origin,
          operation.id,
          approvedDraftVersion,
          authoritativeSchedule.timezone,
          authoritativeSchedule.offset,
          authoritativeSchedule.disambiguation,
        ],
      );
      if (channelId === destinationIds[0]) {
        await bindMonthlyCampaignPost(tx, {
          projectId,
          draftId,
          postId: post.rows[0].id,
        });
      }
      await tx.query(
        `insert into publication_outbox (operation_id, post_id)
         values ($1, $2)`,
        [operation.id, post.rows[0].id],
      );
      await persistPublicationExtraSpecs(tx, {
        projectId,
        publicationOperationId: Number(operation.id),
        postId: Number(post.rows[0].id),
        channelId,
        providerId: destination.network,
        actorUserId: user.id,
        blockSnapshot: destinationRender.blockSnapshot,
        commentsMode: publicationPreferences.commentsMode,
        pinAfterPublish: publicationPreferences.pinAfterPublish,
        capabilities: destinationRender.capabilities,
      });
      if (
        publicationPreferences.reviewAt
        && publicationPreferences.reviewResponsibleUserId != null
      ) {
        await persistPublicationReviewTask(tx, {
          projectId,
          postId: Number(post.rows[0].id),
          responsibleUserId: publicationPreferences.reviewResponsibleUserId,
          actorUserId: user.id,
          reviewAt: publicationPreferences.reviewAt,
          timezone: authoritativeSchedule.timezone,
        });
      }
      if (destinationTracking) {
        let shortLinkPlacementId: number | null = null;
        if (destinationTracking.shortLinkId != null) {
          const placementSlug = destinationTracking.shortUrlPath?.slice(3) ?? "";
          if (!/^[A-Za-z0-9_-]{20,64}$/u.test(placementSlug)) {
            throw new Error("publication_tracking_placement_invalid");
          }
          const placement = await tx.query<{ id: string }>(
            `insert into short_link_placements
               (project_id, short_link_id, publication_operation_id, post_id, slug)
             values ($1, $2, $3, $4, $5)
             returning id`,
            [projectId, destinationTracking.shortLinkId, operation.id, post.rows[0].id, placementSlug],
          );
          shortLinkPlacementId = Number(placement.rows[0].id);
        }
        const destinationTrackingSnapshotHash = draftRevisionContentHash({
          schemaVersion: 1,
          ...destinationTracking,
        });
        await tx.query(
          `insert into publication_tracking_snapshots
             (project_id, publication_operation_id, post_id, short_link_id, short_link_placement_id, placement,
              destination_url, short_url_path, utm_values, snapshot_hash)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10)`,
          [
            projectId,
            operation.id,
            post.rows[0].id,
            destinationTracking.shortLinkId,
            shortLinkPlacementId,
            destinationTracking.placement,
            destinationTracking.destination,
            destinationTracking.shortUrlPath,
            JSON.stringify(destinationTracking.utmValues),
            destinationTrackingSnapshotHash,
          ],
        );
      }
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
    await tx.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id, after_version,
         safe_data, request_id, idempotency_key
       ) values ($1, $2, 'publication.scheduled', 'publication_operation', $3, 1,
                 $4::jsonb, $5, $6)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        projectId,
        user.id,
        String(operation.id),
        JSON.stringify({
          draftId,
          draftVersion: approvedDraftVersion,
          requestedDraftVersion: draftVersion,
          approvedRevisionId: editorialApproval.revisionId,
          approvedContentHash: approvedRevision.content_hash,
          scheduledAt: authoritativeSchedule.scheduledAt,
          timezone: authoritativeSchedule.timezone,
          offset: authoritativeSchedule.offset,
          disambiguation: authoritativeSchedule.disambiguation,
          scheduleOverride: requestedScheduleOverride != null,
        }),
        requestId(req),
        `publication:scheduled:${operation.id}`,
      ],
    );
    await tx.query("commit");
    open = false;
    committed = true;
  } catch (error) {
    if (open && tx) {
      await tx.query("rollback").catch(() => {});
      open = false;
    }
    if (committed && operation) {
      return operationError("publication_dispatch_unavailable", 503, "worker_unavailable", {
        retryable: true,
        operationId: Number(operation.id),
      });
    }
    if (error instanceof ProjectAccessError) {
      return operationError("forbidden", 403);
    }
    if (error instanceof EditorialValidationError) {
      return operationError(error.code, 422);
    }
    console.error("[/api/publication-operations]", {
      errorName: error instanceof Error ? error.name : "Error",
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
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
