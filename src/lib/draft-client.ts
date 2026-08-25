import type {
  DraftCreateInput,
  DraftRecoveryInput,
  DraftSaveState,
  DraftScheduleUpdateInput,
  DraftTrackingSelection,
  DraftWriteInput,
  DraftUpdateInput,
  ServerDraft,
} from "./draft-types";
import type { Network, Post, RealChannel } from "./types";
import { buildTrackedDestination } from "./utm";

type ErrorBody = {
  error?: string;
  current?: ServerDraft;
};

export class DraftRequestError extends Error {
  constructor(
    public readonly kind: "offline" | "failed" | "conflict" | "not_found",
    public readonly status: number,
    public readonly code: string,
    public readonly current?: ServerDraft,
  ) {
    super(code);
    this.name = "DraftRequestError";
  }
}

const DRAFT_CLIENT_KEY_PATTERN = /^draft_[A-Za-z0-9-]{16,}$/u;

/**
 * Синхронный single-flight для React ref. Нужен поверх disabled-состояния: два click
 * события до следующего рендера всё равно обязаны разделить один сетевой запрос.
 */
export function runSingleDraftSave<T>(
  holder: { current: Promise<T> | null },
  start: () => Promise<T>,
): Promise<T> {
  if (holder.current) return holder.current;
  const request = Promise.resolve().then(start);
  holder.current = request;
  const clear = () => {
    if (holder.current === request) holder.current = null;
  };
  void request.then(clear, clear);
  return request;
}

export const DRAFT_AUTOSAVE_DELAY_MS = 1_200;

export interface DraftAutosaveDecision {
  hydrated: boolean;
  revision: number;
  lastSavedRevision: number;
  lastAttemptedRevision: number;
  saveState: DraftSaveState;
  hasText: boolean;
  hasDestinations: boolean;
  scheduleValid: boolean;
  busy: boolean;
}

/**
 * Autosave is revision-driven rather than state-timer-driven. A failed attempt is not retried
 * forever; a new local revision may retry offline/failed saves, while a 409 conflict remains
 * blocked until the user reloads the newer server version.
 */
export function shouldAutosaveDraft(input: DraftAutosaveDecision): boolean {
  return (
    input.hydrated &&
    input.revision > Math.max(input.lastSavedRevision, input.lastAttemptedRevision) &&
    input.saveState !== "saving" &&
    input.saveState !== "conflict" &&
    input.hasText &&
    input.hasDestinations &&
    input.scheduleValid &&
    !input.busy
  );
}

export function scheduleDraftAutosave(
  save: () => void | Promise<void>,
  delayMs = DRAFT_AUTOSAVE_DELAY_MS,
): () => void {
  const delay = Number.isFinite(delayMs) && delayMs >= 0 ? delayMs : DRAFT_AUTOSAVE_DELAY_MS;
  const timer = globalThis.setTimeout(() => {
    void save();
  }, delay);
  return () => globalThis.clearTimeout(timer);
}

async function jsonOrNull<T>(response: Response): Promise<T | null> {
  return (await response.json().catch(() => null)) as T | null;
}

async function checked(response: Response): Promise<ServerDraft> {
  const body = await jsonOrNull<{ draft?: ServerDraft } & ErrorBody>(response);
  if (response.ok && body?.draft) return body.draft;
  const kind = response.status === 409 ? "conflict" : response.status === 404 ? "not_found" : "failed";
  throw new DraftRequestError(kind, response.status, body?.error ?? "server", body?.current);
}

async function request(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch {
    throw new DraftRequestError("offline", 0, "network");
  }
}

export function createDraftClientKey(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `draft_${globalThis.crypto.randomUUID()}`;
  }
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  const random = Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
  return `draft_${random || `${Date.now()}_${Math.random().toString(36).slice(2)}`}`;
}

/** Server-owned draft keys may use a different namespace and must not scope browser outbox data. */
export function ensureDraftClientKey(candidate: unknown): string {
  return typeof candidate === "string" && DRAFT_CLIENT_KEY_PATTERN.test(candidate)
    ? candidate
    : createDraftClientKey();
}

const LEGACY_DEMO_POST_ID = /^post_(?:past_\d+|fut_\d+|failed|q1|q2)$/;

function isLegacyDraftCandidate(post: Post): boolean {
  return (
    (post.status === "draft" || post.status === "queued") &&
    !LEGACY_DEMO_POST_ID.test(post.id)
  );
}

/** Seed и unowned legacy нельзя показывать вошедшему пользователю как его данные. */
export function isRecoverableLegacyDraft(post: Post, userId: number): boolean {
  return isLegacyDraftCandidate(post) && post.legacyOwnerUserId === userId;
}

/**
 * Старую browser-only копию без owner можно только предложить как скрытый кандидат.
 * Её содержимое нельзя открывать или отправлять на сервер до явного действия человека.
 */
export function isUnownedLegacyDraftCandidate(post: Post): boolean {
  return isLegacyDraftCandidate(post) && post.legacyOwnerUserId == null;
}

