import type {
  DraftCreateInput,
  DraftSaveState,
  DraftWriteInput,
  DraftUpdateInput,
  ServerDraft,
} from "./draft-types";
import type { Network, Post, RealChannel } from "./types";

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
  return (
    left.kind === right.kind &&
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

/** Отличает безопасный replay того же POST от локально изменившегося содержимого. */
export function draftMatchesWrite(draft: ServerDraft, input: DraftWriteInput): boolean {
  const actualIds = draft.destinations.map((destination) => destination.channel_id).sort((a, b) => a - b);
  const expectedIds = [...input.channelIds].sort((a, b) => a - b);
  return (
    draft.text === input.text &&
    draft.scheduled_at === input.scheduledAt &&
    draft.origin === input.origin &&
    sameMedia(draft.media, input.media) &&
    sameSource(draft.source_ref, input.sourceRef) &&
    sameAiValidation(draft.ai_validation, input.aiValidation) &&
    actualIds.length === expectedIds.length &&
    actualIds.every((id, index) => id === expectedIds[index])
  );
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

export async function updateServerDraft(id: number, input: DraftUpdateInput): Promise<ServerDraft> {
  return checked(await request(`/api/drafts/${id}`, {
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
