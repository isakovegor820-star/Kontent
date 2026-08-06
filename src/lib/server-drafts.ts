import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import type {
  DraftCreateInput,
  DraftDestination,
  DraftUpdateInput,
  DraftWriteInput,
  ServerDraft,
} from "./draft-types";
import {
  DRAFT_REVIEW_POLICY_VERSION,
  normalizeDraftAiValidation,
} from "./draft-review";
import {
  GenerationArtifactError,
  generationResultHash,
  resolveGenerationDraft,
} from "./generation-artifacts";
import type { Post } from "./types";
import { topicFromSourceText } from "./reference-adaptation";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

type DraftRow = {
  id: number | string;
  text: string;
  media: unknown;
  scheduled_at: Date | string | null;
  origin: Post["origin"];
  purpose: ServerDraft["purpose"];
  source_ref: unknown;
  generation_result_id: number | string | null;
  generation_result_hash: string | null;
  receipt_result_hash: string | null;
  receipt_payload: unknown;
  client_key: string;
  version: number | string;
  review_policy_version: number | string;
  ai_validation: unknown;
  human_reviewed_version: number | string | null;
  human_reviewed_at: Date | string | null;
  created_at: Date | string;
  updated_at: Date | string;
  destinations: unknown;
};

const ORIGINS = new Set<Post["origin"]>([
  "manual",
  "ai",
  "trend",
  "idea",
  "competitor",
  "rss",
  "autopilot",
]);
const CLIENT_KEY_RE = /^[A-Za-z0-9:_-]{16,160}$/;
const MAX_TEXT = 16_384;
const MAX_DESTINATIONS = 12;

const DRAFT_SELECT = `
  select d.id, d.text, d.media, d.scheduled_at, d.origin, d.purpose, d.source_ref,
         d.generation_result_id, gr.result_hash as generation_result_hash,
         vr.result_hash as receipt_result_hash, vr.receipt as receipt_payload,
         d.client_key, d.version, d.review_policy_version, d.ai_validation,
         d.human_reviewed_version, d.human_reviewed_at,
         d.created_at, d.updated_at,
         coalesce((
           select jsonb_agg(
             jsonb_build_object(
               'channel_id', c.id,
               'network', c.network,
               'title', c.title,
               'handle', c.handle,
               'is_active', c.is_active
             ) order by c.id
           )
             from draft_destinations dd
             join channels c on c.id = dd.channel_id and c.user_id = d.user_id
            where dd.draft_id = d.id
         ), '[]'::jsonb) as destinations
    from drafts d
    left join generation_results gr on gr.id = d.generation_result_id
    left join validation_receipts vr on vr.generation_result_id = gr.id`;

export class DraftValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "DraftValidationError";
  }
}

export class DraftNotFoundError extends Error {
  constructor() {
    super("not_found");
    this.name = "DraftNotFoundError";
  }
}

export class DraftConflictError extends Error {
  constructor(public readonly current: ServerDraft) {
    super("version_conflict");
    this.name = "DraftConflictError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, code: string, max: number): string {
  if (typeof value !== "string") throw new DraftValidationError(code);
  const clean = value.trim();
  if (!clean || clean.length > max) throw new DraftValidationError(code);
  return clean;
}

function draftText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_TEXT) {
    throw new DraftValidationError("empty_text");
  }
  return value;
}

function nullableMedia(value: unknown): Post["media"] {
  if (value == null) return null;
  if (!isRecord(value) || (value.kind !== "image" && value.kind !== "video")) {
    throw new DraftValidationError("bad_media");
  }
  const label = requiredString(value.label, "bad_media", 200);
  const hue = Number(value.hue);
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) {
    throw new DraftValidationError("bad_media");
  }

  const media: NonNullable<Post["media"]> = { kind: value.kind, label, hue };
  if (value.assetId != null) {
    const assetId = Number(value.assetId);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) {
      throw new DraftValidationError("bad_media");
    }
    media.assetId = String(assetId);
  }
  if (value.url != null) {
    const url = String(value.url);
    if (url.length > 2_048 || !(url.startsWith("/") || /^https:\/\//i.test(url))) {
      throw new DraftValidationError("bad_media");
    }
    media.url = url;
  }
  if (value.mimeType == null) media.mimeType = null;
  else {
    const mimeType = String(value.mimeType);
    if (mimeType.length > 120) throw new DraftValidationError("bad_media");
    media.mimeType = mimeType;
  }
  return media;
}

