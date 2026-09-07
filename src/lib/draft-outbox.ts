import type { DraftWriteInput } from "./draft-types";
import type { Network } from "./types";

const PREFIX = "aurora:draft-outbox:v1:";
const RECEIPT_PREFIX = "aurora:draft-outbox-removed:v1:";

export interface PendingDraftRevision {
  schema: 1;
  userId: number;
  workspaceId: string;
  clientKey: string;
  /** Independent browser editor identity; never a server idempotency key. */
  copyId?: string;
  draftId: number | null;
  baseVersion: number | null;
  revision: number;
  writtenAt: string;
  payload: DraftWriteInput;
  form: {
    networks: Network[];
    channelIds: number[];
    date: string;
    time: string;
    noDate: boolean;
  };
}

export type DraftOutboxStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const validId = (value: unknown) => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const validClientKey = (value: unknown): value is string =>
  typeof value === "string" && /^draft_[A-Za-z0-9-]{16,}$/u.test(value);

const validCopyId = (value: unknown): value is string =>
  typeof value === "string" && /^copy_[A-Za-z0-9-]{16,}$/u.test(value);

export function createDraftCopyId(): string {
  return `copy_${globalThis.crypto.randomUUID()}`;
}

export function pendingDraftCopySelector(record: PendingDraftRevision): string {
  return record.copyId ?? `legacy:${record.clientKey}`;
}

function preferenceKey(userId: number, workspaceId: string, draftId: number | null): string {
  if (!validId(userId) || !validWorkspaceId(workspaceId, userId) || (draftId !== null && !validId(draftId))) {
    throw new Error("invalid draft recovery preference scope");
  }
  return `aurora:draft-copy:v1:${userId}:${workspaceId}:${draftId ?? "new"}`;
}

export function preferredDraftCopy(userId: number, workspaceId: string, draftId: number | null): string | null {
  try { return window.sessionStorage.getItem(preferenceKey(userId, workspaceId, draftId)); }
  catch { return null; }
}

export function rememberDraftCopy(userId: number, workspaceId: string, draftId: number | null, copyId: string): void {
  if (!validCopyId(copyId)) return;
  try { window.sessionStorage.setItem(preferenceKey(userId, workspaceId, draftId), copyId); }
  catch { /* Recovery records remain available through the explicit copy selector. */ }
}

function validWorkspaceId(value: unknown, userId: number): value is string {
  if (value === `personal:${userId}`) return true;
  if (typeof value !== "string") return false;
  const match = /^project:(\d+)$/u.exec(value);
  return Boolean(match && validId(match[1]));
}

export function projectDraftWorkspaceId(projectId: number): string {
  if (!validId(projectId)) throw new Error("invalid project draft workspace");
  return `project:${projectId}`;
}

function storageOrNull(storage?: DraftOutboxStorage | null): DraftOutboxStorage | null {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function pendingDraftStorageKey(userId: number, clientKey: string, copyId?: string): string {
  if (!validId(userId) || !validClientKey(clientKey)) throw new Error("invalid draft outbox scope");
  if (copyId !== undefined && !validCopyId(copyId)) throw new Error("invalid draft copy identity");
  return `${PREFIX}${userId}:${clientKey}${copyId === undefined ? "" : `:${copyId}`}`;
}

function parseRecord(raw: string | null, expectedUserId: number): PendingDraftRevision | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingDraftRevision;
    if (
      value?.schema !== 1 || value.userId !== expectedUserId
      || !validClientKey(value.clientKey)
      || !validWorkspaceId(value.workspaceId, expectedUserId)
      || (value.copyId !== undefined && !validCopyId(value.copyId))
    ) return null;
    if (!validId(value.revision) || (value.draftId !== null && !validId(value.draftId))) return null;
    if (value.baseVersion !== null && !validId(value.baseVersion)) return null;
    if (!value.payload || typeof value.payload.text !== "string" || !Array.isArray(value.payload.channelIds)) return null;
    if (!value.form || !Array.isArray(value.form.networks) || !Array.isArray(value.form.channelIds)) return null;
    return value;
  } catch {
    return null;
  }
}

type StoredDraft = { key: string; raw: string; record: PendingDraftRevision; immutable: boolean };
const storedDraftIdentity = new WeakMap<PendingDraftRevision, StoredDraft>();

function storedDrafts(userId: number, target: DraftOutboxStorage): StoredDraft[] {
  const entries: StoredDraft[] = [];
  // Snapshot keys before any cleanup; never delete a key discovered after a write.
  const keys = Array.from({ length: target.length }, (_, index) => target.key(index)).filter((key): key is string => key !== null);
  for (const key of keys) {
    if (!key.startsWith(`${PREFIX}${userId}:`)) continue;
    const raw = target.getItem(key);
    const record = parseRecord(raw, userId);
    if (!record || raw === null) continue;
    const base = pendingDraftStorageKey(userId, record.clientKey, record.copyId);
    const immutable = key.startsWith(`${base}:version:`);
    if (key !== base && !immutable) continue;
    // Legacy keys can still be written by an older tab. A receipt hides only the
    // exact selected value; removing the mutable key would lose a concurrent edit.
    if (!immutable && keys.some((candidate) => candidate.startsWith(`${RECEIPT_PREFIX}${base.slice(PREFIX.length)}:`) && target.getItem(candidate) === raw)) continue;
    entries.push({ key, raw, record, immutable });
  }
  return entries;
}