/** Явно привязывает одну выбранную локальную копию; foreign-owned записи не меняет. */
export function claimUnownedLegacyDraft(post: Post, userId: number): Post | null {
  if (!Number.isSafeInteger(userId) || userId <= 0 || !isUnownedLegacyDraftCandidate(post)) {
    return null;
  }
  return { ...post, legacyOwnerUserId: userId };
}

/** Новая форма выбирает только реально активные сети, которые умеет Composer. */
export function activeComposerNetworks(channels: RealChannel[]): Network[] {
  return (["tg", "vk"] as const).filter((network) =>
    channels.some((channel) => channel.network === network && channel.is_active),
  );
}

function sameMedia(left: Post["media"], right: Post["media"]): boolean {
  if (left == null || right == null) return left == null && right == null;
  if (left.kind !== right.kind) return false;
  if (left.kind === "carousel" && right.kind === "carousel") {
    return left.label === right.label.trim()
      && left.hue === right.hue
      && (left.renderOperationId ?? null) === (right.renderOperationId ?? null)
      && left.items.length === right.items.length
      && left.items.every((item, index) => {
        const expected = right.items[index];
        return expected != null
          && String(item.assetId) === String(expected.assetId)
          && item.label === expected.label.trim()
          && (item.url ?? null) === (expected.url ?? null)
          && item.mimeType === expected.mimeType;
      });
  }
  if (left.kind === "carousel" || right.kind === "carousel") return false;
  return (
    left.label === right.label.trim() &&
    left.hue === right.hue &&
    (left.assetId ?? null) === (right.assetId == null ? null : String(right.assetId)) &&
    (left.url ?? null) === (right.url ?? null) &&
    (left.mimeType ?? null) === (right.mimeType ?? null)
  );
}

function sameSource(left: Post["sourceRef"] | null, right: Post["sourceRef"] | null): boolean {
  if (left == null || right == null) return left == null && right == null;
  const comparable = (source: NonNullable<Post["sourceRef"]>) => ({
    kind: source.kind,
    id: source.id.trim(),
    label: source.label.trim(),
    topic: source.topic ?? null,
    readerProblem: source.readerProblem ?? null,
    semanticGoal: source.semanticGoal ?? null,
    hook: source.hook ?? null,
    structure: source.structure ?? null,
    whyItWorked: source.whyItWorked ?? null,
    provenance: source.provenance
      ? {
          kind: source.provenance.kind,
          id: source.provenance.id ?? null,
          label: source.provenance.label ?? null,
          url: source.provenance.url ?? null,
        }
      : null,
  });
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function sameAiValidation(
  left: ServerDraft["ai_validation"],
  right: DraftWriteInput["aiValidation"],
): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function sameTracking(
  left: DraftTrackingSelection | null | undefined,
  right: DraftTrackingSelection | null | undefined,
): boolean {
  if (left == null || right == null) return left == null && right == null;
  const utm = (values: DraftTrackingSelection["utmValues"]) => Object.entries(values)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey));
  try {
    return (
      left.shortLinkId === right.shortLinkId
      && left.shortUrlPath === right.shortUrlPath
      && buildTrackedDestination(left.destination, left.utmValues)
        === buildTrackedDestination(right.destination, right.utmValues)
      && left.placement === right.placement
      && JSON.stringify(utm(left.utmValues)) === JSON.stringify(utm(right.utmValues))
    );
  } catch {
    return false;
  }
}

/** Отличает безопасный replay того же POST от локально изменившегося содержимого. */
export function draftMatchesWrite(draft: ServerDraft, input: DraftWriteInput): boolean {
  return draftWriteMismatchFields(draft, input).length === 0;
}

export function draftWriteMismatchFields(draft: ServerDraft, input: DraftWriteInput): string[] {
  const actualIds = draft.destinations.map((destination) => destination.channel_id).sort((a, b) => a - b);
  const expectedIds = [...input.channelIds].sort((a, b) => a - b);
  const fields: string[] = [];
  if (draft.text !== input.text) fields.push("text");
  if (JSON.stringify(draft.formatting ?? []) !== JSON.stringify(input.formatting ?? [])) fields.push("formatting");
  if (draft.scheduled_at !== input.scheduledAt) fields.push("scheduledAt");
  if (input.scheduledAt == null) {
    if (draft.scheduled_timezone != null) fields.push("schedule");
  } else if (
    draft.scheduled_timezone !== input.schedule?.timezone
    || draft.scheduled_local_date !== input.schedule?.localDate
    || draft.scheduled_local_time !== input.schedule?.localTime
    || draft.scheduled_offset !== input.schedule?.offset
    || draft.scheduled_disambiguation !== input.schedule?.disambiguation
  ) fields.push("schedule");
  if (draft.origin !== input.origin) fields.push("origin");
  if (!sameMedia(draft.media, input.media)) fields.push("media");
  if (!sameTracking(draft.tracking, input.tracking)) fields.push("tracking");
  if (input.generationResultId != null) {
    if (draft.generation_result_id !== input.generationResultId || !draft.generation_binding_valid) {
      fields.push("generation");
    }
  } else {
    if (!sameSource(draft.source_ref, input.sourceRef)) fields.push("source");
    if (!sameAiValidation(draft.ai_validation, input.aiValidation)) fields.push("validation");
  }
  if (
    actualIds.length !== expectedIds.length
    || !actualIds.every((id, index) => id === expectedIds[index])
  ) fields.push("destinations");
  return fields;
}

