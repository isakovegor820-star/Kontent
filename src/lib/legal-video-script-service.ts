import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import {
  EditorialValidationError,
  recordDraftRevisionInTransaction,
  requireExactDraftApproval,
} from "./editorial-approval";
import {
  createLegalVideoScript,
  exportLegalVideoProductionBrief,
  legalVideoDraftContentHash,
  reviseLegalVideoScript,
  validateLegalVideoScript,
  type LegalVideoDuration,
  type LegalVideoEvidenceInput,
  type LegalVideoSceneInput,
  type LegalVideoScript,
} from "./legal-video-script";
import { normalizeIdempotencyKey } from "./publication-idempotency";
import { requireProjectPermission, requireSelectedProjectPermission } from "./project-permissions";

type Queryable = Pick<Pool, "query">;
type TransactionPool = Pick<Pool, "connect">;

export type LegalVideoScriptRecord = {
  id: number;
  projectId: number;
  sourceDraftRevisionId: number;
  sourceDraftId: number;
  sourceDraftVersion: number;
  sourceContentHash: string;
  title: string;
  durationSeconds: LegalVideoDuration;
  revision: number;
  revisionHash: string;
  script: LegalVideoScript;
  createdAt: string;
  updatedAt: string;
};

export class LegalVideoScriptServiceError extends Error {
  readonly code:
    | "invalid_request"
    | "invalid_idempotency_key"
    | "draft_not_found"
    | "approval_required"
    | "empty_draft"
    | "not_found"
    | "version_conflict"
    | "idempotency_conflict"
    | "invalid_script";
  readonly details?: unknown;

  constructor(code: LegalVideoScriptServiceError["code"], details?: unknown) {
    super(code);
    this.name = "LegalVideoScriptServiceError";
    this.code = code;
    this.details = details;
  }
}

function iso(value: unknown): string {
  return new Date(value as string | number | Date).toISOString();
}

function positiveId(value: unknown, code: LegalVideoScriptServiceError["code"] = "not_found") {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new LegalVideoScriptServiceError(code);
  return id;
}

function duration(value: unknown): LegalVideoDuration {
  return value === 45 || value === 60 ? value : 30;
}

function text(value: unknown, max: number, fallback = "") {
  if (typeof value !== "string") return fallback;
  return value.normalize("NFC").trim().replace(/\s+/gu, " ").slice(0, max) || fallback;
}

function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function createRequestHash(intent: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson(intent), "utf8")
    .digest("hex");
}

function titleFromBody(body: string) {
  const first = body.replace(/\r\n?/gu, "\n").split(/(?<=[.!?])\s+|\n+/gu)[0] ?? "";
  return text(first, 180, "Коротко о главном");
}

function excerptFromBody(body: string) {
  const compact = body.normalize("NFC").trim();
  if (!compact) throw new LegalVideoScriptServiceError("empty_draft");
  return compact.slice(0, 4_000);
}

