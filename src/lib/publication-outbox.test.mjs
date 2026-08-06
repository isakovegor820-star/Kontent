import { describe, expect, it, vi } from "vitest";

import { reconcilePublicationOutbox } from "./publication-outbox.mjs";

function poolForCounts(counts) {
  let operationStatus = "queued";
  const query = vi.fn(async (sql, params = []) => {
    if (sql.includes("select id from publication_operations")) {
      return { rowCount: 1, rows: [{ id: 9 }] };
    }
    if (sql.includes("count(*)::int as total")) return { rowCount: 1, rows: [counts] };
    if (sql.includes("update publication_operations set status")) {
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
});