function nullableSourceRef(value: unknown): Post["sourceRef"] | null {
  if (value == null) return null;
  if (
    !isRecord(value)
    || !["trend", "idea", "reference", "competitor", "rss"].includes(String(value.kind))
  ) {
    throw new DraftValidationError("bad_source_ref");
  }
  const optionalString = (candidate: unknown, max: number) => {
    if (candidate == null || candidate === "") return undefined;
    return requiredString(candidate, "bad_source_ref", max);
  };
  let provenance: NonNullable<Post["sourceRef"]>["provenance"];
  if (value.provenance != null) {
    if (!isRecord(value.provenance) || ![
      "content_idea",
      "competitor_post",
      "trend",
      "saved_reference",
      "rss_item",
    ].includes(String(value.provenance.kind))) {
      throw new DraftValidationError("bad_source_ref");
    }
    provenance = {
      kind: value.provenance.kind as NonNullable<typeof provenance>["kind"],
      ...(optionalString(value.provenance.id, 200) ? { id: optionalString(value.provenance.id, 200) } : {}),
      ...(optionalString(value.provenance.label, 400) ? { label: optionalString(value.provenance.label, 400) } : {}),
      ...(optionalString(value.provenance.url, 2_048) ? { url: optionalString(value.provenance.url, 2_048) } : {}),
    };
  }
  const sourceRef: NonNullable<Post["sourceRef"]> = {
    kind: value.kind as NonNullable<Post["sourceRef"]>["kind"],
    id: requiredString(value.id, "bad_source_ref", 200),
    label: requiredString(value.label, "bad_source_ref", 400),
  };
  const topic = optionalString(value.topic, 500);
  const readerProblem = optionalString(value.readerProblem, 800);
  const semanticGoal = optionalString(value.semanticGoal, 800);
  const hook = optionalString(value.hook, 1_000);
  const structure = optionalString(value.structure, 2_000);
  const whyItWorked = optionalString(value.whyItWorked, 1_200);
  if (topic) sourceRef.topic = topic;
  if (readerProblem) sourceRef.readerProblem = readerProblem;
  if (semanticGoal) sourceRef.semanticGoal = semanticGoal;
  if (hook) sourceRef.hook = hook;
  if (structure) sourceRef.structure = structure;
  if (whyItWorked) sourceRef.whyItWorked = whyItWorked;
  if (provenance) sourceRef.provenance = provenance;
  return sourceRef;
}

function channelIds(value: unknown): number[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_DESTINATIONS) {
    throw new DraftValidationError("no_destinations");
  }
  const ids = [...new Set(value.map(Number))];
  if (
    ids.length !== value.length ||
    ids.some((id) => !Number.isSafeInteger(id) || id <= 0)
  ) {
    throw new DraftValidationError("bad_destinations");
  }
  return ids;
}

function scheduledAt(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new DraftValidationError("bad_time");
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new DraftValidationError("bad_time");
  return date.toISOString();
}

