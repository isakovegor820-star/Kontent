import type { DraftWriteInput } from "./draft-types";
import type { Network } from "./types";

const PREFIX = "aurora:draft-outbox:v1:";

export interface PendingDraftRevision {
  schema: 1;
  userId: number;
  workspaceId: string;
  clientKey: string;
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

function storageOrNull(storage?: DraftOutboxStorage | null): DraftOutboxStorage | null {
  if (storage) return storage;
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function pendingDraftStorageKey(userId: number, clientKey: string): string {
  if (!validId(userId) || !validClientKey(clientKey)) throw new Error("invalid draft outbox scope");
  return `${PREFIX}${userId}:${clientKey}`;
}

function parseRecord(raw: string | null, expectedUserId: number): PendingDraftRevision | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingDraftRevision;
    if (value?.schema !== 1 || value.userId !== expectedUserId || !validClientKey(value.clientKey)) return null;
    if (!validId(value.revision) || (value.draftId !== null && !validId(value.draftId))) return null;
    if (value.baseVersion !== null && !validId(value.baseVersion)) return null;
    if (!value.payload || typeof value.payload.text !== "string" || !Array.isArray(value.payload.channelIds)) return null;
    if (!value.form || !Array.isArray(value.form.networks) || !Array.isArray(value.form.channelIds)) return null;
    return value;
  } catch {
    return null;
  }
}

/** Synchronous write-through is deliberate: the latest keystroke survives a hard close. */
export function persistPendingDraft(
  record: PendingDraftRevision,
  storage?: DraftOutboxStorage | null,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  if (record.workspaceId !== `personal:${record.userId}`) return false;
  try {
    target.setItem(pendingDraftStorageKey(record.userId, record.clientKey), JSON.stringify(record));
    return true;
  } catch {
    return false;
  }
}

export function listPendingDrafts(
  userId: number,
  storage?: DraftOutboxStorage | null,
): PendingDraftRevision[] {
  const target = storageOrNull(storage);
  if (!target || !validId(userId)) return [];
  const prefix = `${PREFIX}${userId}:`;
  const records: PendingDraftRevision[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key?.startsWith(prefix)) continue;
    const record = parseRecord(target.getItem(key), userId);
    if (record) records.push(record);
  }
  return records.sort((left, right) => Date.parse(right.writtenAt) - Date.parse(left.writtenAt));
}

export function findPendingDraft(
  userId: number,
  selector: { draftId?: number | null; clientKey?: string | null },
  storage?: DraftOutboxStorage | null,
): PendingDraftRevision | null {
  const records = listPendingDrafts(userId, storage);
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
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  const key = pendingDraftStorageKey(userId, clientKey);
  const current = parseRecord(target.getItem(key), userId);
  if (!current || current.revision !== revision) return false;
  target.removeItem(key);
  return true;
}

export function removePendingDraft(
  userId: number,
  clientKey: string,
  storage?: DraftOutboxStorage | null,
): void {
  const target = storageOrNull(storage);
  if (!target) return;
  target.removeItem(pendingDraftStorageKey(userId, clientKey));
}
