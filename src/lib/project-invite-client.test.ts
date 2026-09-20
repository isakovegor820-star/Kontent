import { describe, expect, it } from "vitest";

import {
  hasPendingProjectInvite,
  clearProjectInviteToken,
  PROJECT_INVITE_STORAGE_KEY,
  readProjectInvite,
  saveProjectInviteToken,
  projectInviteTokenFromHash,
} from "./project-invite-client";

const token = "a".repeat(43);

function memoryStorage(initial?: string) {
  let value = initial ?? null;
  return {
    getItem: () => value,
    setItem: (_key: string, next: string) => { value = next; },
    removeItem: () => { value = null; },
  };
}

describe("project invitation browser handoff", () => {
  it("reads only a valid fragment token", () => {
    expect(projectInviteTokenFromHash(`#token=${token}`)).toBe(token);
    expect(projectInviteTokenFromHash("#token=short")).toBeNull();
    expect(projectInviteTokenFromHash(`#other=${token}`)).toBeNull();
    expect(projectInviteTokenFromHash(`#token=${token}&token=${"b".repeat(43)}`)).toBeNull();
  });

  it("stores an incoming token and restores it after the login round trip", () => {
    const storage = memoryStorage();
    expect(readProjectInvite(`#token=${token}`, storage)).toEqual({ token, stored: true });
    expect(readProjectInvite("", storage)).toEqual({ token, stored: true });
  });

  it("rejects an explicit malformed invitation and removes the previous one", () => {
    const storage = memoryStorage(token);
    expect(readProjectInvite("#token=broken", storage)).toEqual({ token: null, stored: true });
    expect(hasPendingProjectInvite(storage)).toBe(false);
  });

  it("keeps a valid incoming token in memory when storage writes fail", () => {
    const storage = { ...memoryStorage(), setItem: () => { throw new Error("blocked"); } };
    expect(readProjectInvite(`#token=${token}`, storage)).toEqual({ token, stored: false });
    expect(saveProjectInviteToken(token, storage)).toBe(false);
    expect(readProjectInvite(`#token=${token}`, null)).toEqual({ token, stored: false });
  });

  it("requires a readable saved copy before handing off to login", () => {
    const storage = { ...memoryStorage(), setItem: () => {} };
    expect(saveProjectInviteToken(token, storage)).toBe(false);
  });

  it("does not remove a newer invitation when an earlier request finishes", () => {
    const storage = memoryStorage("b".repeat(43));
    expect(clearProjectInviteToken(storage, token)).toBe(true);
    expect(storage.getItem()).toBe("b".repeat(43));
    expect(clearProjectInviteToken(storage, "b".repeat(43))).toBe(true);
    expect(storage.getItem()).toBeNull();
  });

  it("does not treat the accessible skip link as a replacement invitation", () => {
    expect(readProjectInvite("#main", memoryStorage(token))).toEqual({ token, stored: true });
  });

  it("keeps the secret in session storage and fails closed when storage is unavailable", () => {
    expect(hasPendingProjectInvite({ getItem: (key) => key === PROJECT_INVITE_STORAGE_KEY ? token : null } as Storage)).toBe(true);
    expect(hasPendingProjectInvite({ getItem: () => { throw new Error("blocked"); } } as unknown as Storage)).toBe(false);
  });
});