/**
 * Интерфейс может повторно сообщить об изменении, пока запрос уже выполняется.
 * Ответ сервера относится к самой новой локальной редакции только тогда, когда
 * все сохранённые поля по-прежнему совпадают с формой. Настоящая новая правка
 * остаётся несохранённой независимо от гонки счётчиков.
 */
export function resolveAcknowledgedDraftRevision(input: {
  draft: ServerDraft;
  currentWrite: DraftWriteInput | null;
  requestRevision: number;
  currentRevision: number;
}): { revision: number; current: boolean; mismatchFields: string[] } {
  const normalizedWrite = input.currentWrite?.origin === "autopilot"
    ? { ...input.currentWrite, origin: "manual" as const, sourceRef: null }
    : input.currentWrite;
  const mismatchFields = normalizedWrite == null
    ? ["form_snapshot"]
    : draftWriteMismatchFields(input.draft, normalizedWrite);
  const current = mismatchFields.length === 0;
  return {
    revision: current ? input.currentRevision : input.requestRevision,
    current,
    mismatchFields,
  };
}

/**
 * Reuses the exact server snapshot when nothing changed locally. Besides avoiding a no-op
 * version bump, this is required for human review: another PATCH would invalidate its
 * version-bound ACK immediately before scheduling.
 */
export function reusableAcknowledgedDraft(input: {
  draft: ServerDraft | null;
  draftId: number | null;
  draftVersion: number | null;
  revision: number;
  lastSavedRevision: number;
}): ServerDraft | null {
  const { draft, draftId, draftVersion, revision, lastSavedRevision } = input;
  return draft &&
    draft.id === draftId &&
    draft.version === draftVersion &&
    revision === lastSavedRevision
    ? draft
    : null;
}

export async function listServerDrafts(signal?: AbortSignal): Promise<ServerDraft[]> {
  const response = await request("/api/drafts", { cache: "no-store", signal });
  const body = await jsonOrNull<{ drafts?: ServerDraft[] } & ErrorBody>(response);
  if (response.ok) return body?.drafts ?? [];
  throw new DraftRequestError("failed", response.status, body?.error ?? "server");
}

export async function getServerDraft(id: number, signal?: AbortSignal): Promise<ServerDraft> {
  return checked(await request(`/api/drafts/${id}`, { cache: "no-store", signal }));
}

export async function createServerDraft(
  input: DraftCreateInput,
): Promise<{ draft: ServerDraft; created: boolean }> {
  const response = await request("/api/drafts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrNull<{ draft?: ServerDraft; created?: boolean } & ErrorBody>(response);
  if (response.ok && body?.draft) return { draft: body.draft, created: body.created === true };
  const kind = response.status === 409 ? "conflict" : response.status === 404 ? "not_found" : "failed";
  throw new DraftRequestError(kind, response.status, body?.error ?? "server", body?.current);
}

export async function recoverServerDraft(
  sourceDraftId: number,
  input: DraftRecoveryInput,
): Promise<{ draft: ServerDraft; created: boolean }> {
  const response = await request(`/api/drafts/${sourceDraftId}/recover`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await jsonOrNull<{ draft?: ServerDraft; created?: boolean } & ErrorBody>(response);
  if (response.ok && body?.draft) return { draft: body.draft, created: body.created === true };
  const kind = response.status === 409 ? "conflict" : response.status === 404 ? "not_found" : "failed";
  throw new DraftRequestError(kind, response.status, body?.error ?? "server", body?.current);
}

export async function updateServerDraft(id: number, input: DraftUpdateInput): Promise<ServerDraft> {
  return checked(await request(`/api/drafts/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

export async function rescheduleServerDraft(
  id: number,
  input: DraftScheduleUpdateInput,
): Promise<ServerDraft> {
  return checked(await request(`/api/drafts/${id}/schedule`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }));
}

/** Server ACK increments the draft version and binds the attestation to that exact version. */
export async function attestServerDraftReview(id: number, version: number): Promise<ServerDraft> {
  return checked(await request(`/api/drafts/${id}/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  }));
}

export async function deleteServerDraft(id: number, version: number): Promise<void> {
  const response = await request(`/api/drafts/${id}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ version }),
  });
  if (response.ok) return;
  const body = await jsonOrNull<ErrorBody>(response);
  const kind = response.status === 409 ? "conflict" : response.status === 404 ? "not_found" : "failed";
  throw new DraftRequestError(kind, response.status, body?.error ?? "server", body?.current);
}

/** Apply local removal only after the server acknowledged the versioned DELETE. */
export async function deleteDraftAfterAck(
  id: number,
  version: number,
  onAcknowledged: (id: number) => void,
  remove: (id: number, version: number) => Promise<void> = deleteServerDraft,
): Promise<void> {
  await remove(id, version);
  onAcknowledged(id);
}