/** Строгий парсер границы API: неизвестные/неверные значения до SQL не доходят. */
export function parseDraftWriteInput(value: unknown): DraftWriteInput {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const origin = value.origin;
  if (typeof origin !== "string" || !ORIGINS.has(origin as Post["origin"])) {
    throw new DraftValidationError("bad_origin");
  }
  if (value.aiValidation != null) throw new DraftValidationError("server_owned_ai_validation");
  if (origin === "autopilot") throw new DraftValidationError("server_owned_origin");
  const generationResultId = value.generationResultId == null ? null : Number(value.generationResultId);
  if (generationResultId != null && (!Number.isSafeInteger(generationResultId) || generationResultId <= 0)) {
    throw new DraftValidationError("bad_generation_result");
  }
  if ((origin === "ai") !== (generationResultId != null)) {
    throw new DraftValidationError(origin === "ai" ? "generation_result_required" : "generation_result_unexpected");
  }
  return {
    text: draftText(value.text),
    media: nullableMedia(value.media),
    scheduledAt: scheduledAt(value.scheduledAt),
    origin: origin as Post["origin"],
    // Manual content has no server-verifiable provenance. Source metadata is accepted only
    // on records that are classified as non-publishable Source Contexts.
    sourceRef: origin === "trend" || origin === "idea" || origin === "competitor" || origin === "rss"
      ? nullableSourceRef(value.sourceRef)
      : null,
    channelIds: channelIds(value.channelIds),
    aiValidation: null,
    generationResultId,
  };
}

export function parseDraftCreateInput(value: unknown): DraftCreateInput {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const clientKey = typeof value.clientKey === "string" ? value.clientKey : "";
  if (!CLIENT_KEY_RE.test(clientKey)) throw new DraftValidationError("bad_client_key");
  return { ...parseDraftWriteInput(value), clientKey };
}

export function parseDraftUpdateInput(value: unknown): DraftUpdateInput {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new DraftValidationError("bad_version");
  }
  // An existing AI draft may be human-edited without minting a new provider result. The
  // server loads and preserves its origin/lineage; the client hint does not grant trust.
  const editableAiWithoutResult = value.origin === "ai" && value.generationResultId == null;
  const parsed = parseDraftWriteInput(editableAiWithoutResult ? { ...value, origin: "manual" } : value);
  return { ...parsed, origin: editableAiWithoutResult ? "ai" : parsed.origin, version };
}

export function parseDraftVersion(value: unknown): number {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new DraftValidationError("bad_version");
  }
  return version;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeDestinations(value: unknown): DraftDestination[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const channelId = Number(item.channel_id);
    const network = item.network;
    if (!Number.isSafeInteger(channelId) || typeof network !== "string") return [];
    return [{
      channel_id: channelId,
      network: network as DraftDestination["network"],
      title: typeof item.title === "string" ? item.title : null,
      handle: typeof item.handle === "string" ? item.handle : null,
      is_active: item.is_active === true,
    }];
  });
}

function mapDraft(row: DraftRow): ServerDraft {
  const humanReviewVersion = Number(row.human_reviewed_version);
  const purpose: ServerDraft["purpose"] = row.purpose === "source_context" || row.purpose === "publishable"
    ? row.purpose
    : "needs_review";
  const normalizedValidation = normalizeDraftAiValidation(row.ai_validation);
  const receiptValidation = normalizeDraftAiValidation(row.receipt_payload);
  const generationResultId = row.generation_result_id == null ? null : Number(row.generation_result_id);
  const generationBindingValid = generationResultId != null
    && normalizedValidation != null
    && receiptValidation != null
    && row.generation_result_hash != null
    && row.generation_result_hash === row.receipt_result_hash
    && generationResultHash(row.text) === row.generation_result_hash
    && JSON.stringify(normalizedValidation) === JSON.stringify(receiptValidation);
  return {
    id: Number(row.id),
    text: row.text,
    media: (row.media ?? null) as Post["media"],
    scheduled_at: row.scheduled_at == null ? null : toIso(row.scheduled_at),
    origin: row.origin,
    purpose,
    source_ref: (row.source_ref ?? null) as Post["sourceRef"] | null,
    generation_result_id: generationResultId,
    generation_binding_valid: generationBindingValid,
    client_key: row.client_key,
    version: Number(row.version),
    review_policy_version: Number(row.review_policy_version) as 1,
    ai_validation: normalizedValidation,
    human_review:
      Number.isSafeInteger(humanReviewVersion) &&
      humanReviewVersion > 0 &&
      row.human_reviewed_at != null
        ? {
            policy_version: DRAFT_REVIEW_POLICY_VERSION,
            draft_version: humanReviewVersion,
            attested_at: toIso(row.human_reviewed_at),
          }
        : null,
    created_at: toIso(row.created_at),
    updated_at: toIso(row.updated_at),
    destinations: normalizeDestinations(row.destinations),
  };
}

