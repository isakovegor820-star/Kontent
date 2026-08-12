import type { Pool, PoolClient } from "pg";

import { recordDraftRevisionInTransaction } from "./editorial-approval";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "./project-permissions";
import {
  REUSABLE_BLOCK_KINDS,
  type FirstCommentFallback,
  type ReusableBlockKind,
} from "./publication-blocks";

type Queryable = Pick<PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

const COMMENTS_MODES = ["provider_default", "enabled", "disabled"] as const;
export type PublicationCommentsMode = (typeof COMMENTS_MODES)[number];

export class PublicationSettingsError extends Error {
  readonly code:
    | "invalid_block_kind"
    | "invalid_name"
    | "invalid_body"
    | "invalid_block_id"
    | "invalid_block_selection"
    | "multiple_first_comments"
    | "invalid_fallback"
    | "invalid_comments_mode"
    | "invalid_review"
    | "responsible_member_required"
    | "draft_not_found"
    | "block_not_found"
    | "version_conflict";

  constructor(code: PublicationSettingsError["code"]) {
    super(code);
    this.name = "PublicationSettingsError";
    this.code = code;
  }
}

function positiveId(value: unknown, error: PublicationSettingsError["code"] = "invalid_block_id") {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new PublicationSettingsError(error);
  return parsed;
}

function normalizeKind(value: unknown): ReusableBlockKind {
  const kind = String(value ?? "").trim() as ReusableBlockKind;
  if (!REUSABLE_BLOCK_KINDS.includes(kind)) {
    throw new PublicationSettingsError("invalid_block_kind");
  }
  return kind;
}

function normalizeName(value: unknown) {
  const name = String(value ?? "").normalize("NFC").trim().replace(/\s+/gu, " ");
  if (name.length < 1 || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name)) {
    throw new PublicationSettingsError("invalid_name");
  }
  return name;
}

function normalizeBody(value: unknown) {
  const body = String(value ?? "").normalize("NFC").trim().replace(/\r\n?/gu, "\n");
  if (body.length < 1 || body.length > 2_000 || /\u0000/u.test(body)) {
    throw new PublicationSettingsError("invalid_body");
  }
  return body;
}

function normalizeExpectedVersion(value: unknown) {
  const version = Number(value);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new PublicationSettingsError("version_conflict");
  }
  return version;
}

function normalizeSelectedBlockIds(value: unknown) {
  if (!Array.isArray(value) || value.length > 12) {
    throw new PublicationSettingsError("invalid_block_selection");
  }
  const ids = value.map((entry) => positiveId(entry, "invalid_block_selection"));
  if (new Set(ids).size !== ids.length) {
    throw new PublicationSettingsError("invalid_block_selection");
  }
  return ids;
}

function normalizeFallback(value: unknown): FirstCommentFallback {
  const fallback = String(value ?? "skip") as FirstCommentFallback;
  if (!(fallback === "append_to_post" || fallback === "skip")) {
    throw new PublicationSettingsError("invalid_fallback");
  }
  return fallback;
}

function normalizeCommentsMode(value: unknown): PublicationCommentsMode {
  const mode = String(value ?? "provider_default") as PublicationCommentsMode;
  if (!COMMENTS_MODES.includes(mode)) {
    throw new PublicationSettingsError("invalid_comments_mode");
  }
  return mode;
}

function normalizeReview(input: { reviewAt: unknown; responsibleUserId: unknown }, now: Date) {
  const emptyDate = input.reviewAt == null || input.reviewAt === "";
  const emptyResponsible = input.responsibleUserId == null || input.responsibleUserId === "";
  if (emptyDate && emptyResponsible) return { reviewAt: null, responsibleUserId: null };
  if (emptyDate || emptyResponsible) throw new PublicationSettingsError("invalid_review");
  const reviewAt = new Date(String(input.reviewAt));
  const responsibleUserId = positiveId(input.responsibleUserId, "invalid_review");
  if (
    Number.isNaN(reviewAt.getTime())
    || reviewAt.getTime() <= now.getTime() + 60_000
    || reviewAt.getTime() > now.getTime() + 5 * 366 * 24 * 60 * 60 * 1_000
  ) throw new PublicationSettingsError("invalid_review");
  return { reviewAt, responsibleUserId };
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

function blockView(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    kind: String(row.kind) as ReusableBlockKind,
    name: String(row.name),
    text: String(row.body),
    version: Number(row.version),
    enabled: row.is_enabled === true,
    updatedAt: new Date(String(row.updated_at)).toISOString(),
  };
}