function removeStoredDraft(entry: StoredDraft, target: DraftOutboxStorage): void {
  if (entry.immutable) target.removeItem(entry.key);
  else target.setItem(`${RECEIPT_PREFIX}${entry.key.slice(PREFIX.length)}:${globalThis.crypto.randomUUID()}`, entry.raw);
}

/** Synchronous write-through is deliberate: the latest keystroke survives a hard close. */
export function persistPendingDraft(
  record: PendingDraftRevision,
  storage?: DraftOutboxStorage | null,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  if (!validWorkspaceId(record.workspaceId, record.userId)) return false;
  try {
    const base = pendingDraftStorageKey(record.userId, record.clientKey, record.copyId);
    const previous = record.copyId ? storedDrafts(record.userId, target).filter((entry) => entry.record.clientKey === record.clientKey && entry.record.copyId === record.copyId
      && entry.record.revision <= record.revision) : [];
    const key = record.copyId ? `${base}:version:${globalThis.crypto.randomUUID()}` : base;
    target.setItem(key, JSON.stringify(record));
    // New copies use immutable write identities, including two writes with the
    // same counter. Cleanup can only consume keys captured before this write.
    for (const entry of previous) {
      try { removeStoredDraft(entry, target); } catch { /* The new revision is durable; stale copies can be deduplicated on read. */ }
    }
    return true;
  } catch {
    return false;
  }
}

export function listPendingDrafts(
  userId: number,
  storage?: DraftOutboxStorage | null,
  workspaceId?: string | null,
): PendingDraftRevision[] {
  const target = storageOrNull(storage);
  if (!target || !validId(userId)) return [];
  try {
    const latest = new Map<string, StoredDraft>();
    for (const entry of storedDrafts(userId, target).sort((left, right) => right.record.revision - left.record.revision
      || Date.parse(right.record.writtenAt) - Date.parse(left.record.writtenAt) || Number(right.immutable) - Number(left.immutable))) {
      if (workspaceId != null && entry.record.workspaceId !== workspaceId) continue;
      const scope = `${entry.record.workspaceId}:${entry.record.clientKey}:${entry.record.copyId ?? "legacy"}`;
      if (!latest.has(scope)) latest.set(scope, entry);
    }
    return [...latest.values()].sort((left, right) => Date.parse(right.record.writtenAt) - Date.parse(left.record.writtenAt))
      .map((entry) => { storedDraftIdentity.set(entry.record, entry); return entry.record; });
  } catch { return []; }
}

/** Deletes a reviewed snapshot only. A later write keeps its distinct immutable key. */
export function removePendingDraftCopy(
  expected: PendingDraftRevision,
  storage?: DraftOutboxStorage | null,
): "removed" | "changed" | "unavailable" {
  const target = storageOrNull(storage);
  if (!target) return "unavailable";
  try {
    const current = findPendingDraft(expected.userId, { clientKey: expected.clientKey, copyId: pendingDraftCopySelector(expected) }, target, expected.workspaceId);
    if (!current) return "changed";
    const entry = storedDraftIdentity.get(current)!;
    const selected = storedDraftIdentity.get(expected);
    if (entry.raw !== JSON.stringify(expected) || (selected && selected.key !== entry.key)) return "changed";
    removeStoredDraft(entry, target);
    // A write can arrive even during removeItem. Its immutable identity survives;
    // report the remaining copy instead of claiming the newer content was deleted.
    return findPendingDraft(expected.userId, { clientKey: expected.clientKey, copyId: pendingDraftCopySelector(expected) }, target, expected.workspaceId)
      ? "changed" : "removed";
  } catch { return "unavailable"; }
}

export function findPendingDraft(
  userId: number,
  selector: { draftId?: number | null; clientKey?: string | null; copyId?: string | null },
  storage?: DraftOutboxStorage | null,
  workspaceId?: string | null,
): PendingDraftRevision | null {
  const records = listPendingDrafts(userId, storage, workspaceId);
  if (selector.copyId != null) {
    return records.find((record) => pendingDraftCopySelector(record) === selector.copyId
      && (selector.draftId == null || record.draftId === selector.draftId)
      && (selector.clientKey == null || record.clientKey === selector.clientKey)) ?? null;
  }
  if (selector.clientKey) {
    return records.find((record) => record.clientKey === selector.clientKey) ?? null;
  }
  if (selector.draftId != null) {
    return records.find((record) => record.draftId === selector.draftId) ?? null;
  }
  return null;
}

/** Deletes only the exact local revision acknowledged by the server. */
export function acknowledgePendingDraft(
  userId: number,
  clientKey: string,
  revision: number,
  storage?: DraftOutboxStorage | null,
  copyId?: string,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  try {
    pendingDraftStorageKey(userId, clientKey, copyId);
    const entries = storedDrafts(userId, target).filter((entry) => entry.record.clientKey === clientKey
      && entry.record.copyId === copyId && entry.record.revision === revision);
    for (const entry of entries) removeStoredDraft(entry, target);
    return entries.length > 0;
  } catch {
    // The server ACK remains authoritative if private-mode storage refuses cleanup.
    return false;
  }
}

export function removePendingDraft(
  userId: number,
  clientKey: string,
  storage?: DraftOutboxStorage | null,
  copyId?: string,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  try {
    pendingDraftStorageKey(userId, clientKey, copyId);
    const entries = storedDrafts(userId, target).filter((entry) => entry.record.clientKey === clientKey && entry.record.copyId === copyId);
    for (const entry of entries) removeStoredDraft(entry, target);
    return true;
  } catch {
    // Publication success remains server-owned if recovery cleanup is unavailable.
    return false;
  }
}