function claimFromExcerpt(excerpt: string) {
  const first = excerpt.split(/(?<=[.!?])\s+|\n+/gu)[0] ?? excerpt;
  return first.trim().slice(0, 600) || excerpt.slice(0, 600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type TrustedRadarResultRow = {
  id: number | string;
  url: string;
  title: string | null;
  handle: string | null;
  description: string | null;
  text: string | null;
  verified_at: string | Date;
};

/**
 * A sourceRef records lineage, but it does not by itself prove that a URL was
 * checked. Promote only an exact radar_result binding whose public URL, title,
 * project channel and verification timestamp can all be recovered from the
 * server-owned result row. AI validation receipts intentionally are not used as
 * source metadata: they bind generated text and ledger IDs, not a canonical URL.
 */
async function inheritedVerifiedEvidence(input: {
  db: Queryable;
  projectId: number;
  snapshot: Record<string, unknown>;
}): Promise<LegalVideoEvidenceInput | null> {
  const sourceRef = isRecord(input.snapshot.sourceRef) ? input.snapshot.sourceRef : null;
  const provenance = sourceRef && isRecord(sourceRef.provenance) ? sourceRef.provenance : null;
  if (!sourceRef || !provenance || provenance.kind !== "radar_result") return null;

  const sourceId = typeof provenance.id === "string" ? provenance.id.trim() : "";
  const trustedUrl = typeof provenance.url === "string" ? provenance.url.trim() : "";
  const trustedTitle = text(provenance.label, 240, text(sourceRef.label, 240, ""));
  const channelIds = Array.isArray(input.snapshot.channelIds)
    ? [...new Set(input.snapshot.channelIds.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))]
    : [];
  const validSourceId = /^[1-9][0-9]{0,18}$/u.test(sourceId)
    && (sourceId.length < 19 || sourceId <= "9223372036854775807");
  if (
    !validSourceId
    || trustedUrl.length > 2_048
    || !/^https:\/\/t\.me\//u.test(trustedUrl)
    || !trustedTitle
    || channelIds.length === 0
  ) {
    return null;
  }

  const row = (await input.db.query<TrustedRadarResultRow>(
    `select result.id, result.url, result.title, result.handle, result.description,
            result.text, result.verified_at
       from radar_search_results result
       join radar_search_runs run on run.id = result.run_id
       join channels channel on channel.id = run.channel_id
      where result.id = $1
        and result.url = $2
        and result.verification_status = 'verified'
        and channel.project_id = $3
        and channel.id = any($4::bigint[])`,
    [sourceId, trustedUrl, input.projectId, channelIds],
  )).rows[0];
  if (!row) return null;

  const canonicalTitle = text(row.title, 240, row.handle ? `@${row.handle.replace(/^@/u, "")}` : "");
  if (!canonicalTitle || canonicalTitle !== trustedTitle || row.url !== trustedUrl) return null;
  const sourceMaterial = [row.text, row.description, row.title]
    .find((value) => typeof value === "string" && value.trim().length > 0)
    ?.trim() ?? "";
  if (!sourceMaterial) return null;

  const excerpt = excerptFromBody(sourceMaterial);
  return {
    id: `verified-source-radar-${sourceId}`,
    label: text(trustedTitle, 160),
    claim: claimFromExcerpt(excerpt),
    excerpt,
    source: {
      kind: "verified_source",
      sourceId: `radar_result:${sourceId}`,
      title: trustedTitle,
      url: trustedUrl,
      checkedAt: iso(row.verified_at),
      sourceContentHash: legalVideoDraftContentHash(sourceMaterial),
    },
  };
}

function defaultScenes(
  durationSeconds: LegalVideoDuration,
  title: string,
  claim: string,
  sourceClaimIds: readonly string[] = ["draft-claim"],
): LegalVideoSceneInput[] {
  const edge = durationSeconds === 30 ? 7 : durationSeconds === 45 ? 10 : 12;
  return [
    {
      id: "scene-hook",
      order: 1,
      role: "hook",
      durationSeconds: edge,
      voiceOver: `Коротко о главном: ${claim}`,
      onScreenText: title.slice(0, 180),
      visualDirection: "Крупный план документа, затем спокойный переход к ключевому тезису.",
      sourceClaimIds: [...sourceClaimIds],
    },
    {
      id: "scene-body",
      order: 2,
      role: "body",
      durationSeconds: durationSeconds - edge * 2,
      voiceOver: claim,
      onScreenText: claim.slice(0, 220),
      visualDirection: "Покажите тезис крупно и поддержите его нейтральным B-roll по теме материала.",
      sourceClaimIds: [...sourceClaimIds],
    },
    {
      id: "scene-cta",
      order: 3,
      role: "cta",
      durationSeconds: edge,
      voiceOver: "Сохраните разбор.",
      onScreenText: "Сохраните разбор",
      visualDirection: "Финальная карточка в фирменном стиле с аккуратным призывом к действию.",
      sourceClaimIds: [],
    },
  ];
}

function defaultScript(input: {
  id: string;
  projectId: number;
  draftId: number;
  draftVersion: number;
  body: string;
  title?: unknown;
  durationSeconds: LegalVideoDuration;
  inheritedEvidence?: LegalVideoEvidenceInput | null;
}) {
  const excerpt = excerptFromBody(input.body);
  const claim = claimFromExcerpt(excerpt);
  const title = text(input.title, 180, titleFromBody(input.body));
  const bodyHash = legalVideoDraftContentHash(input.body);
  return createLegalVideoScript({
    id: input.id,
    projectId: input.projectId,
    revision: 1,
    title,
    durationSeconds: input.durationSeconds,
    sourceDraft: {
      id: input.draftId,
      revision: input.draftVersion,
      contentHash: bodyHash,
      title: titleFromBody(input.body),
      body: input.body,
    },
    sourceEvidence: [
      {
        id: "draft-claim",
        label: "Исходный черновик",
        claim,
        excerpt,
        source: {
          kind: "draft",
          draftId: input.draftId,
          draftRevision: input.draftVersion,
          draftContentHash: bodyHash,
        },
      },
      ...(input.inheritedEvidence ? [input.inheritedEvidence] : []),
    ],
    scenes: defaultScenes(
      input.durationSeconds,
      title,
      claim,
      input.inheritedEvidence ? ["draft-claim", input.inheritedEvidence.id] : ["draft-claim"],
    ),
  });
}

async function withTransaction<T>(pool: TransactionPool, work: (db: PoolClient) => Promise<T>): Promise<T> {
  const db = await pool.connect();
  try {
    await db.query("begin");
    const result = await work(db);
    await db.query("commit");
    return result;
  } catch (error) {
    await db.query("rollback").catch(() => {});
    throw error;
  } finally {
    db.release();
  }
}

function fromRow(row: Record<string, unknown>): LegalVideoScriptRecord {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    sourceDraftRevisionId: Number(row.source_draft_revision_id),
    sourceDraftId: Number(row.source_draft_id),
    sourceDraftVersion: Number(row.source_draft_version),
    sourceContentHash: String(row.source_content_hash),
    title: String(row.title),
    durationSeconds: Number(row.duration_seconds) as LegalVideoDuration,
    revision: Number(row.revision),
    revisionHash: String(row.revision_hash),
    script: validateLegalVideoScript(row.snapshot),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

const SCRIPT_COLUMNS = `id, project_id, source_draft_revision_id, source_draft_id,
  source_draft_version, source_content_hash, title, duration_seconds, revision,
  revision_hash, snapshot, request_hash, created_at, updated_at`;

export async function listLegalVideoScripts(input: { pool: Queryable; actorUserId: number; limit?: number }) {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const limit = Math.max(1, Math.min(100, Number(input.limit) || 30));
  const rows = (await input.pool.query<Record<string, unknown>>(
    `select ${SCRIPT_COLUMNS} from legal_video_scripts
      where project_id = $1 order by updated_at desc, id desc limit $2`,
    [membership.projectId, limit],
  )).rows;
  return rows.map(fromRow);
}

export async function getLegalVideoScript(input: { pool: Queryable; actorUserId: number; scriptId: number }) {
  const membership = await requireSelectedProjectPermission(input.pool, input.actorUserId, "project.read");
  const row = (await input.pool.query<Record<string, unknown>>(
    `select ${SCRIPT_COLUMNS} from legal_video_scripts where id = $1 and project_id = $2`,
    [positiveId(input.scriptId), membership.projectId],
  )).rows[0];
  if (!row) throw new LegalVideoScriptServiceError("not_found");
  return fromRow(row);
}

export async function createLegalVideoScriptRecord(input: {
  pool: TransactionPool;
  actorUserId: number;
  draftId: unknown;
  requestKey: unknown;
  durationSeconds?: unknown;
  title?: unknown;
}) {
  const requestKey = normalizeIdempotencyKey(input.requestKey);
  if (!requestKey) throw new LegalVideoScriptServiceError("invalid_idempotency_key");
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.create");
    const draftId = positiveId(input.draftId, "draft_not_found");
    const requestedTitle = text(input.title, 180, "");
    const requestedDuration = duration(input.durationSeconds);
    const requestHash = createRequestHash({
      draftId,
      title: requestedTitle,
      durationSeconds: requestedDuration,
    });
    const replay = (await db.query<Record<string, unknown>>(
      `select ${SCRIPT_COLUMNS} from legal_video_scripts where project_id = $1 and request_key = $2`,
      [membership.projectId, requestKey],
    )).rows[0];
    if (replay) {
      if (typeof replay.request_hash === "string") {
        if (replay.request_hash !== requestHash) throw new LegalVideoScriptServiceError("idempotency_conflict");
      } else {
        const legacyIdentityMatches = Number(replay.source_draft_id) === draftId
          && Number(replay.duration_seconds) === requestedDuration
          && requestedTitle.length > 0
          && String(replay.title) === requestedTitle;
        if (!legacyIdentityMatches) throw new LegalVideoScriptServiceError("idempotency_conflict");
      }
      return { script: fromRow(replay), duplicate: true };
    }

    await requireProjectPermission(db, input.actorUserId, membership.projectId, "content.edit");
    let revision;
    try {
      revision = await recordDraftRevisionInTransaction(db, {
        draftId,
        actorUserId: input.actorUserId,
        projectId: membership.projectId,
      });
    } catch (error) {
      throw new LegalVideoScriptServiceError("draft_not_found", error);
    }
    try {
      const approval = await requireExactDraftApproval(
        db,
        input.actorUserId,
        membership.projectId,
        draftId,
        "content.create",
      );
      if (approval.revisionId !== revision.id || approval.contentHash !== revision.contentHash) {
        throw new LegalVideoScriptServiceError("approval_required");
      }
    } catch (error) {
      if (error instanceof LegalVideoScriptServiceError) throw error;
      if (error instanceof EditorialValidationError && error.code === "approval_required") {
        throw new LegalVideoScriptServiceError("approval_required", error);
      }
      throw error;
    }
    const body = typeof revision.snapshot.text === "string" ? revision.snapshot.text : "";
    const verifiedEvidence = await inheritedVerifiedEvidence({
      db,
      projectId: membership.projectId,
      snapshot: revision.snapshot,
    });
    let script: LegalVideoScript;
    try {
      script = defaultScript({
        id: `video-${randomUUID()}`,
        projectId: membership.projectId,
        draftId,
        draftVersion: revision.draftVersion,
        body,
        title: requestedTitle,
        durationSeconds: requestedDuration,
        inheritedEvidence: verifiedEvidence,
      });
    } catch (error) {
      if (error instanceof LegalVideoScriptServiceError) throw error;
      throw new LegalVideoScriptServiceError("invalid_script", error);
    }
    const inserted = (await db.query<Record<string, unknown>>(
      `insert into legal_video_scripts (
         project_id, source_draft_id, source_draft_revision_id, source_draft_version,
         source_content_hash, created_by_user_id, updated_by_user_id, title,
         duration_seconds, revision, revision_hash, snapshot, request_key, request_hash
       ) values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,$11::jsonb,$12,$13)
       returning ${SCRIPT_COLUMNS}`,
      [membership.projectId, draftId, revision.id, revision.draftVersion,
        revision.contentHash, input.actorUserId, script.title, script.durationSeconds,
        script.revision, script.revisionHash, JSON.stringify(script), requestKey, requestHash],
    )).rows[0];
    await db.query(
      `insert into legal_video_script_revisions (
         script_id, project_id, revision, revision_hash, snapshot, actor_user_id
       ) values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [inserted.id, membership.projectId, script.revision, script.revisionHash,
        JSON.stringify(script), input.actorUserId],
    );
    return { script: fromRow(inserted), duplicate: false };
  });
}

export async function updateLegalVideoScriptRecord(input: {
  pool: TransactionPool;
  actorUserId: number;
  scriptId: number;
  expectedRevision: number;
  title?: unknown;
  durationSeconds?: unknown;
  scenes?: unknown;
}) {
  return withTransaction(input.pool, async (db) => {
    const membership = await requireSelectedProjectPermission(db, input.actorUserId, "content.edit");
    const row = (await db.query<Record<string, unknown>>(
      `select ${SCRIPT_COLUMNS} from legal_video_scripts
        where id = $1 and project_id = $2 for update`,
      [positiveId(input.scriptId), membership.projectId],
    )).rows[0];
    if (!row) throw new LegalVideoScriptServiceError("not_found");
    if (Number(row.revision) !== input.expectedRevision) throw new LegalVideoScriptServiceError("version_conflict");
    const current = fromRow(row).script;
    let next: LegalVideoScript;
    try {
      const requestedDuration = input.durationSeconds == null
        ? undefined
        : duration(input.durationSeconds);
      if (requestedDuration != null && requestedDuration !== current.durationSeconds && input.scenes == null) {
        const claim = current.sourceEvidence[0]?.claim ?? current.sourceDraft.title;
        next = reviseLegalVideoScript(current, {
          title: input.title == null ? undefined : text(input.title, 180, current.title),
          durationSeconds: requestedDuration,
          scenes: defaultScenes(requestedDuration, text(input.title, 180, current.title), claim),
        });
      } else {
        next = reviseLegalVideoScript(current, {
          title: input.title == null ? undefined : text(input.title, 180, current.title),
          durationSeconds: requestedDuration,
          scenes: input.scenes == null ? undefined : input.scenes as LegalVideoSceneInput[],
        });
      }
    } catch (error) {
      throw new LegalVideoScriptServiceError("invalid_script", error);
    }
    const updated = (await db.query<Record<string, unknown>>(
      `update legal_video_scripts
          set title = $3, duration_seconds = $4, revision = $5, revision_hash = $6,
              snapshot = $7::jsonb, updated_by_user_id = $8, updated_at = now()
        where id = $1 and project_id = $2 and revision = $9
        returning ${SCRIPT_COLUMNS}`,
      [input.scriptId, membership.projectId, next.title, next.durationSeconds, next.revision,
        next.revisionHash, JSON.stringify(next), input.actorUserId, input.expectedRevision],
    )).rows[0];
    if (!updated) throw new LegalVideoScriptServiceError("version_conflict");
    await db.query(
      `insert into legal_video_script_revisions (
         script_id, project_id, revision, revision_hash, snapshot, actor_user_id
       ) values ($1,$2,$3,$4,$5::jsonb,$6)`,
      [input.scriptId, membership.projectId, next.revision, next.revisionHash,
        JSON.stringify(next), input.actorUserId],
    );
    return fromRow(updated);
  });
}

export async function getLegalVideoProductionBrief(input: {
  pool: Queryable;
  actorUserId: number;
  scriptId: number;
}) {
  const record = await getLegalVideoScript(input);
  return { record, brief: exportLegalVideoProductionBrief(record.script) };
}
