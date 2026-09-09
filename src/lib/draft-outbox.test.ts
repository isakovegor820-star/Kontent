import { describe, expect, it } from "vitest";

import {
  acknowledgePendingDraft,
  createDraftCopyId,
  findPendingDraft,
  listPendingDrafts,
  pendingDraftStorageKey,
  persistPendingDraft,
  projectDraftWorkspaceId,
  removePendingDraft,
  removePendingDraftCopy,
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
      formatting: [{ type: "bold", offset: 0, length: 9 }],
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
  it("preserves both tabs with equal local revision counters and acknowledges only its own copy", () => {
    const storage = memoryStorage();
    const a = revision({ copyId: "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", payload: { ...revision().payload, text: "tab A" } });
    const b = revision({ copyId: "copy_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", payload: { ...revision().payload, text: "tab B unsaved" } });
    persistPendingDraft(a, storage);
    persistPendingDraft(b, storage);
    expect(listPendingDrafts(7, storage).map((item) => item.payload.text).sort()).toEqual(["tab A", "tab B unsaved"]);
    expect(acknowledgePendingDraft(7, a.clientKey, a.revision, storage, a.copyId)).toBe(true);
    expect(listPendingDrafts(7, storage).map((item) => item.payload.text)).toEqual(["tab B unsaved"]);
    expect(findPendingDraft(7, { draftId: 41, copyId: b.copyId }, storage)?.payload.text).toBe("tab B unsaved");
    expect(findPendingDraft(8, { draftId: 41, copyId: b.copyId }, storage)).toBeNull();
  });

  it("does not consume another tab copy on explicit local deletion", () => {
    const storage = memoryStorage();
    const a = revision({ copyId: "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" });
    const b = revision({ copyId: "copy_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" });
    persistPendingDraft(a, storage);
    persistPendingDraft(b, storage);
    expect(removePendingDraft(7, a.clientKey, storage, a.copyId)).toBe(true);
    expect(listPendingDrafts(7, storage).map((item) => item.copyId)).toEqual([b.copyId]);
  });

  it("does not fall back to another tab when an explicit recovery copy was already acknowledged", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ copyId: "copy_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" }), storage);
    expect(findPendingDraft(7, { draftId: 41, copyId: "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }, storage)).toBeNull();
  });

  it("forks inherited reload/duplicate-tab records without consuming their source or server idempotency key", () => {
    const storage = memoryStorage();
    const legacy = revision();
    persistPendingDraft(legacy, storage);
    const inherited = findPendingDraft(7, { draftId: 41 }, storage)!;
    const first = { ...inherited, copyId: createDraftCopyId() };
    const duplicateTab = { ...inherited, copyId: createDraftCopyId() };
    expect(first.copyId).not.toBe(duplicateTab.copyId);
    persistPendingDraft(first, storage);
    persistPendingDraft(duplicateTab, storage);
    expect(listPendingDrafts(7, storage)).toHaveLength(3);
    expect(listPendingDrafts(7, storage).every((copy) => copy.clientKey === legacy.clientKey)).toBe(true);
    acknowledgePendingDraft(7, first.clientKey, first.revision, storage, first.copyId);
    expect(findPendingDraft(7, { draftId: 41, copyId: duplicateTab.copyId }, storage)).toEqual(duplicateTab);
    expect(findPendingDraft(7, { draftId: 41, copyId: `legacy:${legacy.clientKey}` }, storage)).toEqual(legacy);
  });

  it("rejects malformed copy identifiers without overwriting a valid local copy", () => {
    const storage = memoryStorage();
    const valid = revision({ copyId: createDraftCopyId() });
    persistPendingDraft(valid, storage);
    expect(persistPendingDraft(revision({ copyId: "invalid:other-account" }), storage)).toBe(false);
    expect(listPendingDrafts(7, storage)).toEqual([valid]);
    expect(acknowledgePendingDraft(7, valid.clientKey, valid.revision, storage, "invalid:other-account")).toBe(false);
  });

  it("round-trips the complete pending revision and scopes it to one account", () => {
    const storage = memoryStorage();
    const pending = revision();
    expect(persistPendingDraft(pending, storage)).toBe(true);
    expect(findPendingDraft(7, { draftId: 41 }, storage)).toEqual(pending);
    expect(findPendingDraft(8, { draftId: 41 }, storage)).toBeNull();
    expect(storage.getItem(pendingDraftStorageKey(7, pending.clientKey))).toContain("Локальная версия");
    expect(storage.getItem(pendingDraftStorageKey(7, pending.clientKey))).toContain('"formatting"');
  });

  it("keeps the newest revision when an older request ACK arrives", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ revision: 9 }), storage);
    expect(acknowledgePendingDraft(7, "draft_1234567890abcdef", 8, storage)).toBe(false);
    expect(listPendingDrafts(7, storage)).toHaveLength(1);
    expect(acknowledgePendingDraft(7, "draft_1234567890abcdef", 9, storage)).toBe(true);
    expect(listPendingDrafts(7, storage)).toEqual([]);
  });

  it("does not turn a server ACK into a false failure for a server-owned client key", () => {
    const storage = memoryStorage();

    expect(acknowledgePendingDraft(7, "monthly-item-draft:17:23", 9, storage)).toBe(false);
  });

  it("does not turn a server ACK into a false failure when outbox cleanup is blocked", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ copyId: "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }), storage);
    const blockedStorage: DraftOutboxStorage = {
      ...storage,
      removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
    };

    expect(acknowledgePendingDraft(7, "draft_1234567890abcdef", 9, blockedStorage, "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
    expect(listPendingDrafts(7, storage)).toHaveLength(1);
  });

  it("does not throw when browser storage refuses cleanup after a server success", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ copyId: "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" }), storage);
    const blockedStorage: DraftOutboxStorage = {
      ...storage,
      removeItem: () => { throw new DOMException("blocked", "SecurityError"); },
    };

    expect(removePendingDraft(7, "draft_1234567890abcdef", blockedStorage, "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(false);
    expect(listPendingDrafts(7, storage)).toHaveLength(1);
    expect(removePendingDraft(7, "draft_1234567890abcdef", storage, "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")).toBe(true);
    expect(listPendingDrafts(7, storage)).toEqual([]);
  });

  it("does not load another account even when draft and client identifiers collide", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision(), storage);
    persistPendingDraft(revision({ userId: 8, workspaceId: "personal:8" }), storage);
    expect(listPendingDrafts(7, storage).map((item) => item.userId)).toEqual([7]);
    expect(listPendingDrafts(8, storage).map((item) => item.userId)).toEqual([8]);
  });

  it("keeps pending revisions isolated between projects of the same account", () => {
    const storage = memoryStorage();
    const projectA = revision({
      workspaceId: projectDraftWorkspaceId(101),
      clientKey: "draft_project-a-1234567890",
      draftId: 51,
    });
    const projectB = revision({
      workspaceId: projectDraftWorkspaceId(202),
      clientKey: "draft_project-b-1234567890",
      draftId: 52,
    });
    expect(persistPendingDraft(projectA, storage)).toBe(true);
    expect(persistPendingDraft(projectB, storage)).toBe(true);

    expect(listPendingDrafts(7, storage, "project:101")).toEqual([projectA]);
    expect(listPendingDrafts(7, storage, "project:202")).toEqual([projectB]);
    expect(findPendingDraft(7, { draftId: 52 }, storage, "project:101")).toBeNull();
  });
});


