import { createHash } from "node:crypto";

export const PUBLICATION_EXTRA_KINDS = Object.freeze([
  "first_comment",
  "configure_comments",
  "pin",
  "unpin",
]);

const EXTRA_SEQUENCE = Object.freeze({
  first_comment: 10,
  configure_comments: 20,
  pin: 30,
  unpin: 40,
});

const TERMINAL_EXTRA_STATUSES = Object.freeze([
  "succeeded",
  "failed",
  "skipped",
  "unsupported",
  "cancelled",
]);

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

export function publicationExtraFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value)), "utf8").digest("hex");
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`invalid_${label}`);
  return id;
}

function operationSpec(input, kind, snapshot, supported) {
  const fingerprint = publicationExtraFingerprint({
    version: 1,
    projectId: input.projectId,
    publicationOperationId: input.publicationOperationId,
    postId: input.postId,
    channelId: input.channelId,
    providerId: input.providerId,
    kind,
    snapshot,
  });
  return {
    kind,
    sequenceIndex: EXTRA_SEQUENCE[kind],
    fingerprint,
    idempotencyKey: `publication-extra:${input.postId}:${kind}:${fingerprint.slice(0, 24)}`,
    requestSnapshot: Object.freeze({ version: 1, providerId: input.providerId, ...snapshot }),
    initialStatus: supported ? "waiting_dependency" : "unsupported",
  };
}

/**
 * Builds deterministic follow-up actions for one destination. Unsupported requested
 * actions are retained as terminal records so the UI can explain them; they are never
 * silently dropped or sent to the queue.
 */
export function buildPublicationExtraSpecs(rawInput) {
  const input = {
    ...rawInput,
    projectId: positiveId(rawInput.projectId, "project_id"),
    publicationOperationId: positiveId(rawInput.publicationOperationId, "publication_operation_id"),
    postId: positiveId(rawInput.postId, "post_id"),
    channelId: positiveId(rawInput.channelId, "channel_id"),
    providerId: String(rawInput.providerId || "").trim().toLowerCase(),
  };
  if (!input.providerId) throw new Error("invalid_provider_id");
  const capabilities = rawInput.capabilities || {};
  const specs = [];
  const firstComment = rawInput.blockSnapshot?.firstComment;
  if (firstComment?.delivery === "provider_comment") {
    const text = String(firstComment.text || "").trim();
    if (!text || text.length > 2_000) throw new Error("invalid_first_comment");
    const blockId = firstComment.blockId == null ? null : positiveId(firstComment.blockId, "block_id");
    const blockVersion = firstComment.blockVersion == null
      ? null
      : positiveId(firstComment.blockVersion, "block_version");
    if ((blockId == null) !== (blockVersion == null)) throw new Error("invalid_first_comment_source");
    specs.push(operationSpec(input, "first_comment", {
      text,
      blockId,
      blockVersion,
      source: String(firstComment.source || (blockId == null ? "tracking" : "block")),
      blockSnapshotHash: String(rawInput.blockSnapshot?.contentHash || ""),
    }, capabilities.firstComment === true));
  }
  if (rawInput.commentsMode === "enabled" || rawInput.commentsMode === "disabled") {
    specs.push(operationSpec(input, "configure_comments", {
      commentsEnabled: rawInput.commentsMode === "enabled",
    }, capabilities.commentToggle === true));
  } else if (rawInput.commentsMode !== "provider_default") {
    throw new Error("invalid_comments_mode");
  }
  if (rawInput.pinAfterPublish === true) {
    specs.push(operationSpec(input, "pin", { pinned: true }, capabilities.pin === true));
  } else if (rawInput.pinAfterPublish !== false) {
    throw new Error("invalid_pin_setting");
  }
  return specs;
}

export async function persistPublicationExtraSpecs(db, input) {
  const projectId = positiveId(input.projectId, "project_id");
  const publicationOperationId = positiveId(input.publicationOperationId, "publication_operation_id");
  const postId = positiveId(input.postId, "post_id");
  const channelId = positiveId(input.channelId, "channel_id");
  const actorUserId = positiveId(input.actorUserId, "actor_user_id");
  const specs = buildPublicationExtraSpecs({ ...input, projectId, publicationOperationId, postId, channelId });
  const rows = [];
  for (const spec of specs) {
    const inserted = await db.query(
      `insert into publication_extra_operations
         (project_id, publication_operation_id, post_id, channel_id, kind,
          sequence_index, idempotency_key, fingerprint, request_snapshot, status,
          requested_by_user_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11)
       on conflict (project_id, idempotency_key) do update
         set updated_at = publication_extra_operations.updated_at
       where publication_extra_operations.fingerprint = excluded.fingerprint
       returning id, kind, sequence_index, status, fingerprint`,
      [
        projectId,
        publicationOperationId,
        postId,
        channelId,
        spec.kind,
        spec.sequenceIndex,
        spec.idempotencyKey,
        spec.fingerprint,
        JSON.stringify(spec.requestSnapshot),
        spec.initialStatus,
        actorUserId,
      ],
    );
    if (!inserted.rows[0]) throw new Error("publication_extra_idempotency_conflict");
    const row = inserted.rows[0];
    rows.push(row);
    await db.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          after_version, safe_data, idempotency_key)
       values ($1, $2, 'publication.extra.created', 'publication_extra_operation', $3,
               1, jsonb_build_object('kind', $4::text, 'status', $5::text), $6)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [projectId, actorUserId, String(row.id), spec.kind, spec.initialStatus, `audit:${spec.idempotencyKey}`],
    );
  }
  return rows;
}

