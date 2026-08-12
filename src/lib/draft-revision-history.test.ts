import { describe, expect, it, vi } from "vitest";

const permission = vi.hoisted(() => vi.fn(async () => ({
  projectId: 19,
  userId: 7,
  role: "author" as const,
  version: 1,
})));

vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: permission };
});

import { listDraftRevisionHistoryForUser } from "./editorial-approval";

describe("draft revision history", () => {
  it("queries immutable revisions inside the selected project and maps public fields", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      expect(sql).toContain("revision.project_id = $1");
      expect(sql).toContain("draft.project_id = $1");
      expect(values).toEqual([19, 44]);
      return {
        rows: [{
          id: "81",
          draft_id: "44",
          draft_version: "6",
          author_user_id: "7",
          author_name: "Егор",
          snapshot: { text: "Сохранённый текст" },
          created_at: "2026-08-12T12:00:00.000Z",
        }],
      };
    });
    const result = await listDraftRevisionHistoryForUser(7, 44, { query } as never);
    expect(permission).toHaveBeenCalledWith(expect.anything(), 7, "project.read");
    expect(result).toEqual([{
      id: 81,
      draftId: 44,
      draftVersion: 6,
      authorUserId: 7,
      authorName: "Егор",
      snapshot: { text: "Сохранённый текст" },
      createdAt: "2026-08-12T12:00:00.000Z",
    }]);
  });
});
