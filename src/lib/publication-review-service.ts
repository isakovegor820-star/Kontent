import type { Pool, PoolClient } from "pg";

import { draftRevisionContentHash } from "./editorial-approval";
import {
  normalizeProviderId,
  providerSupportsOperation,
} from "./provider-capabilities.mjs";
import {
  activateNextPublicationExtra,
  publicationExtraFingerprint,
} from "./publication-extra-operations.mjs";
import { requireSelectedProjectPermission, roleAllows } from "./project-permissions";

type TransactionPool = Pick<Pool, "connect">;
type ReviewDecision = "keep" | "update" | "unpin" | "remove_manually";

const REVIEW_DECISIONS = new Set<ReviewDecision>([
  "keep",
  "update",
  "unpin",
  "remove_manually",
]);

export class PublicationReviewError extends Error {
  readonly code:
    | "invalid_review_task"
    | "invalid_operation"
    | "invalid_decision"
    | "invalid_version"
    | "invalid_note"
    | "review_not_found"
    | "review_not_due"
    | "version_conflict"
    | "idempotency_conflict"
    | "post_not_published"
    | "review_decision_forbidden"
    | "pin_not_confirmed"
    | "operation_not_found"
    | "operation_not_retryable"
    | "fingerprint_conflict"
    | "provider_confirmation_required";

  constructor(code: PublicationReviewError["code"]) {
    super(code);
    this.name = "PublicationReviewError";
    this.code = code;
  }
}

function positiveId(value: unknown, code: PublicationReviewError["code"]) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new PublicationReviewError(code);
  return id;
}

function expectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new PublicationReviewError("invalid_version");
  }
  return version;
}

function reviewDecision(value: unknown): ReviewDecision {
  const decision = String(value || "") as ReviewDecision;
  if (!REVIEW_DECISIONS.has(decision)) throw new PublicationReviewError("invalid_decision");
  return decision;
}

function decisionNote(value: unknown) {
  if (value == null || value === "") return null;
  const note = String(value).normalize("NFC").trim().replace(/\r\n?/gu, "\n");
  if (!note || note.length > 1_000 || /\u0000/u.test(note)) {
    throw new PublicationReviewError("invalid_note");
  }
  return note;
}

function fingerprint(value: unknown) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/u.test(normalized)) {
    throw new PublicationReviewError("fingerprint_conflict");
  }
  return normalized;
}

async function withTransaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

function auditKey(action: "decision" | "retry", idempotencyKey: string) {
  return `publication-${action}:${idempotencyKey}`;
}

