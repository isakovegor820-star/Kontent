import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { draftRevisionContentHash } from "./editorial-revision.mjs";
import {
  requireProjectPermission,
  requireSelectedProjectPermission,
  type ProjectPermission,
} from "./project-permissions";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

export const EDITORIAL_STATES = ["draft", "in_review", "changes_requested", "approved"] as const;
export type EditorialState = (typeof EDITORIAL_STATES)[number];
export type EditorialDecision = "approve" | "request_changes";

export type DraftRevision = {
  id: number;
  projectId: number;
  draftId: number;
  draftVersion: number;
  authorUserId: number;
  authorName?: string;
  contentHash: string;
  snapshot: Record<string, unknown>;
  createdAt: string;
};

export type DraftRevisionHistoryItem = Pick<
  DraftRevision,
  "id" | "draftId" | "draftVersion" | "authorUserId" | "authorName" | "snapshot" | "createdAt"
>;

export type EditorialWorkflow = {
  draftId: number;
  projectId: number;
  state: EditorialState;
  version: number;
  currentRevisionId: number;
  submittedRevisionId: number | null;
  approvedRevisionId: number | null;
  approvedContentHash: string | null;
  updatedAt: string;
};

export type EditorialRequest = {
  id: number;
  revisionId: number;
  contentHash: string;
  requestedByUserId: number;
  requestedByName?: string;
  status: "open" | "approved" | "changes_requested" | "superseded";
  version: number;
  requestedAt: string;
  resolvedAt: string | null;
};

export type EditorialComment = {
  id: number;
  revisionId: number;
  contentHash: string;
  authorUserId: number;
  authorName?: string;
  body: string;
  createdAt: string;
};

export type EditorialDecisionRecord = {
  id: number;
  requestId: number;
  revisionId: number;
  contentHash: string;
  actorUserId: number;
  actorName?: string;
  decision: EditorialDecision;
  note: string | null;
  createdAt: string;
};

export type EditorialSnapshot = {
  workflow: EditorialWorkflow;
  currentRevision: DraftRevision;
  request: EditorialRequest | null;
  comments: EditorialComment[];
  decisions: EditorialDecisionRecord[];
};

export class EditorialValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "EditorialValidationError";
  }
}

export class EditorialNotFoundError extends Error {
  constructor() {
    super("not_found");
    this.name = "EditorialNotFoundError";
  }
}

export class EditorialConflictError extends Error {
  constructor(public readonly code: "stale_revision" | "stale_workflow" | "stale_request" | "review_open") {
    super(code);
    this.name = "EditorialConflictError";
  }
}

type RevisionRef = { revisionId: number; contentHash: string };
type SubmitInput = RevisionRef & { workflowVersion: number };
type CommentInput = RevisionRef & { body: string };
type DecisionInput = RevisionRef & {
  requestId: number;
  requestVersion: number;
  workflowVersion: number;
  decision: EditorialDecision;
  note: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function positiveInteger(value: unknown, code: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new EditorialValidationError(code);
  return number;
}

function contentHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new EditorialValidationError("bad_content_hash");
  }
  return value;
}

export function parseEditorialSubmitInput(value: unknown): SubmitInput {
  if (!isRecord(value)) throw new EditorialValidationError("bad_request");
  return {
    revisionId: positiveInteger(value.revisionId, "bad_revision"),
    contentHash: contentHash(value.contentHash),
    workflowVersion: positiveInteger(value.workflowVersion, "bad_workflow_version"),
  };
}

export function parseEditorialCommentInput(value: unknown): CommentInput {
  if (!isRecord(value)) throw new EditorialValidationError("bad_request");
  const body = typeof value.body === "string" ? value.body.trim() : "";
  if (!body || body.length > 4_000) throw new EditorialValidationError("bad_comment");
  return {
    revisionId: positiveInteger(value.revisionId, "bad_revision"),
    contentHash: contentHash(value.contentHash),
    body,
  };
}

export function parseEditorialDecisionInput(value: unknown): DecisionInput {
  if (!isRecord(value)) throw new EditorialValidationError("bad_request");
  const decision = value.decision;
  if (decision !== "approve" && decision !== "request_changes") {
    throw new EditorialValidationError("bad_decision");
  }
  const cleanNote = value.note == null ? "" : String(value.note).trim();
  if (cleanNote.length > 4_000 || (decision === "request_changes" && !cleanNote)) {
    throw new EditorialValidationError("decision_note_required");
  }
  return {
    requestId: positiveInteger(value.requestId, "bad_request_id"),
    requestVersion: positiveInteger(value.requestVersion, "bad_request_version"),
    workflowVersion: positiveInteger(value.workflowVersion, "bad_workflow_version"),
    revisionId: positiveInteger(value.revisionId, "bad_revision"),
    contentHash: contentHash(value.contentHash),
    decision,
    note: cleanNote || null,
  };
}

