import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireSelectedProjectPermission: vi.fn(),
  activateNextPublicationExtra: vi.fn(),
}));

vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

vi.mock("./publication-extra-operations.mjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./publication-extra-operations.mjs")>();
  return { ...actual, activateNextPublicationExtra: mocks.activateNextPublicationExtra };
});

import {
  decidePublicationReview,
  PublicationReviewError,
  retryPublicationExtraOperation,
} from "./publication-review-service";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

function transactionPool(responder: (sql: string, values: unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
    return responder(sql, values);
  });
  return {
    pool: {
      connect: vi.fn(async () => ({ query, release: vi.fn() })),
    },
    query,
  };
}

describe("publication review decisions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 42,
      userId: 7,
      role: "publisher",
      version: 1,
    });
    mocks.activateNextPublicationExtra.mockResolvedValue(null);
  });

  it("completes a due review with optimistic version and project-scoped audit", async () => {
    const { pool, query } = transactionPool((sql, values) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) {
        expect(values).toEqual([9, 42]);
        return { rows: [{
          id: 9,
          version: 3,
          status: "due",
          review_at: "2026-08-12T10:00:00.000Z",
          responsible_user_id: 7,
          post_id: 12,
          publication_operation_id: 18,
          post_status: "published",
          channel_id: 5,
          network: "tg",
        }] };
      }
      if (sql.includes("update publication_review_tasks")) {
        expect(values[0]).toBe(9);
        expect(values[1]).toBe(42);
        expect(values[6]).toBe(3);
        return { rows: [{ version: 4, reminder_status: "cancelled" }], rowCount: 1 };
      }
      if (sql.includes("update publication_review_reminder_outbox")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const result = await decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 3,
      decision: "keep",
      idempotencyKey: "decision-request-0001",
      now: new Date("2026-08-12T12:00:00.000Z"),
    });
    expect(result).toMatchObject({
      reviewTaskId: 9,
      status: "completed",
      decision: "keep",
      version: 4,
      replayed: false,
    });
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "project.read",
    );
    expect(query.mock.calls.some(([sql]) => String(sql).includes("project_id = $2"))).toBe(true);
  });

  it("rejects a stale review version before changing state", async () => {
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) {
        return { rows: [{
          version: 5,
          status: "due",
          review_at: "2026-08-12T10:00:00.000Z",
          responsible_user_id: 7,
          post_status: "published",
        }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 4,
      decision: "update",
      idempotencyKey: "decision-request-0002",
    })).rejects.toMatchObject({ code: "version_conflict" } satisfies Partial<PublicationReviewError>);
    expect(query).toHaveBeenCalledWith("rollback");
  });

  it("lets the active assignee decide without publish permission and creates the update draft atomically", async () => {
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 42, userId: 7, role: "author", version: 1,
    });
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) return { rows: [{
        id: 9, version: 1, status: "due", review_at: "2026-08-12T10:00:00.000Z",
        responsible_user_id: 7, update_draft_id: null, post_id: 12,
        publication_operation_id: 18, post_status: "published", channel_id: 5,
        network: "tg", text: "Обновить материал", media: null, post_user_id: 21,
      }] };
      if (sql.includes("insert into drafts")) return { rows: [{ id: 55 }], rowCount: 1 };
      if (sql.includes("insert into draft_destinations")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into draft_revisions")) return { rows: [{ id: 66 }], rowCount: 1 };
      if (sql.includes("insert into draft_editorial_workflows")) return { rows: [], rowCount: 1 };
      if (sql.includes("update publication_review_tasks")) {
        return { rows: [{ version: 2, reminder_status: "cancelled" }], rowCount: 1 };
      }
      if (sql.includes("update publication_review_reminder_outbox")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 1,
      decision: "update",
      idempotencyKey: "decision-request-update-0001",
    })).resolves.toMatchObject({ draftId: 55, decision: "update", version: 2 });
    const statements = query.mock.calls.map(([sql]) => String(sql));
    expect(statements.findIndex((sql) => sql.includes("insert into draft_editorial_workflows")))
      .toBeLessThan(statements.findIndex((sql) => sql.includes("update publication_review_tasks")));
  });

  it("rejects an active member who is neither the assignee nor a publisher", async () => {
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 42, userId: 7, role: "author", version: 1,
    });
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) return { rows: [{
        id: 9, version: 1, status: "due", review_at: "2026-08-12T10:00:00.000Z",
        responsible_user_id: 8, post_status: "published",
      }] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 1,
      decision: "keep",
      idempotencyKey: "decision-request-forbidden-0001",
    })).rejects.toMatchObject({ code: "review_decision_forbidden" });
  });

  it("rejects an idempotency replay whose decision payload changed", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [{
        actor_user_id: 7,
        safe_data: { decision: "keep", request_fingerprint: "a".repeat(64) },
        after_version: 2,
      }] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 1,
      decision: "keep",
      note: "Другой текст решения",
      idempotencyKey: "decision-request-replay-0001",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("rejects unpin when the provider cannot prove pin support", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) {
        return { rows: [{
          id: 9,
          version: 1,
          status: "due",
          review_at: "2026-08-12T10:00:00.000Z",
          responsible_user_id: 7,
          post_id: 12,
          publication_operation_id: 18,
          post_status: "published",
          channel_id: 5,
          network: "vk",
        }] };
      }
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 1,
      decision: "unpin",
      idempotencyKey: "decision-request-0003",
    })).rejects.toMatchObject({ code: "pin_not_confirmed" });
    expect(mocks.activateNextPublicationExtra).not.toHaveBeenCalled();
  });

  it("creates an attributed Telegram unpin only after a successful pin", async () => {
    const { pool } = transactionPool((sql, values) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) return { rows: [{
        id: 9, version: 1, status: "due", review_at: "2026-08-12T10:00:00.000Z",
        responsible_user_id: 7, post_id: 12, publication_operation_id: 18,
        post_status: "published", channel_id: 5, network: "tg",
      }] };
      if (sql.includes("from publication_extra_operations pin")) return { rows: [{ exists: 1 }] };
      if (sql.includes("insert into publication_extra_operations")) {
        expect(sql).toContain("requested_by_user_id");
        expect(values.at(-1)).toBe(7);
        return { rows: [{ id: 77, status: "waiting_dependency" }], rowCount: 1 };
      }
      if (sql.includes("select status from publication_extra_operations")) {
        return { rows: [{ status: "pending" }] };
      }
      if (sql.includes("update publication_review_tasks")) {
        return { rows: [{ version: 2, reminder_status: "cancelled" }], rowCount: 1 };
      }
      if (sql.includes("update publication_review_reminder_outbox")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 9,
      expectedVersion: 1,
      decision: "unpin",
      idempotencyKey: "decision-request-unpin-0001",
    })).resolves.toMatchObject({ extraOperationId: 77, extraStatus: "pending" });
    expect(mocks.activateNextPublicationExtra).toHaveBeenCalledWith(expect.anything(), {
      projectId: 42, postId: 12,
    });
  });

  it("hides a review task from another selected project", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_review_tasks task")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(decidePublicationReview({
      pool: pool as never,
      actorUserId: 7,
      reviewTaskId: 999,
      expectedVersion: 1,
      decision: "keep",
      idempotencyKey: "decision-request-0004",
    })).rejects.toMatchObject({ code: "review_not_found" } satisfies Partial<PublicationReviewError>);
  });
});