async function createReviewUpdateDraft(
  client: PoolClient,
  input: {
    projectId: number;
    actorUserId: number;
    reviewTaskId: number;
    postUserId: number;
    channelId: number;
    text: string;
    media: unknown;
  },
): Promise<number> {
  const draft = await client.query<{ id: number | string }>(
    `insert into drafts
       (project_id, user_id, text, media, scheduled_at, origin, source_ref,
        purpose, client_key, version)
     values ($1, $2, $3, $4::jsonb, null, 'manual', null,
             'publishable', $5, 1)
     on conflict (user_id, client_key) do update
       set updated_at = drafts.updated_at
     where drafts.project_id = excluded.project_id
     returning id`,
    [
      input.projectId,
      input.postUserId,
      input.text,
      input.media == null ? null : JSON.stringify(input.media),
      `publication-review-update:${input.projectId}:${input.reviewTaskId}`,
    ],
  );
  if (!draft.rows[0]) throw new PublicationReviewError("idempotency_conflict");
  const draftId = Number(draft.rows[0].id);
  await client.query(
    `insert into draft_destinations (draft_id, channel_id)
     values ($1, $2)
     on conflict do nothing`,
    [draftId, input.channelId],
  );

  const snapshot = {
    schemaVersion: 4,
    text: input.text,
    formatting: [],
    media: input.media ?? null,
    tracking: null,
    origin: "manual",
    purpose: "publishable",
    sourceRef: null,
    schedule: {
      scheduledAt: null,
      timezone: null,
      localDate: null,
      localTime: null,
      offset: null,
      disambiguation: null,
    },
    channelIds: [input.channelId],
    publicationPreferences: {
      version: 0,
      selectedBlocks: [],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    },
  };
  const contentHash = draftRevisionContentHash(snapshot);
  const insertedRevision = await client.query<{ id: number | string }>(
    `insert into draft_revisions
       (project_id, draft_id, draft_version, author_user_id, content_hash, snapshot)
     values ($1, $2, 1, $3, $4, $5::jsonb)
     on conflict (draft_id, draft_version) do nothing
     returning id`,
    [input.projectId, draftId, input.actorUserId, contentHash, JSON.stringify(snapshot)],
  );
  let revisionId = insertedRevision.rows[0] ? Number(insertedRevision.rows[0].id) : 0;
  if (!revisionId) {
    const existingRevision = await client.query<{ id: number | string; content_hash: string }>(
      `select id, content_hash
         from draft_revisions
        where project_id = $1 and draft_id = $2 and draft_version = 1`,
      [input.projectId, draftId],
    );
    if (!existingRevision.rows[0] || existingRevision.rows[0].content_hash !== contentHash) {
      throw new PublicationReviewError("idempotency_conflict");
    }
    revisionId = Number(existingRevision.rows[0].id);
  }
  await client.query(
    `insert into draft_editorial_workflows
       (draft_id, project_id, state, version, current_revision_id)
     values ($1, $2, 'draft', 1, $3)
     on conflict (draft_id) do nothing`,
    [draftId, input.projectId, revisionId],
  );
  return draftId;
}