async function selectDraft(
  db: Queryable,
  userId: number,
  draftId: number,
): Promise<ServerDraft | null> {
  const result = await db.query<DraftRow>(
    `${DRAFT_SELECT} where d.user_id = $1 and d.id = $2`,
    [userId, draftId],
  );
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

async function assertOwnedActiveChannels(
  db: Queryable,
  userId: number,
  ids: number[],
): Promise<void> {
  const result = await db.query<{ id: number | string }>(
    `select id from channels
      where user_id = $1 and is_active = true and id = any($2::bigint[])
      for share`,
    [userId, ids],
  );
  const owned = new Set(result.rows.map((row) => Number(row.id)));
  if (owned.size !== ids.length || ids.some((id) => !owned.has(id))) {
    // Один и тот же ответ и для чужого, и для отключённого id: не раскрываем владельца.
    throw new DraftValidationError("bad_destinations");
  }
}

async function assertOwnedMedia(
  db: Queryable,
  userId: number,
  media: Post["media"],
): Promise<void> {
  if (!media?.assetId) return;
  const result = await db.query<{ kind: "image" | "video" }>(
    `select kind from media_assets where id = $1 and user_id = $2 for share`,
    [Number(media.assetId), userId],
  );
  if (result.rowCount !== 1 || result.rows[0]?.kind !== media.kind) {
    throw new DraftValidationError("bad_media");
  }
}

async function resolveSourceContext(
  db: Queryable,
  userId: number,
  input: DraftCreateInput,
): Promise<DraftCreateInput> {
  const source = input.sourceRef;
  const channelId = input.channelIds.length === 1 ? input.channelIds[0] : null;
  if (!source || channelId == null) throw new DraftValidationError("bad_source_context");
  const sourceId = source.id;

  if (input.origin === "trend") {
    if (source.kind !== "trend") throw new DraftValidationError("bad_source_context");
    if (source.provenance?.kind === "trend") {
      const row = (await db.query<{
        id: string; text: string; title: string | null; handle: string;
      }>(
        `select post.id, post.text, trend.title, trend.handle
           from trend_posts post
           join trend_sources trend on trend.id = post.source_id and trend.enabled = true
          where post.id = $1 and post.text is not null and length(trim(post.text)) > 0`,
        [sourceId],
      )).rows[0];
      if (!row) throw new DraftValidationError("source_context_not_found");
      const label = row.title || `@${row.handle}`;
      return {
        ...input,
        text: row.text,
        sourceRef: {
          kind: "trend",
          id: String(row.id),
          label,
          topic: topicFromSourceText(row.text),
          provenance: { kind: "trend", id: String(row.id), label },
        },
      };
    }
    const row = (await db.query<{
      id: string; text: string; title: string | null; handle: string;
      topic: string | null; hook: string | null; structure: string | null; why_it_worked: string | null;
    }>(
      `select post.id, post.text, competitor.title, competitor.handle,
              idea.topic, idea.hook, idea.structure, idea.why_it_worked
         from competitor_posts post
         join competitors competitor on competitor.id = post.competitor_id
         left join content_ideas idea on idea.source_post_id = post.id and idea.user_id = $2
        where post.id = $1 and competitor.user_id = $2 and competitor.channel_id = $3
          and post.text is not null and length(trim(post.text)) > 0`,
      [sourceId, userId, channelId],
    )).rows[0];
    if (!row) throw new DraftValidationError("source_context_not_found");
    const label = row.title || `@${row.handle}`;
    return {
      ...input,
      text: row.text,
      sourceRef: {
        kind: "trend",
        id: String(row.id),
        label,
        topic: row.topic?.trim() || topicFromSourceText(row.text),
        ...(row.hook?.trim() ? { hook: row.hook } : {}),
        ...(row.structure?.trim() ? { structure: row.structure } : {}),
        ...(row.why_it_worked?.trim() ? { whyItWorked: row.why_it_worked } : {}),
        provenance: { kind: "competitor_post", id: String(row.id), label },
      },
    };
  }

  if (input.origin === "idea") {
    if (source.kind !== "idea") throw new DraftValidationError("bad_source_context");
    const row = (await db.query<{
      id: string; topic: string | null; hook: string | null; structure: string | null;
      why_it_worked: string | null; source_post_id: string | null;
      source_text: string | null; source_title: string | null; source_handle: string | null;
    }>(
      `select idea.id, idea.topic, idea.hook, idea.structure, idea.why_it_worked,
              idea.source_post_id, post.text as source_text,
              competitor.title as source_title, competitor.handle as source_handle
         from content_ideas idea
         left join competitor_posts post on post.id = idea.source_post_id
         left join competitors competitor on competitor.id = post.competitor_id
        where idea.id = $1 and idea.user_id = $2
          and (competitor.id is null or competitor.channel_id = $3)`,
      [sourceId, userId, channelId],
    )).rows[0];
    const canonicalText = [row?.topic, row?.hook, row?.structure].filter(Boolean).join("\n\n").trim();
    if (!row || !canonicalText) throw new DraftValidationError("source_context_not_found");
    const provenanceLabel = row.source_title || (row.source_handle ? `@${row.source_handle}` : "Источник идеи");
    return {
      ...input,
      text: canonicalText,
      sourceRef: {
        kind: "idea",
        id: String(row.id),
        label: "Идея Авроры",
        topic: row.topic?.trim() || topicFromSourceText(canonicalText),
        ...(row.hook?.trim() ? { hook: row.hook } : {}),
        ...(row.structure?.trim() ? { structure: row.structure } : {}),
        ...(row.why_it_worked?.trim() ? { whyItWorked: row.why_it_worked } : {}),
        provenance: {
          kind: "content_idea",
          ...(row.source_post_id ? { id: String(row.source_post_id) } : {}),
          label: provenanceLabel,
        },
      },
    };
  }

  if (input.origin === "competitor") {
    if (source.kind !== "competitor" && source.kind !== "reference") {
      throw new DraftValidationError("bad_source_context");
    }
    const row = (await db.query<{
      id: string; text: string; title: string | null; handle: string; tg_msg_id: string | null;
    }>(
      `select post.id, post.text, competitor.title, competitor.handle, post.tg_msg_id
         from competitor_posts post
         join competitors competitor on competitor.id = post.competitor_id
        where post.id = $1 and competitor.user_id = $2 and competitor.channel_id = $3
          and post.text is not null and length(trim(post.text)) > 0`,
      [sourceId, userId, channelId],
    )).rows[0];
    if (!row) throw new DraftValidationError("source_context_not_found");
    const label = row.title || `@${row.handle}`;
    const handle = row.handle.replace(/^@/u, "");
    return {
      ...input,
      text: row.text,
      sourceRef: {
        kind: "reference",
        id: String(row.id),
        label,
        topic: topicFromSourceText(row.text),
        provenance: {
          kind: "competitor_post",
          id: String(row.id),
          label,
          ...(row.tg_msg_id ? { url: `https://t.me/${handle}/${row.tg_msg_id}` } : {}),
        },
      },
    };
  }

  if (input.origin === "rss") {
    if (source.kind !== "rss") throw new DraftValidationError("bad_source_context");
    const row = (await db.query<{
      id: string;
      title: string | null;
      summary: string | null;
      link: string | null;
      feed_title: string | null;
    }>(
      `select item.id, item.title, item.summary, item.link, feed.title as feed_title
         from rss_items item
         join rss_feeds feed on feed.id = item.feed_id
        where item.id = $1 and feed.user_id = $2 and feed.channel_id = $3`,
      [sourceId, userId, channelId],
    )).rows[0];
    const canonicalText = [row?.title, row?.summary].filter(Boolean).join("\n\n").trim();
    if (!row || !canonicalText) throw new DraftValidationError("source_context_not_found");
    const label = row.feed_title?.trim() || "RSS-источник";
    return {
      ...input,
      text: canonicalText,
      sourceRef: {
        kind: "rss",
        id: String(row.id),
        label,
        topic: row.title?.trim() || topicFromSourceText(canonicalText),
        provenance: {
          kind: "rss_item",
          id: String(row.id),
          label,
          ...(row.link ? { url: row.link } : {}),
        },
      },
    };
  }
  throw new DraftValidationError("bad_source_context");
}

async function replaceDestinations(
  db: Queryable,
  draftId: number,
  ids: number[],
): Promise<void> {
  await db.query(`delete from draft_destinations where draft_id = $1`, [draftId]);
  await db.query(
    `insert into draft_destinations (draft_id, channel_id)
     select $1, destination_id from unnest($2::bigint[]) as ids(destination_id)`,
    [draftId, ids],
  );
}

export async function listDraftsForUser(
  userId: number,
  db: Queryable = getPool(),
): Promise<ServerDraft[]> {
  const result = await db.query<DraftRow>(
    `${DRAFT_SELECT}
      where d.user_id = $1 and d.purpose <> 'source_context'
      order by d.updated_at desc, d.id desc
      limit 200`,
    [userId],
  );
  return result.rows.map(mapDraft);
}

export async function getDraftForUser(
  userId: number,
  draftId: number,
  db: Queryable = getPool(),
): Promise<ServerDraft | null> {
  return selectDraft(db, userId, draftId);
}

export async function createDraftForUser(
  userId: number,
  input: DraftCreateInput,
  pool: TransactionPool = getPool(),
): Promise<{ draft: ServerDraft; created: boolean }> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    let trusted = input;
    let purpose: ServerDraft["purpose"] = input.origin === "manual"
      ? "publishable"
      : input.origin === "ai"
        ? "needs_review"
        : "source_context";
    await assertOwnedActiveChannels(tx, userId, input.channelIds);
    if (
      input.origin === "trend" || input.origin === "idea" ||
      input.origin === "competitor" || input.origin === "rss"
    ) {
      trusted = await resolveSourceContext(tx, userId, input);
    } else if (input.origin === "ai") {
      let result;
      try {
        result = await resolveGenerationDraft(userId, Number(input.generationResultId), tx);
      } catch (error) {
        if (error instanceof GenerationArtifactError) throw new DraftValidationError(error.code);
        throw error;
      }
      if (result.inputDraftId != null) throw new DraftValidationError("generation_result_target_conflict");
      if (input.text !== result.text) throw new DraftValidationError("generation_result_text_conflict");
      if (input.channelIds.length !== 1 || input.channelIds[0] !== result.channelId) {
        throw new DraftValidationError("generation_result_channel_conflict");
      }
      trusted = {
        ...input,
        text: result.text,
        origin: "ai",
        sourceRef: result.sourceRef,
        channelIds: [result.channelId],
        aiValidation: result.validation,
        generationResultId: result.id,
      };
      purpose = result.purpose;
    }
    await assertOwnedMedia(tx, userId, trusted.media);
    const inserted = await tx.query<{ id: number | string }>(
      `insert into drafts
         (user_id, text, media, scheduled_at, origin, purpose, source_ref, client_key,
          review_policy_version, ai_validation, generation_result_id)
       values ($1, $2, $3::jsonb, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb, $11)
       on conflict (user_id, client_key) do nothing
       returning id`,
      [
        userId,
        trusted.text,
        trusted.media == null ? null : JSON.stringify(trusted.media),
        trusted.scheduledAt,
        trusted.origin,
        purpose,
        trusted.sourceRef == null ? null : JSON.stringify(trusted.sourceRef),
        trusted.clientKey,
        DRAFT_REVIEW_POLICY_VERSION,
        trusted.aiValidation == null ? null : JSON.stringify(trusted.aiValidation),
        trusted.generationResultId ?? null,
      ],
    );
    const created = inserted.rowCount === 1;
    let draftId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;

    if (draftId != null) {
      await replaceDestinations(tx, draftId, trusted.channelIds);
    } else {
      const existing = await tx.query<{ id: number | string }>(
        `select id from drafts where user_id = $1 and client_key = $2`,
        [userId, input.clientKey],
      );
      draftId = existing.rows[0] ? Number(existing.rows[0].id) : null;
    }

    if (draftId == null) throw new Error("idempotent draft lookup failed");
    const draft = await selectDraft(tx, userId, draftId);
    if (!draft) throw new Error("created draft lookup failed");
    await tx.query("commit");
    return { draft, created };
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function updateDraftForUser(
  userId: number,
  draftId: number,
  input: DraftUpdateInput,
  pool: TransactionPool = getPool(),
): Promise<ServerDraft> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const selected = await tx.query<DraftRow>(
      `${DRAFT_SELECT} where d.id = $1 and d.user_id = $2 for update of d`,
      [draftId, userId],
    );
    if (!selected.rows[0]) throw new DraftNotFoundError();
    const current = mapDraft(selected.rows[0]);
    if (current.version !== input.version) throw new DraftConflictError(current);
    if (current.purpose === "source_context") {
      throw new DraftValidationError("source_context_immutable");
    }
    if (current.origin === "autopilot") {
      throw new DraftValidationError("server_owned_origin");
    }

    let trustedText = input.text;
    let trustedOrigin: Post["origin"] = current.origin === "ai" ? "ai" : "manual";
    let trustedPurpose: ServerDraft["purpose"] = current.origin === "ai"
      ? (input.text === current.text ? current.purpose : "needs_review")
      : "publishable";
    // The visible provenance describes the exact generated text. After a human edit the
    // immutable generation result remains traceable by generation_result_id, but presenting
    // its source beside different text would be a misleading attribution.
    let trustedSourceRef = current.origin === "ai" && input.text === current.text
      ? current.source_ref
      : null;
    let trustedValidation = current.origin === "ai" && input.text === current.text
      ? current.ai_validation
      : null;
    let trustedGenerationResultId = current.origin === "ai" ? current.generation_result_id : null;

    if (input.generationResultId != null) {
      let result;
      try {
        result = await resolveGenerationDraft(userId, input.generationResultId, tx);
      } catch (error) {
        if (error instanceof GenerationArtifactError) throw new DraftValidationError(error.code);
        throw error;
      }
      if (result.inputDraftId !== draftId || result.inputDraftVersion !== input.version) {
        throw new DraftValidationError("generation_result_target_conflict");
      }
      if (input.text !== result.text) throw new DraftValidationError("generation_result_text_conflict");
      if (input.channelIds.length !== 1 || input.channelIds[0] !== result.channelId) {
        throw new DraftValidationError("generation_result_channel_conflict");
      }
      trustedText = result.text;
      trustedOrigin = "ai";
      trustedPurpose = result.purpose;
      trustedSourceRef = result.sourceRef ?? current.source_ref;
      trustedValidation = result.validation;
      trustedGenerationResultId = result.id;
    } else if (current.origin === "ai") {
      const currentChannelIds = current.destinations.map((destination) => destination.channel_id).sort((a, b) => a - b);
      const requestedChannelIds = [...input.channelIds].sort((a, b) => a - b);
      if (
        currentChannelIds.length !== requestedChannelIds.length
        || currentChannelIds.some((id, index) => id !== requestedChannelIds[index])
      ) throw new DraftValidationError("generation_result_channel_conflict");
    }

    await assertOwnedActiveChannels(tx, userId, input.channelIds);
    await assertOwnedMedia(tx, userId, input.media);
    const updated = await tx.query<{ id: number | string }>(
      `update drafts
          set text = $3,
              media = $4::jsonb,
              scheduled_at = $5,
              origin = $6,
              purpose = $7,
              source_ref = $8::jsonb,
              review_policy_version = $9,
              ai_validation = $10::jsonb,
              generation_result_id = $11,
              human_reviewed_version = null,
              human_reviewed_at = null,
              version = version + 1,
              updated_at = now()
        where id = $1 and user_id = $2 and version = $12
        returning id`,
      [
        draftId,
        userId,
        trustedText,
        input.media == null ? null : JSON.stringify(input.media),
        input.scheduledAt,
        trustedOrigin,
        trustedPurpose,
        trustedSourceRef == null ? null : JSON.stringify(trustedSourceRef),
        DRAFT_REVIEW_POLICY_VERSION,
        trustedValidation == null ? null : JSON.stringify(trustedValidation),
        trustedGenerationResultId,
        input.version,
      ],
    );

    if (updated.rowCount !== 1) {
      const latest = await selectDraft(tx, userId, draftId);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(latest);
    }

    await replaceDestinations(tx, draftId, input.channelIds);
    const draft = await selectDraft(tx, userId, draftId);
    if (!draft) throw new Error("updated draft lookup failed");
    await tx.query("commit");
    return draft;
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

/** Human review is a server mutation bound to one exact immutable draft version. */
export async function attestDraftReviewForUser(
  userId: number,
  draftId: number,
  version: number,
  pool: TransactionPool = getPool(),
): Promise<ServerDraft> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const selected = await tx.query<DraftRow>(
      `${DRAFT_SELECT}
        where d.user_id = $1 and d.id = $2
        for update of d`,
      [userId, draftId],
    );
    const row = selected.rows[0];
    if (!row) throw new DraftNotFoundError();
    const current = mapDraft(row);
    if (current.version !== version) throw new DraftConflictError(current);
    if (
      current.origin !== "ai"
      || current.purpose === "source_context"
      || current.generation_result_id == null
      || (current.ai_validation?.status === "passed" && current.generation_binding_valid)
    ) {
      throw new DraftValidationError("review_not_required");
    }
    if (row.ai_validation != null && current.ai_validation == null) {
      throw new DraftValidationError("bad_ai_validation");
    }
    if (current.ai_validation?.status === "blocked") {
      throw new DraftValidationError("review_blocked");
    }

    const acknowledged = await tx.query<{ id: number | string }>(
      `update drafts
          set version = version + 1,
              review_policy_version = $4,
              human_reviewed_version = version + 1,
              human_reviewed_at = now(),
              updated_at = now()
        where id = $1 and user_id = $2 and version = $3
        returning id`,
      [draftId, userId, version, DRAFT_REVIEW_POLICY_VERSION],
    );
    if (acknowledged.rowCount !== 1) {
      const latest = await selectDraft(tx, userId, draftId);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(latest);
    }
    const draft = await selectDraft(tx, userId, draftId);
    if (!draft) throw new Error("reviewed draft lookup failed");
    await tx.query("commit");
    return draft;
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function deleteDraftForUser(
  userId: number,
  draftId: number,
  version: number,
  pool: TransactionPool = getPool(),
): Promise<void> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const deleted = await tx.query<{ id: number | string }>(
      `delete from drafts where id = $1 and user_id = $2 and version = $3 returning id`,
      [draftId, userId, version],
    );
    if (deleted.rowCount !== 1) {
      const current = await selectDraft(tx, userId, draftId);
      if (!current) throw new DraftNotFoundError();
      throw new DraftConflictError(current);
    }
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