function preferenceView(row: Record<string, unknown> | undefined, draftId: number) {
  if (!row) {
    return {
      draftId,
      selectedBlockIds: [] as number[],
      firstCommentFallback: "skip" as FirstCommentFallback,
      commentsMode: "provider_default" as PublicationCommentsMode,
      pinAfterPublish: false,
      reviewAt: null as string | null,
      reviewResponsibleUserId: null as number | null,
      version: 0,
    };
  }
  return {
    draftId: Number(row.draft_id),
    selectedBlockIds: Array.isArray(row.selected_block_ids)
      ? row.selected_block_ids.map(Number)
      : [],
    firstCommentFallback: String(row.first_comment_fallback) as FirstCommentFallback,
    commentsMode: String(row.comments_mode) as PublicationCommentsMode,
    pinAfterPublish: row.pin_after_publish === true,
    reviewAt: row.review_at == null ? null : new Date(String(row.review_at)).toISOString(),
    reviewResponsibleUserId: row.review_responsible_user_id == null
      ? null
      : Number(row.review_responsible_user_id),
    version: Number(row.version),
  };
}

export async function listProjectPublicationBlocks(db: Queryable, actorUserId: number) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const result = await db.query(
    `select id, kind, name, body, version, is_enabled, updated_at
       from project_publication_blocks
      where project_id = $1
      order by kind, is_enabled desc, lower(name), id`,
    [membership.projectId],
  );
  return result.rows.map((row) => blockView(row as Record<string, unknown>));
}

export async function createProjectPublicationBlock(input: {
  pool: TransactionPool;
  actorUserId: number;
  kind: unknown;
  name: unknown;
  body: unknown;
  requestId?: string | null;
}) {
  const kind = normalizeKind(input.kind);
  const name = normalizeName(input.name);
  const body = normalizeBody(input.body);
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const inserted = await client.query(
      `insert into project_publication_blocks
         (project_id, kind, name, body, created_by_user_id, updated_by_user_id)
       values ($1, $2, $3, $4, $5, $5)
       returning id, kind, name, body, version, is_enabled, updated_at`,
      [membership.projectId, kind, name, body, input.actorUserId],
    );
    const row = inserted.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          after_version, safe_data, request_id)
       values ($1, $2, 'publication.block.created', 'publication_block', $3,
               1, jsonb_build_object('kind', $4::text), $5)`,
      [membership.projectId, input.actorUserId, String(row.id), kind, input.requestId?.slice(0, 128) ?? null],
    );
    return blockView(row);
  });
}

export async function updateProjectPublicationBlock(input: {
  pool: TransactionPool;
  actorUserId: number;
  blockId: number;
  expectedVersion: unknown;
  kind: unknown;
  name: unknown;
  body: unknown;
  enabled: unknown;
  requestId?: string | null;
}) {
  const blockId = positiveId(input.blockId);
  const expectedVersion = normalizeExpectedVersion(input.expectedVersion);
  const kind = normalizeKind(input.kind);
  const name = normalizeName(input.name);
  const body = normalizeBody(input.body);
  if (typeof input.enabled !== "boolean") throw new PublicationSettingsError("invalid_body");
  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "project.manage");
    const locked = await client.query<{ version: number | string; kind: string }>(
      `select version, kind
         from project_publication_blocks
        where id = $1 and project_id = $2
        for update`,
      [blockId, membership.projectId],
    );
    if (!locked.rows[0]) throw new PublicationSettingsError("block_not_found");
    if (Number(locked.rows[0].version) !== expectedVersion) {
      throw new PublicationSettingsError("version_conflict");
    }
    const updated = await client.query(
      `update project_publication_blocks
          set kind = $3, name = $4, body = $5, is_enabled = $6,
              version = version + 1, updated_by_user_id = $7, updated_at = now()
        where id = $1 and project_id = $2
        returning id, kind, name, body, version, is_enabled, updated_at`,
      [blockId, membership.projectId, kind, name, body, input.enabled, input.actorUserId],
    );
    const row = updated.rows[0] as Record<string, unknown>;
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          before_version, after_version, safe_data, request_id)
       values ($1, $2, 'publication.block.updated', 'publication_block', $3,
               $4, $5, jsonb_build_object('from_kind', $6::text, 'to_kind', $7::text,
                                           'enabled', $8::boolean), $9)`,
      [
        membership.projectId,
        input.actorUserId,
        String(blockId),
        expectedVersion,
        Number(row.version),
        locked.rows[0].kind,
        kind,
        input.enabled,
        input.requestId?.slice(0, 128) ?? null,
      ],
    );
    return blockView(row);
  });
}

