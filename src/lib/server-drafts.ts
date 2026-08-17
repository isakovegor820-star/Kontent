import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import type {
  DraftCreateInput,
  DraftDestination,
  DraftScheduleUpdateInput,
  DraftTrackingSelection,
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
import { resolveLocalSchedule, ScheduleValidationError } from "./timezone-schedule";
import { recordDraftRevisionInTransaction } from "./editorial-approval";
import { requireSelectedProjectPermission } from "./project-permissions";
import {
  normalizeTrackingDestination,
  normalizeUtmValues,
  UTM_FIELDS,
  type UtmValues,
} from "./utm";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

type DraftRow = {
  id: number | string;
  project_id: number | string;
  author_user_id?: number | string;
  author_name?: string | null;
  editorial_state?: "draft" | "in_review" | "changes_requested" | "approved" | null;
  text: string;
  media: unknown;
  tracking: unknown;
  scheduled_at: Date | string | null;
  scheduled_timezone: string | null;
  scheduled_local_date: Date | string | null;
  scheduled_local_time: string | null;
  scheduled_offset: string | null;
  scheduled_disambiguation: "reject" | "earlier" | "later" | null;
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
  select d.id, d.project_id, d.user_id as author_user_id,
         coalesce(nullif(btrim(draft_author.name), ''), 'Участник ' || d.user_id::text) as author_name,
         coalesce(editorial_workflow.state, 'draft') as editorial_state,
         d.text, d.media, d.tracking, d.scheduled_at,
         d.scheduled_timezone, d.scheduled_local_date::text as scheduled_local_date,
         d.scheduled_local_time::text as scheduled_local_time,
         d.scheduled_offset, d.scheduled_disambiguation,
         d.origin, d.purpose, d.source_ref,
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
             join channels c on c.id = dd.channel_id and c.project_id = d.project_id
            where dd.draft_id = d.id
         ), '[]'::jsonb) as destinations
    from drafts d
    join users draft_author on draft_author.id = d.user_id
    left join draft_editorial_workflows editorial_workflow
      on editorial_workflow.draft_id = d.id and editorial_workflow.project_id = d.project_id
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
  if (!isRecord(value) || !["image", "video", "carousel"].includes(String(value.kind))) {
    throw new DraftValidationError("bad_media");
  }
  const label = requiredString(value.label, "bad_media", 200);
  const hue = Number(value.hue);
  if (!Number.isFinite(hue) || hue < 0 || hue > 360) {
    throw new DraftValidationError("bad_media");
  }

  if (value.kind === "carousel") {
    if (!Array.isArray(value.items) || value.items.length < 3 || value.items.length > 7) {
      throw new DraftValidationError("bad_media");
    }
    const seen = new Set<number>();
    const items = value.items.map((candidate) => {
      if (!isRecord(candidate)) throw new DraftValidationError("bad_media");
      const assetId = Number(candidate.assetId);
      if (!Number.isSafeInteger(assetId) || assetId <= 0 || seen.has(assetId)) {
        throw new DraftValidationError("bad_media");
      }
      seen.add(assetId);
      const itemLabel = requiredString(candidate.label, "bad_media", 200);
      const mimeType = String(candidate.mimeType || "");
      if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) {
        throw new DraftValidationError("bad_media");
      }
      let url: string | undefined;
      if (candidate.url != null) {
        url = String(candidate.url);
        if (url.length > 2_048 || !(url.startsWith("/") || /^https:\/\//iu.test(url))) {
          throw new DraftValidationError("bad_media");
        }
      }
      return { assetId: String(assetId), label: itemLabel, mimeType: mimeType as "image/jpeg" | "image/png" | "image/webp", ...(url ? { url } : {}) };
    });
    const renderOperationId = value.renderOperationId == null ? undefined : Number(value.renderOperationId);
    if (renderOperationId != null && (!Number.isSafeInteger(renderOperationId) || renderOperationId <= 0)) {
      throw new DraftValidationError("bad_media");
    }
    return { kind: "carousel", label, hue, items, ...(renderOperationId ? { renderOperationId } : {}) };
  }

  const media: NonNullable<Post["media"]> = { kind: value.kind as "image" | "video", label, hue };
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
      "radar_result",
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

