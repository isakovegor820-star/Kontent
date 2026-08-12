import { beforeEach, describe, expect, it, vi } from "vitest";

const projectMocks = vi.hoisted(() => ({
  requireSelectedProjectPermission: vi.fn(),
}));
const editorialMocks = vi.hoisted(() => ({
  recordDraftRevisionInTransaction: vi.fn(),
}));

vi.mock("./project-permissions", async () => {
  const actual = await vi.importActual<typeof import("./project-permissions")>("./project-permissions");
  return { ...actual, requireSelectedProjectPermission: projectMocks.requireSelectedProjectPermission };
});
vi.mock("./editorial-approval", () => ({
  recordDraftRevisionInTransaction: editorialMocks.recordDraftRevisionInTransaction,
}));

import {
  PublicationSettingsError,
  createProjectPublicationBlock,
  getDraftPublicationPreferences,
  listProjectPublicationBlocks,
  saveDraftPublicationPreferences,
  updateProjectPublicationBlock,
} from "./publication-settings-service";

type TransactionPool = Parameters<typeof createProjectPublicationBlock>[0]["pool"];
type Queryable = Parameters<typeof listProjectPublicationBlocks>[0];

function queryable(query: unknown): Queryable {
  return { query } as unknown as Queryable;
}

function transactionPool(handler: (sql: string, values?: unknown[]) => unknown) {
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    const normalized = String(sql).trim().toLowerCase();
    if (["begin", "commit", "rollback"].includes(normalized)) return { rows: [], rowCount: 0 };
    return handler(String(sql), values) as { rows: unknown[]; rowCount?: number };
  });
  return {
    pool: { connect: vi.fn(async () => ({ query, release: vi.fn() })) } as unknown as TransactionPool,
    query,
  };
}