export { draftRevisionContentHash } from "./editorial-revision.mjs";

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

type DraftSnapshotRow = {
  id: number | string;
  project_id: number | string;
  user_id: number | string;
  version: number | string;
  text: string;
  media: unknown;
  tracking?: unknown;
  origin: string;
  purpose: string;
  source_ref: unknown;
  scheduled_at: Date | string | null;
  scheduled_timezone: string | null;
  scheduled_local_date: Date | string | null;
  scheduled_local_time: string | null;
  scheduled_offset: string | null;
  scheduled_disambiguation: string | null;
  channel_ids: unknown;
  publication_preferences: unknown;
};

function snapshotFromDraft(row: DraftSnapshotRow): Record<string, unknown> {
  const channelIds = Array.isArray(row.channel_ids)
    ? row.channel_ids.map(Number).filter(Number.isSafeInteger).sort((left, right) => left - right)
    : [];
  return {
    schemaVersion: 3,
    text: row.text,
    media: row.media ?? null,
    tracking: row.tracking ?? null,
    origin: row.origin,
    purpose: row.purpose,
    sourceRef: row.source_ref ?? null,
    schedule: {
      scheduledAt: row.scheduled_at == null ? null : iso(row.scheduled_at),
      timezone: row.scheduled_timezone,
      localDate: row.scheduled_local_date == null ? null : String(row.scheduled_local_date).slice(0, 10),
      localTime: row.scheduled_local_time == null ? null : String(row.scheduled_local_time).slice(0, 5),
      offset: row.scheduled_offset,
      disambiguation: row.scheduled_disambiguation,
    },
    channelIds,
    publicationPreferences: row.publication_preferences ?? {
      version: 0,
      selectedBlocks: [],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    },
  };
}

async function loadDraftSnapshot(
  db: Queryable,
  draftId: number,
  projectId?: number,
): Promise<DraftSnapshotRow | null> {
  const result = await db.query<DraftSnapshotRow>(
    `select draft.id, draft.project_id, draft.user_id, draft.version,
            draft.text, draft.media, draft.tracking, draft.origin, draft.purpose, draft.source_ref,
            draft.scheduled_at, draft.scheduled_timezone,
            to_char(draft.scheduled_local_date, 'YYYY-MM-DD') as scheduled_local_date,
            to_char(draft.scheduled_local_time, 'HH24:MI') as scheduled_local_time,
            draft.scheduled_offset, draft.scheduled_disambiguation,
            coalesce((
              select array_agg(destination.channel_id order by destination.channel_id)
                from draft_destinations destination
               where destination.draft_id = draft.id
            ), '{}') as channel_ids,
            coalesce((
              select jsonb_build_object(
                'version', preference.version,
                'selectedBlocks', coalesce((
                  select jsonb_agg(jsonb_build_object(
                    'id', block.id,
                    'kind', block.kind,
                    'name', block.name,
                    'text', block.body,
                    'version', block.version
                  ) order by selection.position)
                    from jsonb_array_elements_text(preference.selected_block_ids)
                         with ordinality as selection(block_id, position)
                    join project_publication_blocks block
                      on block.id = selection.block_id::bigint
                     and block.project_id = preference.project_id
                ), '[]'::jsonb),
                'firstCommentFallback', preference.first_comment_fallback,
                'commentsMode', preference.comments_mode,
                'pinAfterPublish', preference.pin_after_publish,
                'reviewAt', preference.review_at,
                'reviewResponsibleUserId', preference.review_responsible_user_id
              )
                from draft_publication_preferences preference
               where preference.draft_id = draft.id and preference.project_id = draft.project_id
            ), jsonb_build_object(
              'version', 0,
              'selectedBlocks', '[]'::jsonb,
              'firstCommentFallback', 'skip',
              'commentsMode', 'provider_default',
              'pinAfterPublish', false,
              'reviewAt', null,
              'reviewResponsibleUserId', null
            )) as publication_preferences
       from drafts draft
      where draft.id = $1
        and ($2::bigint is null or draft.project_id = $2)
      for update of draft`,
    [draftId, projectId ?? null],
  );
  return result.rows[0] ?? null;
}

