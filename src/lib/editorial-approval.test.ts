import { describe, expect, it, vi } from "vitest";

import { ProjectAccessError } from "./project-permissions";
import {
  decideDraftEditorialRequest,
  draftRevisionContentHash,
  EditorialConflictError,
  getEditorialSnapshotForUser,
  parseEditorialDecisionInput,
  parseEditorialSubmitInput,
  recordDraftRevisionInTransaction,
  submitDraftForEditorialReview,
} from "./editorial-approval";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const workflowRow = {
  draft_id: "41",
  project_id: "7",
  state: "in_review" as const,
  workflow_version: "2",
  current_revision_id: "81",
  submitted_revision_id: "81",
  approved_revision_id: null,
  approved_content_hash: null,
  workflow_updated_at: "2026-08-11T10:00:00.000Z",
  revision_project_id: "7",
  draft_version: "4",
  revision_author_user_id: "5",
  revision_content_hash: HASH_A,
  revision_snapshot: { schemaVersion: 1, text: "Текст" },
  revision_created_at: "2026-08-11T09:55:00.000Z",
};

function membership(role: "owner" | "author" | "approver" | "publisher", userId = 5) {
  return { project_id: "7", user_id: String(userId), role, version: "1" };
}

function fakePool(query: ReturnType<typeof vi.fn>) {
  const release = vi.fn();
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, release };
}

describe("editorial input and immutable hashes", () => {
  it("hashes canonical content independently of object key insertion order", () => {
    const first = { text: "Правовой разбор", media: null, schedule: { timezone: "UTC", at: null } };
    const second = { schedule: { at: null, timezone: "UTC" }, media: null, text: "Правовой разбор" };

    expect(draftRevisionContentHash(first)).toBe(draftRevisionContentHash(second));
    expect(draftRevisionContentHash(first)).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("requires exact revision, workflow and request versions at the API boundary", () => {
    expect(parseEditorialSubmitInput({
      revisionId: 81,
      contentHash: HASH_A,
      workflowVersion: 2,
    })).toEqual({ revisionId: 81, contentHash: HASH_A, workflowVersion: 2 });
    expect(() => parseEditorialDecisionInput({
      requestId: 10,
      requestVersion: 1,
      workflowVersion: 2,
      revisionId: 81,
      contentHash: HASH_A,
      decision: "request_changes",
      note: " ",
    })).toThrowError(/decision_note_required/u);
  });
});

describe("editorial project and revision safety", () => {
  it("keeps a project A read scoped even when the same draft id could exist elsewhere", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from user_project_preferences preference")) {
        return { rowCount: 1, rows: [membership("author")] };
      }
      if (sql.includes("from draft_editorial_workflows workflow")) {
        expect(sql).toContain("workflow.project_id = $1");
        expect(sql).toContain("draft.project_id = workflow.project_id");
        expect(params).toEqual([7, 41]);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });

    await expect(getEditorialSnapshotForUser(5, 41, { query } as never)).resolves.toBeNull();
    expect(query.mock.calls.flatMap((call) => call[1] ?? [])).not.toContain(8);
  });

  it("records an immutable revision and transactionally invalidates an older approval", async () => {
    const workflowUpdates: unknown[][] = [];
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from drafts draft")) {
        return {
          rowCount: 1,
          rows: [{
            id: "41",
            project_id: "7",
            user_id: "5",
            version: "5",
            text: "Исправленный текст",
            media: null,
            origin: "manual",
            purpose: "publishable",
            source_ref: null,
            scheduled_at: null,
            scheduled_timezone: null,
            scheduled_local_date: null,
            scheduled_local_time: null,
            scheduled_offset: null,
            scheduled_disambiguation: null,
            channel_ids: [11],
          }],
        };
      }
      if (sql.includes("from project_members member")) {
        return { rowCount: 1, rows: [membership("author")] };
      }
      if (sql.includes("insert into draft_revisions")) {
        return {
          rowCount: 1,
          rows: [{ id: "82", created_at: "2026-08-11T10:05:00.000Z" }],
        };
      }
      if (sql.includes("current_revision.content_hash")) {
        return {
          rowCount: 1,
          rows: [{
            state: "approved",
            version: "4",
            current_revision_id: "81",
            current_content_hash: HASH_B,
          }],
        };
      }
      if (sql.includes("update draft_editorial_workflows")) {
        workflowUpdates.push(params ?? []);
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });

    const revision = await recordDraftRevisionInTransaction({ query } as never, {
      draftId: 41,
      actorUserId: 5,
      projectId: 7,
    });

    expect(revision).toMatchObject({ id: 82, projectId: 7, draftId: 41, draftVersion: 5 });
    expect(workflowUpdates).toEqual([[7, 41, 82, true]]);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status = 'superseded'"))).toBe(true);
    const invalidationAudit = query.mock.calls.find(([, params]) =>
      Array.isArray(params) && params.includes("draft.approval_invalidated"));
    expect(invalidationAudit?.[1]).toContain(4);
    expect(invalidationAudit?.[1]).toContain(5);
  });

  it("rejects submit against a stale revision before creating a request", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rowCount: 0, rows: [] };
      if (sql.includes("from user_project_preferences preference")) {
        return { rowCount: 1, rows: [membership("author")] };
      }
      if (sql.includes("from draft_editorial_workflows workflow")) {
        return { rowCount: 1, rows: [workflowRow] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const { pool } = fakePool(query);

    await expect(submitDraftForEditorialReview(5, 41, {
      revisionId: 80,
      contentHash: HASH_A,
      workflowVersion: 2,
    }, pool as never)).rejects.toEqual(new EditorialConflictError("stale_revision"));
    expect(query.mock.calls.some(([sql]) => String(sql).includes("insert into draft_editorial_requests"))).toBe(false);
  });
});