async function requireDraftInProject(db: Queryable, draftId: number, projectId: number) {
  const result = await db.query<{ id: number | string }>(
    `select id from drafts where id = $1 and project_id = $2 limit 1`,
    [draftId, projectId],
  );
  if (!result.rows[0]) throw new PublicationSettingsError("draft_not_found");
}

export async function getDraftPublicationPreferences(
  db: Queryable,
  actorUserId: number,
  draftIdValue: number,
) {
  const draftId = positiveId(draftIdValue, "draft_not_found");
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  await requireDraftInProject(db, draftId, membership.projectId);
  const result = await db.query(
    `select draft_id, selected_block_ids, first_comment_fallback, comments_mode,
            pin_after_publish, review_at, review_responsible_user_id, version
       from draft_publication_preferences
      where draft_id = $1 and project_id = $2`,
    [draftId, membership.projectId],
  );
  return preferenceView(result.rows[0] as Record<string, unknown> | undefined, draftId);
}

export async function saveDraftPublicationPreferences(input: {
  pool: TransactionPool;
  actorUserId: number;
  draftId: number;
  expectedVersion: unknown;
  selectedBlockIds: unknown;
  firstCommentFallback: unknown;
  commentsMode: unknown;
  pinAfterPublish: unknown;
  reviewAt: unknown;
  reviewResponsibleUserId: unknown;
  now?: Date;
  requestId?: string | null;
}) {
  const draftId = positiveId(input.draftId, "draft_not_found");
  const expectedVersion = Number(input.expectedVersion);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    throw new PublicationSettingsError("version_conflict");
  }
  const selectedBlockIds = normalizeSelectedBlockIds(input.selectedBlockIds);
  const firstCommentFallback = normalizeFallback(input.firstCommentFallback);
  const commentsMode = normalizeCommentsMode(input.commentsMode);
  if (typeof input.pinAfterPublish !== "boolean") {
    throw new PublicationSettingsError("invalid_comments_mode");
  }
  const review = normalizeReview({
    reviewAt: input.reviewAt,
    responsibleUserId: input.reviewResponsibleUserId,
  }, input.now ?? new Date());

  return withTransaction(input.pool, async (client) => {
    const membership = await requireSelectedProjectPermission(client, input.actorUserId, "content.edit");
    await requireDraftInProject(client, draftId, membership.projectId);
    if (selectedBlockIds.length > 0) {
      const selected = await client.query<{ id: number | string; kind: string }>(
        `select id, kind
           from project_publication_blocks
          where project_id = $1 and id = any($2::bigint[]) and is_enabled = true
          order by id
          for share`,
        [membership.projectId, selectedBlockIds],
      );
      if (selected.rows.length !== selectedBlockIds.length) {
        throw new PublicationSettingsError("invalid_block_selection");
      }
      if (selected.rows.filter((row) => row.kind === "first_comment").length > 1) {
        throw new PublicationSettingsError("multiple_first_comments");
      }
    }
    if (review.responsibleUserId != null) {
      const responsible = await client.query(
        `select 1 from project_members
          where project_id = $1 and user_id = $2 and status = 'active' limit 1`,
        [membership.projectId, review.responsibleUserId],
      );
      if (!responsible.rows[0]) {
        throw new PublicationSettingsError("responsible_member_required");
      }
    }
    const locked = await client.query<{ version: number | string }>(
      `select version from draft_publication_preferences
        where draft_id = $1 and project_id = $2 for update`,
      [draftId, membership.projectId],
    );
    const currentVersion = locked.rows[0] ? Number(locked.rows[0].version) : 0;
    if (currentVersion !== expectedVersion) throw new PublicationSettingsError("version_conflict");
    const nextVersion = currentVersion + 1;
    const saved = await client.query(
      `insert into draft_publication_preferences
         (draft_id, project_id, selected_block_ids, first_comment_fallback,
          comments_mode, pin_after_publish, review_at, review_responsible_user_id,
          version, updated_by_user_id)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7, $8, $9, $10)
       on conflict (draft_id) do update
         set selected_block_ids = excluded.selected_block_ids,
             first_comment_fallback = excluded.first_comment_fallback,
             comments_mode = excluded.comments_mode,
             pin_after_publish = excluded.pin_after_publish,
             review_at = excluded.review_at,
             review_responsible_user_id = excluded.review_responsible_user_id,
             version = excluded.version,
             updated_by_user_id = excluded.updated_by_user_id,
             updated_at = now()
       where draft_publication_preferences.project_id = excluded.project_id
       returning draft_id, selected_block_ids, first_comment_fallback, comments_mode,
                 pin_after_publish, review_at, review_responsible_user_id, version`,
      [
        draftId,
        membership.projectId,
        JSON.stringify(selectedBlockIds),
        firstCommentFallback,
        commentsMode,
        input.pinAfterPublish,
        review.reviewAt,
        review.responsibleUserId,
        nextVersion,
        input.actorUserId,
      ],
    );
    if (!saved.rows[0]) throw new ProjectAccessError("membership_required");
    const draftUpdate = await client.query<{ version: number | string }>(
      `update drafts
          set version = version + 1,
              human_reviewed_version = null,
              human_reviewed_at = null,
              updated_at = now()
        where id = $1 and project_id = $2
        returning version`,
      [draftId, membership.projectId],
    );
    const draftVersion = Number(draftUpdate.rows[0]?.version);
    if (!Number.isSafeInteger(draftVersion) || draftVersion <= 0) {
      throw new PublicationSettingsError("draft_not_found");
    }
    const revision = await recordDraftRevisionInTransaction(client, {
      draftId,
      actorUserId: input.actorUserId,
      projectId: membership.projectId,
    });
    await client.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          before_version, after_version, safe_data, request_id)
       values ($1, $2, 'publication.preferences.updated', 'draft', $3,
               $4, $5,
               jsonb_build_object('block_count', $6::integer,
                                  'comments_mode', $7::text,
                                  'pin_after_publish', $8::boolean,
                                  'has_review', $9::boolean), $10)`,
      [
        membership.projectId,
        input.actorUserId,
        String(draftId),
        currentVersion || null,
        nextVersion,
        selectedBlockIds.length,
        commentsMode,
        input.pinAfterPublish,
        review.reviewAt != null,
        input.requestId?.slice(0, 128) ?? null,
      ],
    );
    return {
      ...preferenceView(saved.rows[0] as Record<string, unknown>, draftId),
      draftVersion,
      revisionId: revision.id,
      contentHash: revision.contentHash,
    };
  });
}