async function writeAudit(
  db: Queryable,
  input: {
    projectId: number;
    actorUserId: number;
    action: string;
    entityType: string;
    entityId: number;
    beforeVersion?: number | null;
    afterVersion?: number | null;
    safeData?: Record<string, unknown>;
    idempotencyKey?: string;
  },
): Promise<void> {
  await db.query(
    `insert into audit_events (
       project_id, actor_user_id, action, entity_type, entity_id,
       before_version, after_version, safe_data, idempotency_key
     ) values ($1, $2, $3, $4, $5::text, $6, $7, $8::jsonb, $9)
     on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
    [
      input.projectId,
      input.actorUserId,
      input.action,
      input.entityType,
      input.entityId,
      input.beforeVersion ?? null,
      input.afterVersion ?? null,
      JSON.stringify(input.safeData ?? {}),
      input.idempotencyKey ?? null,
    ],
  );
}

async function notifyRoles(
  db: Queryable,
  input: {
    projectId: number;
    actorUserId: number;
    roles: readonly string[];
    eventType: string;
    entityType: string;
    entityId: number;
    safeData: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  await db.query(
    `insert into project_notifications (
       project_id, recipient_user_id, actor_user_id, event_type,
       entity_type, entity_id, safe_data, idempotency_key
     )
     select member.project_id, member.user_id, $2, $4, $5, $6::text, $7::jsonb,
            $8 || ':' || member.user_id::text
       from project_members member
      where member.project_id = $1
        and member.status = 'active'
        and member.role = any($3::text[])
        and member.user_id <> $2
     on conflict (project_id, recipient_user_id, idempotency_key)
       where idempotency_key is not null do nothing`,
    [
      input.projectId,
      input.actorUserId,
      [...input.roles],
      input.eventType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.safeData),
      input.idempotencyKey,
    ],
  );
}

async function notifyUsers(
  db: Queryable,
  input: {
    projectId: number;
    actorUserId: number;
    recipientUserIds: number[];
    eventType: string;
    entityType: string;
    entityId: number;
    safeData: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<void> {
  const recipientIds = [...new Set(input.recipientUserIds)].filter((id) => id !== input.actorUserId);
  if (recipientIds.length === 0) return;
  await db.query(
    `insert into project_notifications (
       project_id, recipient_user_id, actor_user_id, event_type,
       entity_type, entity_id, safe_data, idempotency_key
     )
     select member.project_id, member.user_id, $2, $4, $5, $6::text, $7::jsonb,
            $8 || ':' || member.user_id::text
       from project_members member
      where member.project_id = $1
        and member.status = 'active'
        and member.user_id = any($3::bigint[])
     on conflict (project_id, recipient_user_id, idempotency_key)
       where idempotency_key is not null do nothing`,
    [
      input.projectId,
      input.actorUserId,
      recipientIds,
      input.eventType,
      input.entityType,
      input.entityId,
      JSON.stringify(input.safeData),
      input.idempotencyKey,
    ],
  );
}

/**
 * Called inside the same transaction that writes the editable draft. The revision
 * therefore cannot exist without its draft version or lag behind a committed edit.
 */
export async function recordDraftRevisionInTransaction(
  db: Queryable,
  input: { draftId: number; actorUserId: number; projectId: number },
): Promise<DraftRevision> {
  await requireProjectPermission(db, input.actorUserId, input.projectId, "content.edit");
  const draft = await loadDraftSnapshot(db, input.draftId, input.projectId);
  if (!draft) throw new EditorialNotFoundError();
  const projectId = Number(draft.project_id);
  const draftVersion = Number(draft.version);
  const snapshot = snapshotFromDraft(draft);
  const hash = draftRevisionContentHash(snapshot);

  const inserted = await db.query<{
    id: number | string;
    created_at: Date | string;
  }>(
    `insert into draft_revisions (
       project_id, draft_id, draft_version, author_user_id, content_hash, snapshot
     ) values ($1, $2, $3, $4, $5, $6::jsonb)
     on conflict (draft_id, draft_version) do nothing
     returning id, created_at`,
    [projectId, input.draftId, draftVersion, input.actorUserId, hash, JSON.stringify(snapshot)],
  );
  let revisionId = inserted.rows[0] ? Number(inserted.rows[0].id) : 0;
  let createdAt: Date | string | undefined = inserted.rows[0]?.created_at;
  if (!revisionId) {
    const existing = await db.query<{
      id: number | string;
      content_hash: string;
      created_at: Date | string;
    }>(
      `select id, content_hash, created_at
         from draft_revisions
        where project_id = $1 and draft_id = $2 and draft_version = $3`,
      [projectId, input.draftId, draftVersion],
    );
    if (!existing.rows[0] || existing.rows[0].content_hash !== hash) {
      throw new EditorialConflictError("stale_revision");
    }
    revisionId = Number(existing.rows[0].id);
    createdAt = existing.rows[0].created_at;
  }

  const workflowResult = await db.query<{
    state: EditorialState;
    version: number | string;
    current_revision_id: number | string;
    current_content_hash: string;
  }>(
    `select workflow.state, workflow.version, workflow.current_revision_id,
            current_revision.content_hash as current_content_hash
       from draft_editorial_workflows workflow
       join draft_revisions current_revision
         on current_revision.id = workflow.current_revision_id
        and current_revision.project_id = workflow.project_id
        and current_revision.draft_id = workflow.draft_id
      where workflow.project_id = $1 and workflow.draft_id = $2
      for update of workflow`,
    [projectId, input.draftId],
  );
  const workflow = workflowResult.rows[0];
  if (!workflow) {
    await db.query(
      `insert into draft_editorial_workflows (
         draft_id, project_id, state, version, current_revision_id
       ) values ($1, $2, 'draft', 1, $3)`,
      [input.draftId, projectId, revisionId],
    );
  } else if (Number(workflow.current_revision_id) !== revisionId) {
    const semanticChanged = workflow.current_content_hash !== hash;
    // An open request is bound to an exact revision id as well as its hash. Even a
    // no-op save creates a new revision, so the old request must not remain actionable.
    const workflowMustReset = semanticChanged || workflow.state === "in_review";
    if (workflowMustReset) {
      await db.query(
        `update draft_editorial_requests
            set status = 'superseded', version = version + 1, resolved_at = now()
          where project_id = $1 and draft_id = $2 and status = 'open'`,
        [projectId, input.draftId],
      );
    }
    await db.query(
      `update draft_editorial_workflows
          set current_revision_id = $3,
              state = case
                when $4 and state = 'changes_requested' then 'changes_requested'
                when $4 then 'draft'
                else state
              end,
              submitted_revision_id = case when $4 then null else submitted_revision_id end,
              submitted_by_user_id = case when $4 then null else submitted_by_user_id end,
              submitted_at = case when $4 then null else submitted_at end,
              approved_revision_id = case when $4 then null else approved_revision_id end,
              approved_content_hash = case when $4 then null else approved_content_hash end,
              version = version + 1,
              updated_at = now()
        where project_id = $1 and draft_id = $2`,
      [projectId, input.draftId, revisionId, workflowMustReset],
    );
    if (workflowMustReset && workflow.state !== "draft") {
      const invalidationKind = workflow.state === "approved" ? "approval" : "review";
      await writeAudit(db, {
        projectId,
        actorUserId: input.actorUserId,
        action: `draft.${invalidationKind}_invalidated`,
        entityType: "draft",
        entityId: input.draftId,
        beforeVersion: Number(workflow.version),
        afterVersion: Number(workflow.version) + 1,
        safeData: { previousState: workflow.state, revisionId, contentHash: hash },
        idempotencyKey: `draft:${input.draftId}:revision:${revisionId}:${invalidationKind}-invalidated`,
      });
    }
  }

  await writeAudit(db, {
    projectId,
    actorUserId: input.actorUserId,
    action: "draft.revision_created",
    entityType: "draft_revision",
    entityId: revisionId,
    afterVersion: draftVersion,
    safeData: { draftId: input.draftId, draftVersion, contentHash: hash },
    idempotencyKey: `draft:${input.draftId}:revision:${revisionId}:created`,
  });

  return {
    id: revisionId,
    projectId,
    draftId: input.draftId,
    draftVersion,
    authorUserId: input.actorUserId,
    contentHash: hash,
    snapshot,
    createdAt: iso(createdAt ?? new Date()),
  };
}

/**
 * Immutable server-side history for the selected project. The project filter is
 * deliberately repeated on the draft and revision joins so a guessed draft id
 * can never cross workspace boundaries.
 */
export async function listDraftRevisionHistoryForUser(
  userId: number,
  draftId: number,
  db: Queryable = getPool(),
): Promise<DraftRevisionHistoryItem[]> {
  if (!Number.isSafeInteger(draftId) || draftId <= 0) throw new EditorialNotFoundError();
  const membership = await requireSelectedProjectPermission(db, userId, "project.read");
  const result = await db.query<{
    id: number | string;
    draft_id: number | string;
    draft_version: number | string;
    author_user_id: number | string;
    author_name: string | null;
    snapshot: Record<string, unknown>;
    created_at: Date | string;
  }>(
    `select revision.id, revision.draft_id, revision.draft_version,
            revision.author_user_id, nullif(trim(author.name), '') as author_name,
            revision.snapshot, revision.created_at
       from draft_revisions revision
       join drafts draft
         on draft.id = revision.draft_id
        and draft.project_id = revision.project_id
       join users author on author.id = revision.author_user_id
      where revision.project_id = $1
        and revision.draft_id = $2
        and draft.project_id = $1
      order by revision.draft_version desc, revision.id desc
      limit 50`,
    [membership.projectId, draftId],
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    draftId: Number(row.draft_id),
    draftVersion: Number(row.draft_version),
    authorUserId: Number(row.author_user_id),
    ...(row.author_name ? { authorName: row.author_name } : {}),
    snapshot: row.snapshot,
    createdAt: iso(row.created_at),
  }));
}

type WorkflowRow = {
  draft_id: number | string;
  project_id: number | string;
  state: EditorialState;
  workflow_version: number | string;
  current_revision_id: number | string;
  submitted_revision_id: number | string | null;
  approved_revision_id: number | string | null;
  approved_content_hash: string | null;
  workflow_updated_at: Date | string;
  revision_project_id: number | string;
  draft_version: number | string;
  revision_author_user_id: number | string;
  revision_author_name?: string | null;
  revision_content_hash: string;
  revision_snapshot: Record<string, unknown>;
  revision_created_at: Date | string;
};

function mapWorkflow(row: WorkflowRow): EditorialWorkflow {
  return {
    draftId: Number(row.draft_id),
    projectId: Number(row.project_id),
    state: row.state,
    version: Number(row.workflow_version),
    currentRevisionId: Number(row.current_revision_id),
    submittedRevisionId: row.submitted_revision_id == null ? null : Number(row.submitted_revision_id),
    approvedRevisionId: row.approved_revision_id == null ? null : Number(row.approved_revision_id),
    approvedContentHash: row.approved_content_hash,
    updatedAt: iso(row.workflow_updated_at),
  };
}

function mapRevision(row: WorkflowRow): DraftRevision {
  const authorUserId = Number(row.revision_author_user_id);
  return {
    id: Number(row.current_revision_id),
    projectId: Number(row.revision_project_id),
    draftId: Number(row.draft_id),
    draftVersion: Number(row.draft_version),
    authorUserId,
    authorName: row.revision_author_name?.trim() || `Участник ${authorUserId}`,
    contentHash: row.revision_content_hash,
    snapshot: row.revision_snapshot,
    createdAt: iso(row.revision_created_at),
  };
}

async function loadWorkflow(db: Queryable, projectId: number, draftId: number, lock = false): Promise<WorkflowRow | null> {
  const result = await db.query<WorkflowRow>(
    `select workflow.draft_id, workflow.project_id, workflow.state,
            workflow.version as workflow_version, workflow.current_revision_id,
            workflow.submitted_revision_id, workflow.approved_revision_id,
            workflow.approved_content_hash, workflow.updated_at as workflow_updated_at,
            revision.project_id as revision_project_id, revision.draft_version,
            revision.author_user_id as revision_author_user_id,
            coalesce(nullif(btrim(revision_author.name), ''), 'Участник ' || revision.author_user_id::text)
              as revision_author_name,
            revision.content_hash as revision_content_hash,
            revision.snapshot as revision_snapshot, revision.created_at as revision_created_at
       from draft_editorial_workflows workflow
       join draft_revisions revision
         on revision.id = workflow.current_revision_id
        and revision.project_id = workflow.project_id
        and revision.draft_id = workflow.draft_id
       join drafts draft on draft.id = workflow.draft_id and draft.project_id = workflow.project_id
       left join users revision_author on revision_author.id = revision.author_user_id
      where workflow.project_id = $1 and workflow.draft_id = $2
      ${lock ? "for update of workflow" : ""}`,
    [projectId, draftId],
  );
  return result.rows[0] ?? null;
}

function assertExactRevision(row: WorkflowRow, input: RevisionRef): void {
  if (
    Number(row.current_revision_id) !== input.revisionId
    || row.revision_content_hash !== input.contentHash
  ) {
    throw new EditorialConflictError("stale_revision");
  }
}

async function transaction<T>(pool: TransactionPool, task: (client: PoolClient) => Promise<T>): Promise<T> {
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

async function requireEditorialProject(
  db: Queryable,
  userId: number,
  permission: ProjectPermission,
): Promise<number> {
  return (await requireSelectedProjectPermission(db, userId, permission)).projectId;
}

export async function getEditorialSnapshotForUser(
  userId: number,
  draftId: number,
  db: Queryable = getPool(),
): Promise<EditorialSnapshot | null> {
  const projectId = await requireEditorialProject(db, userId, "project.read");
  const workflowRow = await loadWorkflow(db, projectId, draftId);
  if (!workflowRow) return null;
  const requestResult = await db.query<{
    id: number | string;
    revision_id: number | string;
    content_hash: string;
    requested_by_user_id: number | string;
    requested_by_name: string;
    status: EditorialRequest["status"];
    version: number | string;
    requested_at: Date | string;
    resolved_at: Date | string | null;
  }>(
    `select request.id, request.revision_id, request.content_hash,
            request.requested_by_user_id,
            coalesce(nullif(btrim(requester.name), ''), 'Участник ' || request.requested_by_user_id::text)
              as requested_by_name,
            request.status, request.version, request.requested_at, request.resolved_at
       from draft_editorial_requests request
       left join users requester on requester.id = request.requested_by_user_id
      where request.project_id = $1 and request.draft_id = $2
      order by request.requested_at desc, request.id desc
      limit 1`,
    [projectId, draftId],
  );
  const commentsResult = await db.query<{
    id: number | string;
    revision_id: number | string;
    content_hash: string;
    author_user_id: number | string;
    author_name: string;
    body: string;
    created_at: Date | string;
  }>(
    `select comment.id, comment.revision_id, comment.content_hash,
            comment.author_user_id,
            coalesce(nullif(btrim(author.name), ''), 'Участник ' || comment.author_user_id::text)
              as author_name,
            comment.body, comment.created_at
       from draft_editorial_comments comment
       left join users author on author.id = comment.author_user_id
      where comment.project_id = $1 and comment.draft_id = $2
      order by comment.created_at, comment.id`,
    [projectId, draftId],
  );
  const decisionsResult = await db.query<{
    id: number | string;
    request_id: number | string;
    revision_id: number | string;
    content_hash: string;
    actor_user_id: number | string;
    actor_name: string;
    decision: EditorialDecision;
    note: string | null;
    created_at: Date | string;
  }>(
    `select decision.id, decision.request_id, decision.revision_id,
            decision.content_hash, decision.actor_user_id,
            coalesce(nullif(btrim(actor.name), ''), 'Участник ' || decision.actor_user_id::text)
              as actor_name,
            decision.decision, decision.note, decision.created_at
       from draft_editorial_decisions decision
       left join users actor on actor.id = decision.actor_user_id
      where decision.project_id = $1 and decision.draft_id = $2
      order by decision.created_at desc, decision.id desc`,
    [projectId, draftId],
  );
  const requestRow = requestResult.rows[0];
  return {
    workflow: mapWorkflow(workflowRow),
    currentRevision: mapRevision(workflowRow),
    request: requestRow ? {
      id: Number(requestRow.id),
      revisionId: Number(requestRow.revision_id),
      contentHash: requestRow.content_hash,
      requestedByUserId: Number(requestRow.requested_by_user_id),
      requestedByName: requestRow.requested_by_name,
      status: requestRow.status,
      version: Number(requestRow.version),
      requestedAt: iso(requestRow.requested_at),
      resolvedAt: requestRow.resolved_at == null ? null : iso(requestRow.resolved_at),
    } : null,
    comments: commentsResult.rows.map((comment) => ({
      id: Number(comment.id),
      revisionId: Number(comment.revision_id),
      contentHash: comment.content_hash,
      authorUserId: Number(comment.author_user_id),
      authorName: comment.author_name,
      body: comment.body,
      createdAt: iso(comment.created_at),
    })),
    decisions: decisionsResult.rows.map((decision) => ({
      id: Number(decision.id),
      requestId: Number(decision.request_id),
      revisionId: Number(decision.revision_id),
      contentHash: decision.content_hash,
      actorUserId: Number(decision.actor_user_id),
      actorName: decision.actor_name,
      decision: decision.decision,
      note: decision.note,
      createdAt: iso(decision.created_at),
    })),
  };
}

export async function submitDraftForEditorialReview(
  userId: number,
  draftId: number,
  input: SubmitInput,
  pool: TransactionPool = getPool(),
): Promise<{ workflow: EditorialWorkflow; request: EditorialRequest }> {
  return transaction(pool, async (db) => {
    const projectId = await requireEditorialProject(db, userId, "content.submit");
    const workflowRow = await loadWorkflow(db, projectId, draftId, true);
    if (!workflowRow) throw new EditorialNotFoundError();
    assertExactRevision(workflowRow, input);
    if (Number(workflowRow.workflow_version) !== input.workflowVersion) {
      throw new EditorialConflictError("stale_workflow");
    }
    if (workflowRow.state === "in_review") throw new EditorialConflictError("review_open");
    if (workflowRow.state === "approved") throw new EditorialConflictError("stale_workflow");

    const requestResult = await db.query<{
      id: number | string;
      version: number | string;
      requested_at: Date | string;
    }>(
      `insert into draft_editorial_requests (
         project_id, draft_id, revision_id, content_hash, requested_by_user_id
       ) values ($1, $2, $3, $4, $5)
       returning id, version, requested_at`,
      [projectId, draftId, input.revisionId, input.contentHash, userId],
    );
    const request = requestResult.rows[0];
    if (!request) throw new Error("editorial_request_insert_failed");
    const nextWorkflowVersion = input.workflowVersion + 1;
    await db.query(
      `update draft_editorial_workflows
          set state = 'in_review', version = $4,
              submitted_revision_id = $3, submitted_by_user_id = $5,
              submitted_at = now(), approved_revision_id = null,
              approved_content_hash = null, updated_at = now()
        where project_id = $1 and draft_id = $2 and version = $6`,
      [projectId, draftId, input.revisionId, nextWorkflowVersion, userId, input.workflowVersion],
    );
    await writeAudit(db, {
      projectId,
      actorUserId: userId,
      action: "draft.review_submitted",
      entityType: "editorial_request",
      entityId: Number(request.id),
      beforeVersion: input.workflowVersion,
      afterVersion: nextWorkflowVersion,
      safeData: { draftId, revisionId: input.revisionId, contentHash: input.contentHash },
      idempotencyKey: `editorial-request:${request.id}:submitted`,
    });
    await notifyRoles(db, {
      projectId,
      actorUserId: userId,
      roles: ["owner", "approver"],
      eventType: "draft_review_requested",
      entityType: "draft",
      entityId: draftId,
      safeData: { requestId: Number(request.id), revisionId: input.revisionId },
      idempotencyKey: `editorial-request:${request.id}:reviewers`,
    });
    const nextWorkflow: EditorialWorkflow = {
      ...mapWorkflow(workflowRow),
      state: "in_review",
      version: nextWorkflowVersion,
      submittedRevisionId: input.revisionId,
      approvedRevisionId: null,
      approvedContentHash: null,
      updatedAt: new Date().toISOString(),
    };
    return {
      workflow: nextWorkflow,
      request: {
        id: Number(request.id),
        revisionId: input.revisionId,
        contentHash: input.contentHash,
        requestedByUserId: userId,
        status: "open",
        version: Number(request.version),
        requestedAt: iso(request.requested_at),
        resolvedAt: null,
      },
    };
  });
}

export async function addDraftEditorialComment(
  userId: number,
  draftId: number,
  input: CommentInput,
  pool: TransactionPool = getPool(),
): Promise<EditorialComment> {
  return transaction(pool, async (db) => {
    const projectId = await requireEditorialProject(db, userId, "content.review");
    const workflowRow = await loadWorkflow(db, projectId, draftId, true);
    if (!workflowRow) throw new EditorialNotFoundError();
    const revision = await db.query<{
      content_hash: string;
      author_user_id: number | string;
    }>(
      `select content_hash, author_user_id
         from draft_revisions
        where project_id = $1 and draft_id = $2 and id = $3`,
      [projectId, draftId, input.revisionId],
    );
    if (!revision.rows[0] || revision.rows[0].content_hash !== input.contentHash) {
      throw new EditorialConflictError("stale_revision");
    }
    const inserted = await db.query<{
      id: number | string;
      created_at: Date | string;
    }>(
      `insert into draft_editorial_comments (
         project_id, draft_id, revision_id, content_hash, author_user_id, body
       ) values ($1, $2, $3, $4, $5, $6)
       returning id, created_at`,
      [projectId, draftId, input.revisionId, input.contentHash, userId, input.body],
    );
    const comment = inserted.rows[0];
    if (!comment) throw new Error("editorial_comment_insert_failed");
    await writeAudit(db, {
      projectId,
      actorUserId: userId,
      action: "draft.comment_added",
      entityType: "editorial_comment",
      entityId: Number(comment.id),
      safeData: { draftId, revisionId: input.revisionId, contentHash: input.contentHash },
      idempotencyKey: `editorial-comment:${comment.id}:created`,
    });
    await notifyUsers(db, {
      projectId,
      actorUserId: userId,
      recipientUserIds: [Number(revision.rows[0].author_user_id)],
      eventType: "draft_comment_added",
      entityType: "draft",
      entityId: draftId,
      safeData: { commentId: Number(comment.id), revisionId: input.revisionId },
      idempotencyKey: `editorial-comment:${comment.id}:author`,
    });
    return {
      id: Number(comment.id),
      revisionId: input.revisionId,
      contentHash: input.contentHash,
      authorUserId: userId,
      body: input.body,
      createdAt: iso(comment.created_at),
    };
  });
}

export async function decideDraftEditorialRequest(
  userId: number,
  draftId: number,
  input: DecisionInput,
  pool: TransactionPool = getPool(),
): Promise<{ workflow: EditorialWorkflow; decisionId: number }> {
  return transaction(pool, async (db) => {
    const projectId = await requireEditorialProject(db, userId, "content.approve");
    // All editorial writers take locks in workflow -> request order. Keeping one
    // order prevents an edit that invalidates an approval from deadlocking a reviewer.
    const workflowRow = await loadWorkflow(db, projectId, draftId, true);
    if (!workflowRow) throw new EditorialNotFoundError();
    const requestResult = await db.query<{
      id: number | string;
      revision_id: number | string;
      content_hash: string;
      requested_by_user_id: number | string;
      status: EditorialRequest["status"];
      version: number | string;
    }>(
      `select id, revision_id, content_hash, requested_by_user_id, status, version
         from draft_editorial_requests
        where project_id = $1 and draft_id = $2 and id = $3
        for update`,
      [projectId, draftId, input.requestId],
    );
    const request = requestResult.rows[0];
    if (!request) throw new EditorialNotFoundError();
    if (request.status !== "open" || Number(request.version) !== input.requestVersion) {
      throw new EditorialConflictError("stale_request");
    }
    if (
      Number(request.revision_id) !== input.revisionId
      || request.content_hash !== input.contentHash
    ) throw new EditorialConflictError("stale_revision");

    assertExactRevision(workflowRow, input);
    if (
      workflowRow.state !== "in_review"
      || Number(workflowRow.workflow_version) !== input.workflowVersion
      || Number(workflowRow.submitted_revision_id) !== input.revisionId
    ) throw new EditorialConflictError("stale_workflow");

    const inserted = await db.query<{ id: number | string }>(
      `insert into draft_editorial_decisions (
         project_id, request_id, draft_id, revision_id, content_hash,
         actor_user_id, decision, note
       ) values ($1, $2, $3, $4, $5, $6, $7, $8)
       returning id`,
      [
        projectId,
        input.requestId,
        draftId,
        input.revisionId,
        input.contentHash,
        userId,
        input.decision,
        input.note,
      ],
    );
    const decisionId = Number(inserted.rows[0]?.id ?? 0);
    if (!decisionId) throw new EditorialConflictError("stale_request");
    const requestStatus = input.decision === "approve" ? "approved" : "changes_requested";
    const nextState: EditorialState = requestStatus;
    const nextWorkflowVersion = input.workflowVersion + 1;
    await db.query(
      `update draft_editorial_requests
          set status = $4, version = version + 1,
              resolved_by_user_id = $5, resolved_at = now()
        where project_id = $1 and draft_id = $2 and id = $3
          and status = 'open' and version = $6`,
      [projectId, draftId, input.requestId, requestStatus, userId, input.requestVersion],
    );
    await db.query(
      `update draft_editorial_workflows
          set state = $4::text, version = $5::bigint,
              approved_revision_id = case when $4::text = 'approved' then $3::bigint else null end,
              approved_content_hash = case when $4::text = 'approved' then $6::char(64) else null end,
              updated_at = now()
        where project_id = $1::bigint and draft_id = $2::bigint and version = $7::bigint`,
      [projectId, draftId, input.revisionId, nextState, nextWorkflowVersion, input.contentHash, input.workflowVersion],
    );
    await writeAudit(db, {
      projectId,
      actorUserId: userId,
      action: input.decision === "approve" ? "draft.approved" : "draft.changes_requested",
      entityType: "editorial_decision",
      entityId: decisionId,
      beforeVersion: input.workflowVersion,
      afterVersion: nextWorkflowVersion,
      safeData: {
        draftId,
        requestId: input.requestId,
        revisionId: input.revisionId,
        contentHash: input.contentHash,
      },
      idempotencyKey: `editorial-decision:${decisionId}:recorded`,
    });
    await notifyUsers(db, {
      projectId,
      actorUserId: userId,
      recipientUserIds: [Number(request.requested_by_user_id), Number(workflowRow.revision_author_user_id)],
      eventType: input.decision === "approve" ? "draft_approved" : "draft_changes_requested",
      entityType: "draft",
      entityId: draftId,
      safeData: { requestId: input.requestId, revisionId: input.revisionId },
      idempotencyKey: `editorial-decision:${decisionId}:participants`,
    });
    if (input.decision === "approve") {
      await notifyRoles(db, {
        projectId,
        actorUserId: userId,
        roles: ["owner", "publisher"],
        eventType: "draft_ready_to_publish",
        entityType: "draft",
        entityId: draftId,
        safeData: { requestId: input.requestId, revisionId: input.revisionId },
        idempotencyKey: `editorial-decision:${decisionId}:publishers`,
      });
    }
    return {
      workflow: {
        ...mapWorkflow(workflowRow),
        state: nextState,
        version: nextWorkflowVersion,
        approvedRevisionId: input.decision === "approve" ? input.revisionId : null,
        approvedContentHash: input.decision === "approve" ? input.contentHash : null,
        updatedAt: new Date().toISOString(),
      },
      decisionId,
    };
  });
}

/** Used by publication code to fail closed on a stale or missing approval. */
export async function requireCurrentDraftApproval(
  db: Queryable,
  userId: number,
  projectId: number,
  draftId: number,
): Promise<{ revisionId: number; contentHash: string }> {
  return requireExactDraftApproval(db, userId, projectId, draftId, "content.publish");
}

/**
 * Fails closed unless the current draft is the exact revision/hash approved by an
 * editor. Consumers such as the legal visual studio use their own least-privilege
 * permission while publication keeps requiring `content.publish` above.
 */
export async function requireExactDraftApproval(
  db: Queryable,
  userId: number,
  projectId: number,
  draftId: number,
  permission: ProjectPermission = "content.create",
): Promise<{ revisionId: number; contentHash: string }> {
  await requireProjectPermission(db, userId, projectId, permission);
  const workflow = await loadWorkflow(db, projectId, draftId, true);
  if (
    !workflow
    || workflow.state !== "approved"
    || workflow.approved_revision_id == null
    || workflow.approved_content_hash == null
    || workflow.revision_content_hash !== workflow.approved_content_hash
  ) throw new EditorialValidationError("approval_required");
  return {
    revisionId: Number(workflow.approved_revision_id),
    contentHash: workflow.approved_content_hash,
  };
}