export async function decidePublicationReview(input: {
  pool: TransactionPool;
  actorUserId: number;
  reviewTaskId: unknown;
  expectedVersion: unknown;
  decision: unknown;
  note?: unknown;
  idempotencyKey: string;
  requestId?: string | null;
  now?: Date;
}) {
  const reviewTaskId = positiveId(input.reviewTaskId, "invalid_review_task");
  const version = expectedVersion(input.expectedVersion);
  const decision = reviewDecision(input.decision);
  const note = decisionNote(input.note);
  const now = input.now ?? new Date();
  const idempotencyKey = auditKey("decision", input.idempotencyKey);
  const requestFingerprint = publicationExtraFingerprint({
    version: 1,
    reviewTaskId,
    expectedVersion: version,
    decision,
    note,
  });

  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.read");
    const replay = await client.query<{
      safe_data: {
        decision?: string;
        extra_operation_id?: number | string | null;
        extra_status?: string | null;
        update_draft_id?: number | string | null;
        reminder_status?: string | null;
        request_fingerprint?: string | null;
      } | null;
      after_version: number | string | null;
      actor_user_id: number | string;
    }>(
      `select safe_data, after_version, actor_user_id
         from audit_events
        where project_id = $1 and idempotency_key = $2
          and action = 'publication.review.decided'
          and entity_type = 'publication_review_task' and entity_id = $3
        limit 1`,
      [membership.projectId, idempotencyKey, String(reviewTaskId)],
    );
    if (replay.rows[0]) {
      if (
        Number(replay.rows[0].actor_user_id) !== input.actorUserId
        || replay.rows[0].safe_data?.request_fingerprint !== requestFingerprint
      ) {
        throw new PublicationReviewError("idempotency_conflict");
      }
      return {
        reviewTaskId,
        status: "completed" as const,
        decision,
        version: Number(replay.rows[0].after_version),
        extraOperationId: replay.rows[0].safe_data?.extra_operation_id == null
          ? null
          : Number(replay.rows[0].safe_data.extra_operation_id),
        extraStatus: replay.rows[0].safe_data?.extra_status == null
          ? null
          : String(replay.rows[0].safe_data.extra_status),
        draftId: replay.rows[0].safe_data?.update_draft_id == null
          ? null
          : Number(replay.rows[0].safe_data.update_draft_id),
        reminderStatus: replay.rows[0].safe_data?.reminder_status == null
          ? null
          : String(replay.rows[0].safe_data.reminder_status),
        replayed: true,
      };
    }

    const locked = await client.query<Record<string, unknown>>(
      `select task.id, task.version, task.status, task.review_at,
              task.responsible_user_id, task.update_draft_id,
              post.id as post_id, post.publication_operation_id, post.status as post_status,
              post.channel_id, post.text, post.media, post.user_id as post_user_id,
              channel.network
         from publication_review_tasks task
         join posts post on post.id = task.post_id and post.project_id = task.project_id
         join channels channel on channel.id = post.channel_id and channel.project_id = task.project_id
        where task.id = $1 and task.project_id = $2
        for update of task`,
      [reviewTaskId, membership.projectId],
    );
    const row = locked.rows[0];
    if (!row) throw new PublicationReviewError("review_not_found");
    const assigned = Number(row.responsible_user_id) === input.actorUserId;
    if (!assigned && !roleAllows(membership.role, "content.publish")) {
      throw new PublicationReviewError("review_decision_forbidden");
    }
    if (Number(row.version) !== version) throw new PublicationReviewError("version_conflict");
    if (
      !(
        row.status === "due"
        || (row.status === "scheduled" && new Date(String(row.review_at)).getTime() <= now.getTime())
      )
    ) {
      throw new PublicationReviewError("review_not_due");
    }
    if (row.post_status !== "published") {
      throw new PublicationReviewError("post_not_published");
    }

    let extraOperationId: number | null = null;
    let extraStatus: string | null = null;
    let updateDraftId: number | null = row.update_draft_id == null
      ? null
      : Number(row.update_draft_id);
    if (decision === "update" && updateDraftId == null) {
      updateDraftId = await createReviewUpdateDraft(client, {
        projectId: membership.projectId,
        actorUserId: input.actorUserId,
        reviewTaskId,
        postUserId: Number(row.post_user_id),
        channelId: Number(row.channel_id),
        text: String(row.text ?? ""),
        media: row.media,
      });
    }
    if (decision === "unpin") {
      const providerId = normalizeProviderId(row.network) || String(row.network || "").toLowerCase();
      const supported = providerSupportsOperation(providerId, "pin");
      if (!supported) throw new PublicationReviewError("pin_not_confirmed");
      const successfulPin = await client.query(
        `select 1
           from publication_extra_operations pin
          where pin.project_id = $1 and pin.post_id = $2
            and pin.kind = 'pin' and pin.status = 'succeeded'
          limit 1
          for share`,
        [membership.projectId, Number(row.post_id)],
      );
      if (!successfulPin.rows[0]) throw new PublicationReviewError("pin_not_confirmed");
      const requestSnapshot = {
        version: 1,
        providerId,
        pinned: false,
        source: "publication_review",
        reviewTaskId,
      };
      const operationFingerprint = publicationExtraFingerprint({
        version: 1,
        projectId: membership.projectId,
        postId: Number(row.post_id),
        channelId: Number(row.channel_id),
        kind: "unpin",
        requestSnapshot,
      });
      const inserted = await client.query<{ id: number | string; status: string }>(
         `insert into publication_extra_operations
           (project_id, publication_operation_id, post_id, channel_id, kind,
            sequence_index, idempotency_key, fingerprint, request_snapshot, status,
            requested_by_user_id)
         values ($1, $2, $3, $4, 'unpin', 40, $5, $6, $7::jsonb, 'waiting_dependency', $8)
         on conflict (project_id, idempotency_key) do update
           set updated_at = publication_extra_operations.updated_at
         where publication_extra_operations.fingerprint = excluded.fingerprint
         returning id, status`,
        [
          membership.projectId,
          row.publication_operation_id == null ? null : Number(row.publication_operation_id),
          Number(row.post_id),
          Number(row.channel_id),
          `publication-review:${reviewTaskId}:unpin:${operationFingerprint.slice(0, 24)}`,
          operationFingerprint,
          JSON.stringify(requestSnapshot),
          input.actorUserId,
        ],
      );
      if (!inserted.rows[0]) throw new PublicationReviewError("idempotency_conflict");
      extraOperationId = Number(inserted.rows[0].id);
      extraStatus = inserted.rows[0].status;
      await activateNextPublicationExtra(client, {
        projectId: membership.projectId,
        postId: Number(row.post_id),
      });
      const refreshed = await client.query<{ status: string }>(
        `select status from publication_extra_operations
          where id = $1 and project_id = $2`,
        [extraOperationId, membership.projectId],
      );
      extraStatus = refreshed.rows[0]?.status || "waiting_dependency";
    }

    const updated = await client.query<{ version: number | string; reminder_status: string }>(
      `update publication_review_tasks
          set status = 'completed', decision = $3, decision_note = $4,
              decided_by_user_id = $5, decided_at = $6,
              update_draft_id = $8,
              reminder_status = case
                when reminder_status = 'pending' then 'cancelled'
                else reminder_status end,
              version = version + 1, updated_at = now()
        where id = $1 and project_id = $2 and version = $7
        returning version, reminder_status`,
      [reviewTaskId, membership.projectId, decision, note, input.actorUserId, now, version, updateDraftId],
    );
    if (!updated.rows[0]) throw new PublicationReviewError("version_conflict");
    const nextVersion = Number(updated.rows[0].version);
    const reminderStatus = updated.rows[0].reminder_status;
    await client.query(
      `update publication_review_reminder_outbox
          set status = 'cancelled', lease_token = null, lease_expires_at = null,
              updated_at = now()
        where project_id = $1 and review_task_id = $2
          and status in ('pending','dispatching','enqueued','failed')`,
      [membership.projectId, reviewTaskId],
    );
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          before_version, after_version, safe_data, request_id, idempotency_key)
       values ($1, $2, 'publication.review.decided', 'publication_review_task', $3,
               $4, $5, jsonb_build_object('decision', $6::text,
                                            'extra_operation_id', $7::bigint,
                                            'extra_status', $8::text,
                                            'update_draft_id', $9::bigint,
                                            'reminder_status', $10::text,
                                            'request_fingerprint', $11::text), $12, $13)`,
      [
        membership.projectId,
        input.actorUserId,
        String(reviewTaskId),
        version,
        nextVersion,
        decision,
        extraOperationId,
        extraStatus,
        updateDraftId,
        reminderStatus,
        requestFingerprint,
        input.requestId?.slice(0, 128) ?? null,
        idempotencyKey,
      ],
    );
    return {
      reviewTaskId,
      status: "completed" as const,
      decision,
      version: nextVersion,
      extraOperationId,
      extraStatus,
      draftId: updateDraftId,
      reminderStatus,
      replayed: false,
    };
  });
}

export async function retryPublicationExtraOperation(input: {
  pool: TransactionPool;
  actorUserId: number;
  operationId: unknown;
  expectedFingerprint: unknown;
  verifiedAbsent?: unknown;
  idempotencyKey: string;
  requestId?: string | null;
}) {
  const operationId = positiveId(input.operationId, "invalid_operation");
  const expectedFingerprint = fingerprint(input.expectedFingerprint);
  const verifiedAbsent = input.verifiedAbsent === true;
  const idempotencyKey = auditKey("retry", input.idempotencyKey);
  const requestFingerprint = publicationExtraFingerprint({
    version: 1,
    operationId,
    expectedFingerprint,
    verifiedAbsent,
  });

  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.publish");
    const replay = await client.query<{
      safe_data: { fingerprint?: string; request_fingerprint?: string } | null;
      actor_user_id: number | string;
    }>(
      `select safe_data, actor_user_id
         from audit_events
        where project_id = $1 and idempotency_key = $2
          and action = 'publication.extra.retry_requested'
          and entity_type = 'publication_extra_operation' and entity_id = $3
        limit 1`,
      [membership.projectId, idempotencyKey, String(operationId)],
    );
    if (replay.rows[0]) {
      if (
        Number(replay.rows[0].actor_user_id) !== input.actorUserId
        || replay.rows[0].safe_data?.request_fingerprint !== requestFingerprint
      ) {
        throw new PublicationReviewError("idempotency_conflict");
      }
      const current = await client.query<{ status: string }>(
        `select status from publication_extra_operations
          where id = $1 and project_id = $2 and fingerprint = $3`,
        [operationId, membership.projectId, expectedFingerprint],
      );
      if (!current.rows[0]) throw new PublicationReviewError("operation_not_found");
      return { operationId, status: current.rows[0].status, replayed: true };
    }

    const locked = await client.query<Record<string, unknown>>(
      `select extra.id, extra.fingerprint, extra.status, extra.kind,
              extra.request_snapshot, extra.provider_started_at,
              extra.last_error_code, extra.post_id, post.status as post_status
         from publication_extra_operations extra
         join posts post on post.id = extra.post_id and post.project_id = extra.project_id
        where extra.id = $1 and extra.project_id = $2
        for update of extra`,
      [operationId, membership.projectId],
    );
    const row = locked.rows[0];
    if (!row) throw new PublicationReviewError("operation_not_found");
    if (String(row.fingerprint) !== expectedFingerprint) {
      throw new PublicationReviewError("fingerprint_conflict");
    }
    if (!(row.status === "failed" || row.status === "failed_retry")) {
      throw new PublicationReviewError("operation_not_retryable");
    }
    if (row.post_status !== "published") throw new PublicationReviewError("post_not_published");
    const snapshot = row.request_snapshot as { providerId?: unknown } | null;
    const ambiguousTelegramComment = row.kind === "first_comment"
      && snapshot?.providerId === "tg"
      && row.provider_started_at != null
      && ["delivery_unknown", "telegram_comment_delivery_unknown"]
        .includes(String(row.last_error_code));
    if (ambiguousTelegramComment && !verifiedAbsent) {
      throw new PublicationReviewError("provider_confirmation_required");
    }

    const saved = await client.query(
      `update publication_extra_operations
          set status = 'pending', next_attempt_at = now(),
              last_error_code = null, last_error_message = null,
              lease_token = null, lease_expires_at = null, completed_at = null,
              provider_started_at = case when $4::boolean then null else provider_started_at end,
              updated_at = now()
        where id = $1 and project_id = $2 and fingerprint = $3
          and status in ('failed','failed_retry')`,
      [operationId, membership.projectId, expectedFingerprint, ambiguousTelegramComment && verifiedAbsent],
    );
    if (saved.rowCount !== 1) throw new PublicationReviewError("operation_not_retryable");
    await client.query(
      `insert into publication_extra_outbox (project_id, operation_id, status)
       values ($1, $2, 'pending')
       on conflict (project_id, operation_id) do update
         set status = 'pending', attempts = 0, next_attempt_at = now(),
             last_error_code = null, lease_token = null, lease_expires_at = null,
             updated_at = now()`,
      [membership.projectId, operationId],
    );
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          safe_data, request_id, idempotency_key)
       values ($1, $2, 'publication.extra.retry_requested',
               'publication_extra_operation', $3,
               jsonb_build_object('fingerprint', $4::text,
                                  'provider_absence_confirmed', $5::boolean,
                                  'request_fingerprint', $6::text), $7, $8)`,
      [
        membership.projectId,
        input.actorUserId,
        String(operationId),
        expectedFingerprint,
        ambiguousTelegramComment && verifiedAbsent,
        requestFingerprint,
        input.requestId?.slice(0, 128) ?? null,
        idempotencyKey,
      ],
    );
    return { operationId, status: "pending" as const, replayed: false };
  });
}
