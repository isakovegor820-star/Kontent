import { describe, expect, it, vi } from "vitest";

import { seedState } from "./mock";
import {
  createWorkspaceRequestFence,
  parseServerSelectedProjectId,
  readWorkspaceState,
  removeWorkspaceState,
  workspaceIdentityKey,
  workspaceStorageKey,
  writeWorkspaceState,
  type WorkspaceStorage,
} from "./client-workspace-isolation";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage: WorkspaceStorage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value); }),
    removeItem: vi.fn((key: string) => { values.delete(key); }),
  };
  return { storage, values };
}

describe("client workspace isolation", () => {
  it("uses a different storage key for every account/project pair", () => {
    expect(workspaceStorageKey({ userId: 7, projectId: 11 })).toBe(
      "aurora.state.v2:user:7:project:11",
    );
    expect(workspaceStorageKey({ userId: 8, projectId: 11 })).not.toBe(
      workspaceStorageKey({ userId: 7, projectId: 11 }),
    );
    expect(workspaceStorageKey({ userId: 7, projectId: 12 })).not.toBe(
      workspaceStorageKey({ userId: 7, projectId: 11 }),
    );
    expect(() => workspaceIdentityKey({ userId: 0, projectId: 11 })).toThrow(
      "invalid_workspace_identity",
    );
  });

  it("reads only the exact scoped key and never falls back to the legacy global key", () => {
    const state = seedState();
    state.posts = [{ ...state.posts[0], id: "project-11-post" }];
    const key = workspaceStorageKey({ userId: 7, projectId: 11 });
    const { storage } = memoryStorage({
      "aurora.state.v1": JSON.stringify({ ...seedState(), posts: [{ id: "leaked" }] }),
      [key]: JSON.stringify(state),
    });

    expect(readWorkspaceState(storage, { userId: 7, projectId: 11 })?.posts[0]?.id).toBe(
      "project-11-post",
    );
    expect(storage.getItem).toHaveBeenCalledTimes(1);
    expect(storage.getItem).toHaveBeenCalledWith(key);
    expect(readWorkspaceState(storage, { userId: 7, projectId: 12 })).toBeNull();
  });

  it("strips the authenticated user from persisted project state and resets only that project", () => {
    const state = seedState();
    state.user = {
      id: 7,
      name: "Егор",
      email: "egor@example.test",
      avatar: null,
      provider: "email",
      onboarded: true,
      isAdmin: false,
    };
    const identity = { userId: 7, projectId: 11 };
    const otherIdentity = { userId: 7, projectId: 12 };
    const { storage, values } = memoryStorage();

    writeWorkspaceState(storage, identity, state);
    writeWorkspaceState(storage, otherIdentity, state);
    expect(JSON.parse(values.get(workspaceStorageKey(identity)) ?? "null").user).toBeNull();

    removeWorkspaceState(storage, identity);
    expect(values.has(workspaceStorageKey(identity))).toBe(false);
    expect(values.has(workspaceStorageKey(otherIdentity))).toBe(true);
  });

  it("accepts only the dedicated server response as the selected project authority", () => {
    expect(parseServerSelectedProjectId({ projectId: 44 })).toBeNull();
    expect(parseServerSelectedProjectId({ detail: { projectId: 44 } })).toBeNull();
    expect(parseServerSelectedProjectId({ ok: true, project: { projectId: 44 } })).toBe(44);
    expect(parseServerSelectedProjectId({ ok: true, project: { projectId: 0 } })).toBeNull();
  });

  it("aborts superseded requests and rejects late responses from another workspace", () => {
    const fence = createWorkspaceRequestFence();
    const first = fence.start("user:7:project:11");
    const second = fence.start("user:7:project:12");

    expect(first.signal.aborted).toBe(true);
    expect(fence.isCurrent(first, "user:7:project:11")).toBe(false);
    expect(fence.isCurrent(second, "user:7:project:11")).toBe(false);
    expect(fence.isCurrent(second, "user:7:project:12")).toBe(true);

    fence.invalidate();
    expect(second.signal.aborted).toBe(true);
    expect(fence.isCurrent(second, "user:7:project:12")).toBe(false);
  });
});
