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

export function pendingDraftStorageKey(userId: number, clientKey: string): string {
  if (!validId(userId) || !validClientKey(clientKey)) throw new Error("invalid draft outbox scope");
  return `${PREFIX}${userId}:${clientKey}`;
}

function parseRecord(raw: string | null, expectedUserId: number): PendingDraftRevision | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as PendingDraftRevision;
    if (
      value?.schema !== 1 || value.userId !== expectedUserId
      || !validClientKey(value.clientKey)
      || !validWorkspaceId(value.workspaceId, expectedUserId)
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

/** Synchronous write-through is deliberate: the latest keystroke survives a hard close. */
export function persistPendingDraft(
  record: PendingDraftRevision,
  storage?: DraftOutboxStorage | null,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  if (!validWorkspaceId(record.workspaceId, record.userId)) return false;
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
  workspaceId?: string | null,
): PendingDraftRevision[] {
  const target = storageOrNull(storage);
  if (!target || !validId(userId)) return [];
  const prefix = `${PREFIX}${userId}:`;
  const records: PendingDraftRevision[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const key = target.key(index);
    if (!key?.startsWith(prefix)) continue;
    const record = parseRecord(target.getItem(key), userId);
    if (record && (workspaceId == null || record.workspaceId === workspaceId)) records.push(record);
  }
  return records.sort((left, right) => Date.parse(right.writtenAt) - Date.parse(left.writtenAt));
}

export function findPendingDraft(
  userId: number,
  selector: { draftId?: number | null; clientKey?: string | null },
  storage?: DraftOutboxStorage | null,
  workspaceId?: string | null,
): PendingDraftRevision | null {
  const records = listPendingDrafts(userId, storage, workspaceId);
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
  try {
    const key = pendingDraftStorageKey(userId, clientKey);
    const current = parseRecord(target.getItem(key), userId);
    if (!current || current.revision !== revision) return false;
    target.removeItem(key);
    return true;
  } catch {
    // The server ACK remains authoritative if private-mode storage refuses cleanup
    // or an imported draft carries a server-owned idempotency namespace.
    return false;
  }
}

export function removePendingDraft(
  userId: number,
  clientKey: string,
  storage?: DraftOutboxStorage | null,
): boolean {
  const target = storageOrNull(storage);
  if (!target) return false;
  try {
    target.removeItem(pendingDraftStorageKey(userId, clientKey));
    return true;
  } catch {
    // Publication success is server-owned. A private-mode or quota failure while
    // cleaning a recovery copy must never turn a queued publication into a false
    // client error or keep the user in the Composer.
    return false;
  }
}