const TRACKING_KEYS = new Set([
  "shortLinkId",
  "shortUrlPath",
  "destination",
  "utmValues",
  "placement",
]);
const SHORT_URL_PATH_RE = /^\/r\/[A-Za-z0-9_-]{20,64}$/u;
const TRACKING_PLACEMENTS = new Set<DraftTrackingSelection["placement"]>([
  "post",
  "first_comment",
  "cta",
  "source",
]);

function trackingSelection(value: unknown): DraftTrackingSelection | null {
  if (value == null) return null;
  if (!isRecord(value)) throw new DraftValidationError("bad_tracking");
  const keys = Object.keys(value);
  if (keys.length === 0) return null;
  if (keys.some((key) => !TRACKING_KEYS.has(key))) {
    throw new DraftValidationError("bad_tracking");
  }
  if (
    !Object.hasOwn(value, "shortLinkId")
    || !Object.hasOwn(value, "shortUrlPath")
    || !Object.hasOwn(value, "destination")
    || !Object.hasOwn(value, "utmValues")
    || !Object.hasOwn(value, "placement")
  ) {
    throw new DraftValidationError("bad_tracking");
  }

  const shortLinkId = value.shortLinkId == null ? null : Number(value.shortLinkId);
  if (shortLinkId != null && (!Number.isSafeInteger(shortLinkId) || shortLinkId <= 0)) {
    throw new DraftValidationError("bad_tracking");
  }
  const shortUrlPath = value.shortUrlPath == null ? null : String(value.shortUrlPath);
  if (
    (shortUrlPath != null && !SHORT_URL_PATH_RE.test(shortUrlPath))
    || (shortLinkId == null && shortUrlPath != null)
  ) {
    throw new DraftValidationError("bad_tracking");
  }
  if (!isRecord(value.utmValues)) throw new DraftValidationError("bad_tracking");
  if (
    Object.keys(value.utmValues).some((key) => !UTM_FIELDS.includes(key as (typeof UTM_FIELDS)[number]))
    || Object.values(value.utmValues).some((item) => typeof item !== "string")
  ) {
    throw new DraftValidationError("bad_tracking");
  }
  const placement = value.placement;
  if (typeof placement !== "string" || !TRACKING_PLACEMENTS.has(placement as DraftTrackingSelection["placement"])) {
    throw new DraftValidationError("bad_tracking");
  }
  try {
    return {
      shortLinkId,
      shortUrlPath,
      destination: normalizeTrackingDestination(
        requiredString(value.destination, "bad_tracking", 2_048),
      ),
      utmValues: normalizeUtmValues(value.utmValues as UtmValues),
      placement: placement as DraftTrackingSelection["placement"],
    };
  } catch (error) {
    if (error instanceof DraftValidationError) throw error;
    throw new DraftValidationError("bad_tracking");
  }
}

function storedTrackingSelection(value: unknown): DraftTrackingSelection | null {
  try {
    return trackingSelection(value);
  } catch {
    // A malformed legacy/database value is never reflected back into publication input.
    return null;
  }
}