export async function persistPublicationReviewTask(db, input) {
  const projectId = positiveId(input.projectId, "project_id");
  const postId = positiveId(input.postId, "post_id");
  const responsibleUserId = positiveId(input.responsibleUserId, "responsible_user_id");
  const actorUserId = positiveId(input.actorUserId, "actor_user_id");
  const reviewAt = input.reviewAt instanceof Date ? input.reviewAt : new Date(String(input.reviewAt));
  if (Number.isNaN(reviewAt.getTime())) throw new Error("invalid_review_at");
  const timezone = String(input.timezone || "").trim();
  if (!timezone || timezone.length > 80) throw new Error("invalid_timezone");
  const keyHash = publicationExtraFingerprint({ version: 1, projectId, postId, reviewAt: reviewAt.toISOString() });
  const idempotencyKey = `publication-review:${postId}:${keyHash.slice(0, 32)}`;
  const inserted = await db.query(
    `insert into publication_review_tasks
       (project_id, post_id, responsible_user_id, review_at, timezone, reminder_idempotency_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (project_id, reminder_idempotency_key) do update
       set updated_at = publication_review_tasks.updated_at
     returning id, review_at, status, reminder_status`,
    [projectId, postId, responsibleUserId, reviewAt, timezone, idempotencyKey],
  );
  const row = inserted.rows[0];
  if (!row) throw new Error("publication_review_idempotency_conflict");
  await db.query(
    `insert into audit_events
       (project_id, actor_user_id, action, entity_type, entity_id,
        after_version, safe_data, idempotency_key)
     values ($1, $2, 'publication.review.scheduled', 'publication_review_task', $3,
             1, jsonb_build_object('review_at', $4::timestamptz, 'responsible_user_id', $5::bigint), $6)
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [projectId, actorUserId, String(row.id), reviewAt, responsibleUserId, `audit:${idempotencyKey}`],
  );
  return row;
}

/**
 * Promotes at most one action per post. A lower sequence must reach a terminal state
 * before a later action can be enqueued, which enforces main → comment → comments → pin.
 */
export async function activateNextPublicationExtra(db, input) {
  const projectId = positiveId(input.projectId, "project_id");
  const postId = positiveId(input.postId, "post_id");
  const next = await db.query(
    `select extra.id, extra.status, extra.sequence_index
       from publication_extra_operations extra
       join posts post on post.id = extra.post_id and post.project_id = extra.project_id
      where extra.project_id = $1 and extra.post_id = $2
        and post.status = 'published'
        and extra.status in ('waiting_dependency','pending','failed_retry','queued')
        and not exists (
          select 1 from publication_extra_operations earlier
           where earlier.project_id = extra.project_id and earlier.post_id = extra.post_id
             and earlier.sequence_index < extra.sequence_index
             and earlier.status <> all($3::text[])
        )
      order by extra.sequence_index, extra.id
      limit 1 for update of extra`,
    [projectId, postId, TERMINAL_EXTRA_STATUSES],
  );
  const row = next.rows[0];
  if (!row) return null;
  const operationId = Number(row.id);
  await db.query(
    `update publication_extra_operations
        set status = case when status = 'waiting_dependency' then 'pending' else status end,
            next_attempt_at = least(next_attempt_at, now()), updated_at = now()
      where id = $1 and project_id = $2`,
    [operationId, projectId],
  );
  await db.query(
    `insert into publication_extra_outbox (project_id, operation_id)
     values ($1, $2)
     on conflict (project_id, operation_id) do update
       set status = case
             when publication_extra_outbox.status in ('failed','cancelled') then 'pending'
             else publication_extra_outbox.status
           end,
           next_attempt_at = least(publication_extra_outbox.next_attempt_at, now()),
           last_error_code = null,
           updated_at = now()`,
    [projectId, operationId],
  );
  return operationId;
}