describe("publication extra retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 42,
      userId: 7,
      role: "publisher",
      version: 1,
    });
  });

  const operationFingerprint = "a".repeat(64);
  const ambiguousRow = {
    id: 77,
    fingerprint: operationFingerprint,
    status: "failed",
    kind: "first_comment",
    request_snapshot: { providerId: "tg" },
    provider_started_at: "2026-08-12T10:00:00.000Z",
    last_error_code: "delivery_unknown",
    post_id: 12,
    post_status: "published",
  };

  it("requires an explicit external absence check before retrying ambiguous Telegram comment", async () => {
    const { pool, query } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_extra_operations extra")) return { rows: [ambiguousRow] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(retryPublicationExtraOperation({
      pool: pool as never,
      actorUserId: 7,
      operationId: 77,
      expectedFingerprint: operationFingerprint,
      verifiedAbsent: false,
      idempotencyKey: "extra-retry-request-0001",
    })).rejects.toMatchObject({
      code: "provider_confirmation_required",
    } satisfies Partial<PublicationReviewError>);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("update publication_extra_operations"))).toBe(false);
  });

  it("requeues the same immutable operation after absence is confirmed", async () => {
    const { pool, query } = transactionPool((sql, values) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_extra_operations extra")) {
        expect(values).toEqual([77, 42]);
        return { rows: [ambiguousRow] };
      }
      if (sql.includes("update publication_extra_operations")) {
        expect(values).toEqual([77, 42, operationFingerprint, true]);
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into publication_extra_outbox")) return { rows: [], rowCount: 1 };
      if (sql.includes("insert into audit_events")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected sql: ${sql}`);
    });
    const result = await retryPublicationExtraOperation({
      pool: pool as never,
      actorUserId: 7,
      operationId: 77,
      expectedFingerprint: operationFingerprint,
      verifiedAbsent: true,
      idempotencyKey: "extra-retry-request-0002",
    });
    expect(result).toEqual({ operationId: 77, status: "pending", replayed: false });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("publication_extra_outbox"))).toBe(true);
  });

  it("rejects a changed fingerprint and cannot retry another project", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [] };
      if (sql.includes("from publication_extra_operations extra")) return { rows: [] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(retryPublicationExtraOperation({
      pool: pool as never,
      actorUserId: 7,
      operationId: 999,
      expectedFingerprint: "b".repeat(64),
      idempotencyKey: "extra-retry-request-0003",
    })).rejects.toMatchObject({ code: "operation_not_found" } satisfies Partial<PublicationReviewError>);
  });

  it("rejects retry replay by another actor or with another confirmation payload", async () => {
    const { pool } = transactionPool((sql) => {
      if (sql.includes("from audit_events")) return { rows: [{
        actor_user_id: 8,
        safe_data: { fingerprint: operationFingerprint, request_fingerprint: "a".repeat(64) },
      }] };
      throw new Error(`unexpected sql: ${sql}`);
    });
    await expect(retryPublicationExtraOperation({
      pool: pool as never,
      actorUserId: 7,
      operationId: 77,
      expectedFingerprint: operationFingerprint,
      verifiedAbsent: true,
      idempotencyKey: "extra-retry-replay-0001",
    })).rejects.toMatchObject({ code: "idempotency_conflict" });
  });
});