describe("project publication settings service", () => {
  beforeEach(() => {
    projectMocks.requireSelectedProjectPermission.mockReset();
    projectMocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 41,
      userId: 7,
      role: "owner",
      version: 1,
    });
    editorialMocks.recordDraftRevisionInTransaction.mockReset();
    editorialMocks.recordDraftRevisionInTransaction.mockResolvedValue({
      id: 81,
      contentHash: "c".repeat(64),
    });
  });

  it("lists only the server-selected project's reusable blocks", async () => {
    const query = vi.fn(async () => ({
      rows: [{
        id: "9",
        kind: "cta",
        name: "Консультация",
        body: "Запишитесь на консультацию.",
        version: "2",
        is_enabled: true,
        updated_at: "2026-08-11T10:00:00.000Z",
      }],
    }));
    const db = queryable(query);
    const blocks = await listProjectPublicationBlocks(db, 7);
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(db, 7, "project.read");
    expect(query).toHaveBeenCalledWith(expect.stringContaining("where project_id = $1"), [41]);
    expect(blocks).toEqual([expect.objectContaining({ id: 9, kind: "cta", version: 2 })]);
  });

  it("creates and audits a normalized project block", async () => {
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("insert into project_publication_blocks")) {
        return { rows: [{
          id: "12", kind: "author_signature", name: "Подпись автора",
          body: "Адвокат Анна Орлова", version: "1", is_enabled: true,
          updated_at: "2026-08-11T10:00:00.000Z",
        }] };
      }
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const block = await createProjectPublicationBlock({
      pool,
      actorUserId: 7,
      kind: "author_signature",
      name: "  Подпись   автора ",
      body: "Адвокат Анна Орлова\r\nМосква",
      requestId: "request-1",
    });
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      7,
      "project.manage",
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("insert into project_publication_blocks"),
      [41, "author_signature", "Подпись автора", "Адвокат Анна Орлова\nМосква", 7],
    );
    expect(block).toMatchObject({ id: 12, enabled: true, version: 1 });
  });

  it("updates a block only inside the selected project and rejects stale versions", async () => {
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("select version, kind")) return { rows: [{ version: "3", kind: "cta" }] };
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(updateProjectPublicationBlock({
      pool,
      actorUserId: 7,
      blockId: 8,
      expectedVersion: 2,
      kind: "cta",
      name: "Запись",
      body: "Запишитесь.",
      enabled: true,
    })).rejects.toEqual(expect.objectContaining({ code: "version_conflict" }));
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("where id = $1 and project_id = $2"),
      [8, 41],
    );
  });

  it("returns safe defaults for a project draft without saved preferences", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select id from drafts")) return { rows: [{ id: "33" }] };
      if (sql.includes("from draft_publication_preferences")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const preferences = await getDraftPublicationPreferences(queryable(query), 7, 33);
    expect(preferences).toEqual({
      draftId: 33,
      selectedBlockIds: [],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
      version: 0,
    });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("project_id = $2"), [33, 41]);
  });

  it("fails closed when any selected block is outside the project", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("select id from drafts")) return { rows: [{ id: "33" }] };
      if (sql.includes("from project_publication_blocks")) {
        return { rows: [{ id: "1", kind: "cta" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(saveDraftPublicationPreferences({
      pool,
      actorUserId: 7,
      draftId: 33,
      expectedVersion: 0,
      selectedBlockIds: [1, 999],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    })).rejects.toEqual(expect.objectContaining({ code: "invalid_block_selection" }));
  });

  it("rejects multiple first-comment blocks before saving", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("select id from drafts")) return { rows: [{ id: "33" }] };
      if (sql.includes("from project_publication_blocks")) {
        return { rows: [
          { id: "1", kind: "first_comment" },
          { id: "2", kind: "first_comment" },
        ] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    await expect(saveDraftPublicationPreferences({
      pool,
      actorUserId: 7,
      draftId: 33,
      expectedVersion: 0,
      selectedBlockIds: [1, 2],
      firstCommentFallback: "append_to_post",
      commentsMode: "provider_default",
      pinAfterPublish: false,
      reviewAt: null,
      reviewResponsibleUserId: null,
    })).rejects.toBeInstanceOf(PublicationSettingsError);
  });

  it("persists review settings only for an active project member and audits the version", async () => {
    const reviewAt = "2026-09-10T09:00:00.000Z";
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("select id from drafts")) return { rows: [{ id: "33" }] };
      if (sql.includes("from project_publication_blocks")) {
        return { rows: [{ id: "4", kind: "cta" }, { id: "5", kind: "first_comment" }] };
      }
      if (sql.includes("select 1 from project_members")) return { rows: [{ "?column?": 1 }] };
      if (sql.includes("select version from draft_publication_preferences")) return { rows: [] };
      if (sql.includes("insert into draft_publication_preferences")) {
        return { rows: [{
          draft_id: "33",
          selected_block_ids: [4, 5],
          first_comment_fallback: "append_to_post",
          comments_mode: "disabled",
          pin_after_publish: true,
          review_at: reviewAt,
          review_responsible_user_id: "8",
          version: "1",
        }] };
      }
      if (sql.includes("update drafts")) return { rows: [{ version: "4" }], rowCount: 1 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const preferences = await saveDraftPublicationPreferences({
      pool,
      actorUserId: 7,
      draftId: 33,
      expectedVersion: 0,
      selectedBlockIds: [4, 5],
      firstCommentFallback: "append_to_post",
      commentsMode: "disabled",
      pinAfterPublish: true,
      reviewAt,
      reviewResponsibleUserId: 8,
      now: new Date("2026-08-11T10:00:00.000Z"),
      requestId: "request-2",
    });
    expect(projectMocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      7,
      "content.edit",
    );
    expect(preferences).toMatchObject({
      draftId: 33,
      selectedBlockIds: [4, 5],
      commentsMode: "disabled",
      pinAfterPublish: true,
      reviewResponsibleUserId: 8,
      version: 1,
      draftVersion: 4,
      revisionId: 81,
    });
    expect(editorialMocks.recordDraftRevisionInTransaction).toHaveBeenCalledWith(
      expect.objectContaining({ query }),
      { draftId: 33, actorUserId: 7, projectId: 41 },
    );
  });
});
