import { describe, expect, it } from "vitest";

import {
  acknowledgePendingDraft,
  findPendingDraft,
  listPendingDrafts,
  pendingDraftStorageKey,
  persistPendingDraft,
  type DraftOutboxStorage,
  type PendingDraftRevision,
} from "./draft-outbox";

function memoryStorage(): DraftOutboxStorage {
  const data = new Map<string, string>();
  return {
    get length() { return data.size; },
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => { data.set(key, value); },
    removeItem: (key) => { data.delete(key); },
    key: (index) => [...data.keys()][index] ?? null,
  };
}

function revision(overrides: Partial<PendingDraftRevision> = {}): PendingDraftRevision {
  return {
    schema: 1,
    userId: 7,
    workspaceId: "personal:7",
    clientKey: "draft_1234567890abcdef",
    draftId: 41,
    baseVersion: 3,
    revision: 9,
    writtenAt: "2026-08-02T10:00:00.000Z",
    payload: {
      text: "Локальная версия\nс переносом 🔒 https://example.test",
      media: { kind: "image", label: "Фото", hue: 12 },
      scheduledAt: "2026-08-03T10:00:00.000Z",
      origin: "manual",
      sourceRef: null,
      channelIds: [18],
      aiValidation: null,
    },
    form: { networks: ["tg"], channelIds: [18], date: "2026-08-03", time: "12:00", noDate: false },
    ...overrides,
  };
}

describe("durable draft outbox", () => {
  it("round-trips the complete pending revision and scopes it to one account", () => {
    const storage = memoryStorage();
    const pending = revision();
    expect(persistPendingDraft(pending, storage)).toBe(true);
    expect(findPendingDraft(7, { draftId: 41 }, storage)).toEqual(pending);
    expect(findPendingDraft(8, { draftId: 41 }, storage)).toBeNull();
    expect(storage.getItem(pendingDraftStorageKey(7, pending.clientKey))).toContain("Локальная версия");
  });

  it("keeps the newest revision when an older request ACK arrives", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ revision: 9 }), storage);
    expect(acknowledgePendingDraft(7, "draft_1234567890abcdef", 8, storage)).toBe(false);
    expect(listPendingDrafts(7, storage)).toHaveLength(1);
    expect(acknowledgePendingDraft(7, "draft_1234567890abcdef", 9, storage)).toBe(true);
    expect(listPendingDrafts(7, storage)).toEqual([]);
  });

  it("does not load another account even when draft and client identifiers collide", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision(), storage);
    persistPendingDraft(revision({ userId: 8, workspaceId: "personal:8" }), storage);
    expect(listPendingDrafts(7, storage).map((item) => item.userId)).toEqual([7]);
    expect(listPendingDrafts(8, storage).map((item) => item.userId)).toEqual([8]);
  });
});