describe("editorial approval race and permissions", () => {
  it("allows only one approver to resolve an exact open request", async () => {
    let requestStatus: "open" | "approved" = "open";
    let requestVersion = 1;
    let decisionInserts = 0;
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("from user_project_preferences preference")) {
        return { rowCount: 1, rows: [membership("approver", 9)] };
      }
      if (sql.includes("from draft_editorial_requests") && sql.includes("for update")) {
        return {
          rowCount: 1,
          rows: [{
            id: "12",
            revision_id: "81",
            content_hash: HASH_A,
            requested_by_user_id: "5",
            status: requestStatus,
            version: String(requestVersion),
          }],
        };
      }
      if (sql.includes("from draft_editorial_workflows workflow")) {
        return { rowCount: 1, rows: [workflowRow] };
      }
      if (sql.includes("insert into draft_editorial_decisions")) {
        decisionInserts += 1;
        return { rowCount: 1, rows: [{ id: "91" }] };
      }
      if (sql.includes("update draft_editorial_requests")) {
        requestStatus = "approved";
        requestVersion += 1;
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 1, rows: [] };
    });
    const { pool } = fakePool(query);
    const input = {
      requestId: 12,
      requestVersion: 1,
      workflowVersion: 2,
      revisionId: 81,
      contentHash: HASH_A,
      decision: "approve" as const,
      note: null,
    };

    await expect(decideDraftEditorialRequest(9, 41, input, pool as never)).resolves.toMatchObject({
      decisionId: 91,
      workflow: { state: "approved", version: 3, approvedRevisionId: 81 },
    });
    await expect(decideDraftEditorialRequest(9, 41, input, pool as never)).rejects.toEqual(
      new EditorialConflictError("stale_request"),
    );
    expect(decisionInserts).toBe(1);
  });

  it("forbids an author-role approval before reading or locking the request", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === "begin" || sql === "rollback") return { rowCount: 0, rows: [] };
      if (sql.includes("from user_project_preferences preference")) {
        return { rowCount: 1, rows: [membership("author")] };
      }
      throw new Error(`approval query must not be reached: ${sql}`);
    });
    const { pool } = fakePool(query);

    const error = await decideDraftEditorialRequest(5, 41, {
      requestId: 12,
      requestVersion: 1,
      workflowVersion: 2,
      revisionId: 81,
      contentHash: HASH_A,
      decision: "approve",
      note: null,
    }, pool as never).catch((reason) => reason);

    expect(error).toBeInstanceOf(ProjectAccessError);
    expect(error).toMatchObject({ code: "permission_denied" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("from draft_editorial_requests"))).toBe(false);
  });
});