function schedule(value: Record<string, unknown>) {
  if (value.scheduledAt == null || value.scheduledAt === "") {
    if (value.schedule != null) throw new DraftValidationError("schedule_instant_required");
    return { scheduledAt: null, schedule: null };
  }
  if (typeof value.scheduledAt !== "string" || !isRecord(value.schedule)) {
    throw new DraftValidationError("schedule_contract_required");
  }
  const disambiguation = value.schedule.disambiguation;
  if (disambiguation !== "reject" && disambiguation !== "earlier" && disambiguation !== "later") {
    throw new DraftValidationError("schedule_disambiguation_required");
  }
  try {
    const resolved = resolveLocalSchedule({
      localDate: requiredString(value.schedule.localDate, "invalid_local_time", 10),
      localTime: requiredString(value.schedule.localTime, "invalid_local_time", 5),
      timezone: requiredString(value.schedule.timezone, "invalid_timezone", 80),
      disambiguation,
      offset: value.schedule.offset == null || value.schedule.offset === ""
        ? null
        : requiredString(value.schedule.offset, "bad_schedule_offset", 6),
    }, value.scheduledAt);
    return {
      scheduledAt: resolved.scheduledAt,
      schedule: {
        localDate: resolved.localDate,
        localTime: resolved.localTime,
        timezone: resolved.timezone,
        disambiguation: resolved.disambiguation,
        offset: resolved.offset,
      },
    };
  } catch (error) {
    throw new DraftValidationError(
      error instanceof ScheduleValidationError ? error.code : "bad_time",
    );
  }
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
  const resolvedSchedule = schedule(value);
  const parsed: DraftWriteInput = {
    text: draftText(value.text),
    media: nullableMedia(value.media),
    scheduledAt: resolvedSchedule.scheduledAt,
    schedule: resolvedSchedule.schedule,
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
  if (Object.hasOwn(value, "tracking")) parsed.tracking = trackingSelection(value.tracking);
  return parsed;
}

export function parseDraftCreateInput(value: unknown): DraftCreateInput {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const clientKey = typeof value.clientKey === "string" ? value.clientKey : "";
  if (!CLIENT_KEY_RE.test(clientKey)) throw new DraftValidationError("bad_client_key");
  const parsed = parseDraftWriteInput(value);
  return { ...parsed, tracking: parsed.tracking ?? null, clientKey };
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
  // Autopilot/monthly drafts are server-created but intentionally become normal human
  // drafts on the first explicit edit. The monthly item keeps the immutable lineage by
  // draft_id; the client cannot mint trusted autopilot provenance by sending this value.
  const adoptsAutopilotDraft = value.origin === "autopilot";
  const parsed = parseDraftWriteInput(
    editableAiWithoutResult || adoptsAutopilotDraft ? { ...value, origin: "manual" } : value,
  );
  return {
    ...parsed,
    origin: editableAiWithoutResult ? "ai" : parsed.origin,
    version,
  };
}

export function parseDraftScheduleUpdateInput(value: unknown): DraftScheduleUpdateInput {
  if (!isRecord(value)) throw new DraftValidationError("bad_request");
  const version = Number(value.version);
  if (!Number.isSafeInteger(version) || version <= 0) {
    throw new DraftValidationError("bad_version");
  }
  const resolved = schedule(value);
  if (resolved.scheduledAt == null || resolved.schedule == null) {
    throw new DraftValidationError("schedule_instant_required");
  }
  return {
    version,
    scheduledAt: resolved.scheduledAt,
    schedule: resolved.schedule,
  };
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
  const authorUserId = Number(row.author_user_id);
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
    ...(Number.isSafeInteger(authorUserId) && authorUserId > 0
      ? {
          author_user_id: authorUserId,
          author_name: row.author_name?.trim() || `Участник ${authorUserId}`,
        }
      : {}),
    editorial_state:
      row.editorial_state === "in_review"
      || row.editorial_state === "changes_requested"
      || row.editorial_state === "approved"
        ? row.editorial_state
        : "draft",
    text: row.text,
    media: (row.media ?? null) as Post["media"],
    tracking: storedTrackingSelection(row.tracking),
    scheduled_at: row.scheduled_at == null ? null : toIso(row.scheduled_at),
    scheduled_timezone: row.scheduled_timezone,
    scheduled_local_date: row.scheduled_local_date == null
      ? null
      : String(row.scheduled_local_date).slice(0, 10),
    scheduled_local_time: row.scheduled_local_time == null
      ? null
      : String(row.scheduled_local_time).slice(0, 5),
    scheduled_offset: row.scheduled_offset,
    scheduled_disambiguation: row.scheduled_disambiguation,
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
  projectId: number,
  draftId: number,
): Promise<ServerDraft | null> {
  const result = await db.query<DraftRow>(
    `${DRAFT_SELECT} where d.project_id = $1 and d.id = $2`,
    [projectId, draftId],
  );
  return result.rows[0] ? mapDraft(result.rows[0]) : null;
}

async function assertProjectActiveChannels(
  db: Queryable,
  projectId: number,
  ids: number[],
): Promise<void> {
  const result = await db.query<{ id: number | string }>(
    `select id from channels
      where project_id = $1 and is_active = true and status = 'active' and id = any($2::bigint[])
      for share`,
    [projectId, ids],
  );
  const owned = new Set(result.rows.map((row) => Number(row.id)));
  if (owned.size !== ids.length || ids.some((id) => !owned.has(id))) {
    // Один и тот же ответ и для чужого, и для отключённого id: не раскрываем владельца.
    throw new DraftValidationError("bad_destinations");
  }
}

async function resolveProjectTracking(
  db: Queryable,
  projectId: number,
  tracking: DraftTrackingSelection | null | undefined,
): Promise<DraftTrackingSelection | null> {
  if (!tracking) return null;
  if (tracking.shortLinkId == null) return tracking;
  const result = await db.query<{
    id: number | string;
    slug: string;
    destination_url: string;
    utm_values: unknown;
  }>(
    `select id, slug, destination_url, utm_values
       from short_links
      where id = $1 and project_id = $2 and status = 'active'
        and revoked_at is null and (expires_at is null or expires_at > now())
      for share`,
    [tracking.shortLinkId, projectId],
  );
  const row = result.rows[0];
  if (!row) throw new DraftValidationError("bad_tracking");
  try {
    const utmValues = isRecord(row.utm_values)
      ? normalizeUtmValues(row.utm_values as UtmValues)
      : null;
    if (!utmValues) throw new Error("invalid_utm");
    const shortUrlPath = `/r/${row.slug}`;
    if (!SHORT_URL_PATH_RE.test(shortUrlPath)) throw new Error("invalid_slug");
    return {
      shortLinkId: Number(row.id),
      shortUrlPath,
      destination: normalizeTrackingDestination(row.destination_url),
      utmValues,
      placement: tracking.placement,
    } satisfies DraftTrackingSelection;
  } catch {
    throw new DraftValidationError("bad_tracking");
  }
}

async function assertOwnedMedia(
  db: Queryable,
  projectId: number,
  media: Post["media"],
): Promise<void> {
  if (!media) return;
  if (media.kind === "carousel") {
    const assetIds = media.items.map((item) => Number(item.assetId));
    const result = await db.query<{ id: number | string; kind: "image" | "video" }>(
      `select id, kind from media_assets
        where project_id = $1 and id = any($2::bigint[]) for share`,
      [projectId, assetIds],
    );
    if (result.rowCount !== assetIds.length || result.rows.some((row) => row.kind !== "image")) {
      throw new DraftValidationError("bad_media");
    }
    return;
  }
  if (!media.assetId) return;
  const result = await db.query<{ kind: "image" | "video" }>(
    `select kind from media_assets where id = $1 and project_id = $2 for share`,
    [Number(media.assetId), projectId],
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
    if (source.provenance?.kind === "radar_result") {
      const row = (await db.query<{
        id: string;
        text: string | null;
        description: string | null;
        title: string | null;
        handle: string | null;
        url: string;
      }>(
        `select result.id, result.text, result.description, result.title, result.handle, result.url
           from radar_search_results result
           join radar_search_runs run on run.id = result.run_id and run.user_id = $2
          where result.id = $1 and result.user_id = $2 and run.channel_id = $3
            and result.verification_status = 'verified'
            and result.result_type in ('post', 'trend')`,
        [sourceId, userId, channelId],
      )).rows[0];
      const canonicalText = String(row?.text || row?.description || row?.title || "").trim();
      if (!row || !canonicalText) throw new DraftValidationError("source_context_not_found");
      const label = row.title?.trim() || (row.handle ? `@${row.handle}` : "Публичный Telegram-источник");
      return {
        ...input,
        text: canonicalText,
        sourceRef: {
          kind: "trend",
          id: String(row.id),
          label,
          topic: topicFromSourceText(canonicalText),
          provenance: {
            kind: "radar_result",
            id: String(row.id),
            label,
            url: row.url,
          },
        },
      };
    }
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
      source_kind: string | null;
    }>(
      `select item.id, item.title, item.summary, item.link, feed.title as feed_title,
              feed.source_kind
         from rss_items item
         join rss_feeds feed on feed.id = item.feed_id
         join channels source_channel on source_channel.id = feed.channel_id
         join channels destination_channel on destination_channel.id = $3
        where item.id = $1 and feed.user_id = $2
          and source_channel.project_id = destination_channel.project_id`,
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
        ...(row.source_kind === "legal_opportunity"
          ? { factualGrounding: "curated_legal_source" as const }
          : {}),
        provenance: {
          kind: "rss_item",
          id: String(row.id),
          label,
          ...(row.link && /^https?:\/\//iu.test(row.link.trim())
            ? { url: row.link.trim().slice(0, 2_048) }
            : {}),
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
  const membership = await requireSelectedProjectPermission(db, userId, "project.read");
  const result = await db.query<DraftRow>(
    `${DRAFT_SELECT}
      where d.project_id = $1 and d.purpose <> 'source_context'
        and not exists (
          select 1
            from publication_operations operation
           where operation.project_id = d.project_id
             and operation.draft_id = d.id
             and operation.approved_revision_id is not null
             and operation.status in ('queued', 'published_unverified', 'published')
        )
      order by d.updated_at desc, d.id desc
      limit 200`,
    [membership.projectId],
  );
  return result.rows.map(mapDraft);
}

export async function getDraftForUser(
  userId: number,
  draftId: number,
  db: Queryable = getPool(),
): Promise<ServerDraft | null> {
  const membership = await requireSelectedProjectPermission(db, userId, "project.read");
  return selectDraft(db, membership.projectId, draftId);
}

export function generationDestinationIsSelected(channelIds: readonly number[], generationChannelId: number) {
  return channelIds.includes(generationChannelId);
}

export async function createDraftForUser(
  userId: number,
  input: DraftCreateInput,
  pool: TransactionPool = getPool(),
): Promise<{ draft: ServerDraft; created: boolean }> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const membership = await requireSelectedProjectPermission(tx, userId, "content.create");
    const projectId = membership.projectId;
    let trusted = input;
    let purpose: ServerDraft["purpose"] = input.origin === "manual"
      ? "publishable"
      : input.origin === "ai"
        ? "needs_review"
        : "source_context";
    await assertProjectActiveChannels(tx, projectId, input.channelIds);
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
      if (!generationDestinationIsSelected(input.channelIds, result.channelId)) {
        throw new DraftValidationError("generation_result_channel_conflict");
      }
      trusted = {
        ...input,
        text: result.text,
        origin: "ai",
        sourceRef: result.sourceRef,
        channelIds: input.channelIds,
        aiValidation: result.validation,
        generationResultId: result.id,
      };
      purpose = result.purpose;
    }
    await assertOwnedMedia(tx, projectId, trusted.media);
    const trustedTracking = await resolveProjectTracking(tx, projectId, trusted.tracking);
    const inserted = await tx.query<{ id: number | string; project_id: number | string }>(
      `insert into drafts
         (user_id, project_id, text, media, tracking, scheduled_at, origin, purpose, source_ref, client_key,
          review_policy_version, ai_validation, generation_result_id,
          scheduled_timezone, scheduled_local_date, scheduled_local_time,
          scheduled_offset, scheduled_disambiguation)
       values ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9::jsonb, $10, $11, $12::jsonb, $13,
               $14, $15, $16, $17, $18)
       on conflict (user_id, client_key) do nothing
       returning id, project_id`,
      [
        userId,
        projectId,
        trusted.text,
        trusted.media == null ? null : JSON.stringify(trusted.media),
        JSON.stringify(trustedTracking ?? {}),
        trusted.scheduledAt,
        trusted.origin,
        purpose,
        trusted.sourceRef == null ? null : JSON.stringify(trusted.sourceRef),
        trusted.clientKey,
        DRAFT_REVIEW_POLICY_VERSION,
        trusted.aiValidation == null ? null : JSON.stringify(trusted.aiValidation),
        trusted.generationResultId ?? null,
        trusted.schedule?.timezone ?? null,
        trusted.schedule?.localDate ?? null,
        trusted.schedule?.localTime ?? null,
        trusted.schedule?.offset ?? null,
        trusted.schedule?.disambiguation ?? null,
      ],
    );
    const created = inserted.rowCount === 1;
    let draftId = inserted.rows[0] ? Number(inserted.rows[0].id) : null;

    if (draftId != null) {
      await replaceDestinations(tx, draftId, trusted.channelIds);
      await recordDraftRevisionInTransaction(tx, {
        draftId,
        actorUserId: userId,
        projectId,
      });
    } else {
      const existing = await tx.query<{ id: number | string }>(
        `select id from drafts where project_id = $1 and user_id = $2 and client_key = $3`,
        [projectId, userId, input.clientKey],
      );
      draftId = existing.rows[0] ? Number(existing.rows[0].id) : null;
    }

    if (draftId == null) throw new Error("idempotent draft lookup failed");
    const draft = await selectDraft(tx, projectId, draftId);
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
    const membership = await requireSelectedProjectPermission(tx, userId, "content.edit");
    const projectId = membership.projectId;
    const selected = await tx.query<DraftRow>(
      `${DRAFT_SELECT} where d.id = $1 and d.project_id = $2 for update of d`,
      [draftId, projectId],
    );
    if (!selected.rows[0]) throw new DraftNotFoundError();
    const current = mapDraft(selected.rows[0]);
    if (current.version !== input.version) throw new DraftConflictError(current);
    if (current.purpose === "source_context") {
      throw new DraftValidationError("source_context_immutable");
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
      if (!generationDestinationIsSelected(input.channelIds, result.channelId)) {
        throw new DraftValidationError("generation_result_channel_conflict");
      }
      trustedText = result.text;
      trustedOrigin = "ai";
      trustedPurpose = result.purpose;
      trustedSourceRef = result.sourceRef ?? current.source_ref;
      trustedValidation = result.validation;
      trustedGenerationResultId = result.id;
    }

    await assertProjectActiveChannels(tx, projectId, input.channelIds);
    await assertOwnedMedia(tx, projectId, input.media);
    const trustedTracking = await resolveProjectTracking(
      tx,
      projectId,
      input.tracking === undefined ? current.tracking : input.tracking,
    );
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
              scheduled_timezone = $13,
              scheduled_local_date = $14,
              scheduled_local_time = $15,
              scheduled_offset = $16,
              scheduled_disambiguation = $17,
              tracking = $18::jsonb,
              human_reviewed_version = null,
              human_reviewed_at = null,
              version = version + 1,
              updated_at = now()
        where id = $1 and project_id = $2 and version = $12
        returning id`,
      [
        draftId,
        projectId,
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
        input.schedule?.timezone ?? null,
        input.schedule?.localDate ?? null,
        input.schedule?.localTime ?? null,
        input.schedule?.offset ?? null,
        input.schedule?.disambiguation ?? null,
        JSON.stringify(trustedTracking ?? {}),
      ],
    );

    if (updated.rowCount !== 1) {
      const latest = await selectDraft(tx, projectId, draftId);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(latest);
    }

    await replaceDestinations(tx, draftId, input.channelIds);
    await recordDraftRevisionInTransaction(tx, {
      draftId,
      actorUserId: userId,
      projectId,
    });
    const draft = await selectDraft(tx, projectId, draftId);
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

/** Меняет только календарную дату, не превращая перенос в редактирование текста или происхождения. */
export async function rescheduleDraftForUser(
  userId: number,
  draftId: number,
  input: DraftScheduleUpdateInput,
  pool: TransactionPool = getPool(),
): Promise<ServerDraft> {
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const membership = await requireSelectedProjectPermission(tx, userId, "content.edit");
    const projectId = membership.projectId;
    const selected = await tx.query<DraftRow>(
      `${DRAFT_SELECT} where d.id = $1 and d.project_id = $2 for update of d`,
      [draftId, projectId],
    );
    if (!selected.rows[0]) throw new DraftNotFoundError();
    const current = mapDraft(selected.rows[0]);
    if (current.version !== input.version) throw new DraftConflictError(current);
    if (current.purpose === "source_context") {
      throw new DraftValidationError("source_context_immutable");
    }

    const updated = await tx.query<{ id: number | string }>(
      `update drafts
          set scheduled_at = $3,
              scheduled_timezone = $4,
              scheduled_local_date = $5,
              scheduled_local_time = $6,
              scheduled_offset = $7,
              scheduled_disambiguation = $8,
              human_reviewed_version = null,
              human_reviewed_at = null,
              version = version + 1,
              updated_at = now()
        where id = $1 and project_id = $2 and version = $9
        returning id`,
      [
        draftId,
        projectId,
        input.scheduledAt,
        input.schedule.timezone,
        input.schedule.localDate,
        input.schedule.localTime,
        input.schedule.offset ?? null,
        input.schedule.disambiguation,
        input.version,
      ],
    );
    if (updated.rowCount !== 1) {
      const latest = await selectDraft(tx, projectId, draftId);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(latest);
    }

    await recordDraftRevisionInTransaction(tx, {
      draftId,
      actorUserId: userId,
      projectId,
    });
    const draft = await selectDraft(tx, projectId, draftId);
    if (!draft) throw new Error("rescheduled draft lookup failed");
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
    const membership = await requireSelectedProjectPermission(tx, userId, "content.edit");
    const projectId = membership.projectId;
    const selected = await tx.query<DraftRow>(
      `${DRAFT_SELECT}
        where d.project_id = $1 and d.id = $2
        for update of d`,
      [projectId, draftId],
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
        where id = $1 and project_id = $2 and version = $3
        returning id`,
      [draftId, projectId, version, DRAFT_REVIEW_POLICY_VERSION],
    );
    if (acknowledged.rowCount !== 1) {
      const latest = await selectDraft(tx, projectId, draftId);
      if (!latest) throw new DraftNotFoundError();
      throw new DraftConflictError(latest);
    }
    await tx.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, after_version, safe_data, idempotency_key
       ) values ($1, $2, 'draft.human_review_attested', 'draft', $3::text,
                 $4, $4 + 1, $5::jsonb, $6)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        projectId,
        userId,
        String(draftId),
        version,
        JSON.stringify({ policyVersion: DRAFT_REVIEW_POLICY_VERSION }),
        `draft:${draftId}:human-review:${version + 1}`,
      ],
    );
    const draft = await selectDraft(tx, projectId, draftId);
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
    const membership = await requireSelectedProjectPermission(tx, userId, "content.edit");
    const projectId = membership.projectId;
    const deleted = await tx.query<{ id: number | string; version: number | string }>(
      `delete from drafts where id = $1 and project_id = $2 and version = $3 returning id, version`,
      [draftId, projectId, version],
    );
    if (deleted.rowCount !== 1) {
      const current = await selectDraft(tx, projectId, draftId);
      if (!current) throw new DraftNotFoundError();
      throw new DraftConflictError(current);
    }
    await tx.query(
      `insert into audit_events (
         project_id, actor_user_id, action, entity_type, entity_id,
         before_version, safe_data, idempotency_key
       ) values ($1, $2, 'draft.deleted', 'draft', $3::text,
                 $4, '{}'::jsonb, $5)
       on conflict (project_id, idempotency_key) where idempotency_key is not null do nothing`,
      [
        projectId,
        userId,
        String(draftId),
        Number(deleted.rows[0]?.version ?? version),
        `draft:${draftId}:deleted:${version}`,
      ],
    );
    await tx.query("commit");
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}