describe("immutable copy deletion interleavings", () => {
  const copyId = "copy_aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  it.each([10, 9])("preserves a writer update after selection, including equal revision counters (%i)", (nextRevision) => {
    const storage = memoryStorage();
    const first = revision({ copyId });
    persistPendingDraft(first, storage);
    const selected = findPendingDraft(7, { copyId }, storage)!;
    const newer = revision({ copyId, revision: nextRevision, payload: { ...first.payload, text: "new unsaved text" } });
    persistPendingDraft(newer, storage);
    expect(removePendingDraftCopy(selected, storage)).toBe("changed");
    expect(findPendingDraft(7, { copyId }, storage)).toEqual(newer);
    expect(storage.length).toBe(1);
  });

  it("retains an update arriving inside the physical removal, after every comparison", () => {
    const backing = memoryStorage();
    const first = revision({ copyId });
    persistPendingDraft(first, backing);
    const selected = findPendingDraft(7, { copyId }, backing)!;
    const newer = revision({ copyId, revision: 10, payload: { ...first.payload, text: "interleaved before removeItem" } });
    let interleaved = false;
    const storage: DraftOutboxStorage = {
      ...backing, get length() { return backing.length; },
      removeItem: (key) => {
        if (!interleaved) { interleaved = true; persistPendingDraft(newer, backing); }
        backing.removeItem(key);
      },
    };
    expect(removePendingDraftCopy(selected, storage)).toBe("changed");
    expect(findPendingDraft(7, { copyId }, backing)).toEqual(newer);
  });

  it("cleanup removes only captured older keys when another version appears during cleanup", () => {
    const backing = memoryStorage();
    persistPendingDraft(revision({ copyId }), backing);
    const newer = revision({ copyId, revision: 11, payload: { ...revision().payload, text: "newest concurrent write" } });
    let interleaved = false;
    const storage: DraftOutboxStorage = {
      ...backing, get length() { return backing.length; },
      removeItem: (key) => {
        if (!interleaved) { interleaved = true; persistPendingDraft(newer, backing); }
        backing.removeItem(key);
      },
    };
    expect(persistPendingDraft(revision({ copyId, revision: 10 }), storage)).toBe(true);
    expect(findPendingDraft(7, { copyId }, backing)).toEqual(newer);
    expect(acknowledgePendingDraft(7, newer.clientKey, 10, backing, copyId)).toBe(false);
    expect(findPendingDraft(7, { copyId }, backing)).toEqual(newer);
  });

  it.each([undefined, copyId])("keeps concurrent old-client writes when logically deleting legacy identity %s", (legacyCopyId) => {
    const backing = memoryStorage();
    const first = revision({ copyId: legacyCopyId });
    const key = pendingDraftStorageKey(7, first.clientKey, legacyCopyId);
    backing.setItem(key, JSON.stringify(first));
    const selected = listPendingDrafts(7, backing)[0];
    const newer = revision({ copyId: legacyCopyId, payload: { ...first.payload, text: "old client, same revision, new text" } });
    const storage: DraftOutboxStorage = {
      ...backing, get length() { return backing.length; },
      setItem: (receiptKey, raw) => { backing.setItem(key, JSON.stringify(newer)); backing.setItem(receiptKey, raw); },
    };
    expect(removePendingDraftCopy(selected, storage)).toBe("changed");
    expect(listPendingDrafts(7, backing)).toEqual([newer]);
    expect(backing.getItem(key)).toBe(JSON.stringify(newer));
  });

  it("migrates an old mutable copy identity without resurrecting its acknowledged older value", () => {
    const storage = memoryStorage();
    const first = revision({ copyId });
    const key = pendingDraftStorageKey(7, first.clientKey, copyId);
    storage.setItem(key, JSON.stringify(first));
    expect(findPendingDraft(7, { copyId }, storage)).toEqual(first);
    const newer = revision({ copyId, revision: 10 });
    persistPendingDraft(newer, storage);
    expect(findPendingDraft(7, { copyId }, storage)).toEqual(newer);
    expect(acknowledgePendingDraft(7, first.clientKey, 10, storage, copyId)).toBe(true);
    expect(listPendingDrafts(7, storage)).toEqual([]);
    // Compatibility receipts preserve bytes under old mutable keys, not authority.
    expect(storage.getItem(key)).toBe(JSON.stringify(first));
    storage.setItem(key, JSON.stringify({ ...newer, revision: 11 }));
    expect(listPendingDrafts(7, storage)).toEqual([{ ...newer, revision: 11 }]);
  });

  it("physically removes a selected modern version and never consumes another user's copy", () => {
    const storage = memoryStorage();
    persistPendingDraft(revision({ copyId }), storage);
    persistPendingDraft(revision({ copyId, userId: 8, workspaceId: "personal:8" }), storage);
    const selected = findPendingDraft(7, { copyId }, storage)!;
    expect(removePendingDraftCopy(selected, storage)).toBe("removed");
    expect(listPendingDrafts(7, storage)).toEqual([]);
    expect(storage.length).toBe(1);
    expect(listPendingDrafts(8, storage)).toHaveLength(1);
  });
});
