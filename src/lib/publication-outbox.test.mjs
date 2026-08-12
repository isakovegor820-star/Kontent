import { describe, expect, it, vi } from "vitest";

import { reconcilePublicationOutbox } from "./publication-outbox.mjs";

function poolForCounts(counts) {
  let operationStatus = "queued";
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes("select id from publication_operations")) {
      return { rowCount: 1, rows: [{ id: 9 }] };
    }
    if (sql.includes("count(*)::int as total")) return { rowCount: 1, rows: [counts] };
    if (sql.includes("update publication_operations") && sql.includes("set status")) {
      operationStatus = params[1];
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  return {
    query,
    connect: vi.fn(async () => ({
      query: vi.fn(async (sql) => sql.trim() === "begin" || sql.trim() === "rollback"
        ? { rowCount: 0, rows: [] }
        : { rowCount: 0, rows: [] }),
      release: vi.fn(),
    })),
    status: () => operationStatus,
  };
}

describe("publication operation terminal reconciliation", () => {
  it("passes the immutable post project to the queue producer", async () => {
    let claimed = false;
    const enqueue = vi.fn(async () => ({ id: "accepted" }));
    const query = vi.fn(async (sql, params = []) => {
      if (sql.includes("select id from publication_operations")) {
        return { rowCount: 1, rows: [{ id: 9 }] };
      }
      if (sql.includes("count(*)::int as total")) {
        return {
          rowCount: 1,
          rows: [{
            total: 1, pending: 0, enqueued: 1, failed: 0, dispatching: 0,
            published: 0, unverified: 0, cancelled: 0, terminal_failed: 0, active: 1,
          }],
        };
      }
      if (sql.includes("update publication_outbox") && sql.includes("status = 'enqueued'")) {
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes("update publication_operations")) return { rowCount: 1, rows: [] };
      return { rowCount: 0, rows: [], params };
    });
    const pool = {
      query,
      connect: vi.fn(async () => ({
        query: vi.fn(async (sql) => {
          if (sql.trim() === "begin" || sql.trim() === "commit" || sql.trim() === "rollback") {
            return { rowCount: 0, rows: [] };
          }
          if (sql.includes("select o.id")) {
            if (claimed) return { rowCount: 0, rows: [] };
            claimed = true;
            return {
              rowCount: 1,
              rows: [{
                id: 4,
                operation_id: 9,
                post_id: 81,
                attempts: 0,
                project_id: 23,
                schedule_revision: 2,
                scheduled_at: "2099-08-20T08:00:00.000Z",
              }],
            };
          }
          return { rowCount: 1, rows: [] };
        }),
        release: vi.fn(),
      })),
    };

    const result = await reconcilePublicationOutbox({ pool, enqueue, limit: 2 });

    expect(result.enqueued).toBe(1);
    expect(enqueue).toHaveBeenCalledWith(
      81,
      new Date("2099-08-20T08:00:00.000Z"),
      2,
      23,
    );
  });

  it("moves an enqueued operation to published from confirmed child posts", async () => {
    const pool = poolForCounts({
      total: 2, enqueued: 2, failed: 0, dispatching: 0,
      published: 2, unverified: 0, terminal_failed: 0, active: 0,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("published");
    expect(pool.status()).toBe("published");
  });

  it("keeps externally accepted but unverified children explicitly recoverable", async () => {
    const pool = poolForCounts({
      total: 1, enqueued: 1, failed: 0, dispatching: 0,
      published: 0, unverified: 1, terminal_failed: 0, active: 0,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("published_unverified");
  });

  it("does not call an active scheduled child published", async () => {
    const pool = poolForCounts({
      total: 1, enqueued: 1, failed: 0, dispatching: 0,
      published: 0, unverified: 0, terminal_failed: 0, active: 1,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("queued");
  });

  it("keeps a mixed published and healthy scheduled operation queued", async () => {
    const pool = poolForCounts({
      total: 2, enqueued: 2, failed: 0, dispatching: 0,
      published: 1, unverified: 0, cancelled: 0, terminal_failed: 0, active: 1,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("queued");
    expect(pool.status()).toBe("queued");
  });

  it("reports a real mixed terminal failure as partial", async () => {
    const pool = poolForCounts({
      total: 2, enqueued: 2, failed: 0, dispatching: 0,
      published: 1, unverified: 0, cancelled: 0, terminal_failed: 1, active: 0,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("partial");
  });

  it.each([
    { pending: 1, enqueued: 0, dispatching: 0 },
    { pending: 0, enqueued: 0, dispatching: 1 },
  ])("keeps a durable $pending/$dispatching dispatch state queued", async (outbox) => {
    const pool = poolForCounts({
      total: 1, failed: 0,
      published: 0, unverified: 0, cancelled: 0, terminal_failed: 0, active: 1,
      ...outbox,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("queued");
  });

  it("keeps a fully cancelled operation terminal during reconciliation", async () => {
    const pool = poolForCounts({
      total: 1, enqueued: 0, failed: 0, dispatching: 0,
      published: 0, unverified: 0, cancelled: 1, terminal_failed: 0, active: 0,
    });
    const result = await reconcilePublicationOutbox({ pool, enqueue: vi.fn() });
    expect(result.statuses[9]).toBe("cancelled");
    expect(pool.status()).toBe("cancelled");
  });
});
