import { describe, expect, it } from "vitest";

import {
  hasPendingProjectInvite,
  PROJECT_INVITE_STORAGE_KEY,
  projectInviteTokenFromHash,
} from "./project-invite-client";

const token = "a".repeat(43);

describe("project invitation browser handoff", () => {
  it("reads only a valid fragment token", () => {
    expect(projectInviteTokenFromHash(`#token=${token}`)).toBe(token);
    expect(projectInviteTokenFromHash("#token=short")).toBeNull();
    expect(projectInviteTokenFromHash(`#other=${token}`)).toBeNull();
  });

  it("keeps the secret in session storage and fails closed when storage is unavailable", () => {
    expect(hasPendingProjectInvite({ getItem: (key) => key === PROJECT_INVITE_STORAGE_KEY ? token : null } as Storage)).toBe(true);
    expect(hasPendingProjectInvite({ getItem: () => { throw new Error("blocked"); } } as unknown as Storage)).toBe(false);
  });
});
