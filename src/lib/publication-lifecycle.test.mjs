import { describe, expect, it, vi } from "vitest";

import {
  cancelPublicationOperation,
  reschedulePublicationOperation,
} from "./publication-lifecycle.mjs";

function lifecyclePool() {
  const query = vi.fn(async (sql) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [], rowCount: 0 };
    if (sql.includes("from publication_operations operation") && sql.includes("for update of operation")) {
      return { rows: [{
        id: "7", project_id: "23", user_id: "5", scheduled_at: "2027-01-01T10:00:00.000Z",
        status: "pending", schedule_revision: "2", destination_ids: [12],
      }] };
    }
    if (sql.includes("from publication_operation_events")) return { rows: [] };
    if (sql.includes("from posts") && sql.includes("for update")) {
      return { rows: [{ id: "81", status: "scheduled", schedule_revision: "2", provider_started_at: null }] };
    }
    return { rows: [], rowCount: 1 };
  });
  return {
    pool: { connect: vi.fn(async () => ({ query, release: vi.fn() })) },
    query,
  };
}

const base = {
  userId: 5,
  projectId: 23,
  operationId: 7,
  expectedRevision: 2,
  expectedStatus: "pending",
};

describe("publication lifecycle review reconciliation", () => {
  it("cancels pending review tasks and their not-yet-running reminder outbox", async () => {
    const { pool, query } = lifecyclePool();
    await expect(cancelPublicationOperation({
      pool,
      ...base,
      idempotencyKey: "cancel-review-0001",
    })).resolves.toMatchObject({ ok: true, status: "cancelled" });
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("update publication_review_tasks task")
      && String(sql).includes("status = 'cancelled'"),
    )).toBe(true);
    expect(query.mock.calls.some(([sql]) =>
      String(sql).includes("update publication_review_reminder_outbox outbox")
      && String(sql).includes("publication_cancelled"),
    )).toBe(true);
  });

  it("shifts the absolute review instant by the publication schedule delta", async () => {
    const { pool, query } = lifecyclePool();
    await expect(reschedulePublicationOperation({
      pool,
      ...base,
      idempotencyKey: "reschedule-review-0001",
      scheduledAt: "2027-01-02T10:00:00.000Z",
      timezone: "Europe/Amsterdam",
      offset: "+01:00",
      disambiguation: "reject",
    })).resolves.toMatchObject({ ok: true, status: "scheduled" });
    const reviewCall = query.mock.calls.find(([sql]) =>
      String(sql).includes("update publication_review_tasks task"));
    expect(String(reviewCall?.[0])).toContain("review_at + ($2::timestamptz - $3::timestamptz)");
    expect(reviewCall?.[1]).toEqual([
      7,
      new Date("2027-01-02T10:00:00.000Z"),
      "2027-01-01T10:00:00.000Z",
      "Europe/Amsterdam",
      23,
    ]);
  });
});
