import { describe, expect, it, vi } from "vitest";

import { reconcilePublicationExtraOutbox } from "./publication-extra-outbox.mjs";

function fakePool(rows = []) {
  const queue = [...rows];
  const query = vi.fn(async (sql) => {
    if (String(sql).includes("select outbox.id")) return { rows: queue.length ? [queue.shift()] : [] };
    return { rows: [], rowCount: 1 };
  });
  return {
    query,
    connect: vi.fn(async () => ({ query, release: vi.fn() })),
  };
}

describe("publication extra outbox", () => {
  it("enqueues a project-scoped immutable job and transitions the operation to queued", async () => {
    const pool = fakePool([{
      id: "1",
      operation_id: "4",
      project_id: "9",
      outbox_status: "pending",
      attempts: "0",
      fingerprint: "a".repeat(64),
    }]);
    const enqueue = vi.fn(async () => ({}));
    const result = await reconcilePublicationExtraOutbox({ pool, enqueue, limit: 5 });
    expect(result).toEqual({ scanned: 1, enqueued: 1, failed: 0 });
    expect(enqueue).toHaveBeenCalledWith({
      operationId: 4,
      projectId: 9,
      fingerprint: "a".repeat(64),
    });
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("set status = 'queued'"))).toBe(true);
  });

  it("contains a fail-closed stale recovery branch for ambiguous Telegram comments", async () => {
    const pool = fakePool([]);
    await reconcilePublicationExtraOutbox({ pool, enqueue: vi.fn(), limit: 1 });
    const staleSql = String(pool.query.mock.calls[0][0]);
    expect(staleSql).toContain("operation.kind = 'first_comment'");
    expect(staleSql).toContain("request_snapshot->>'providerId' = 'tg'");
    expect(staleSql).toContain("delivery_unknown");
  });

  it("returns durable ownership to the database when queue dispatch fails", async () => {
    const pool = fakePool([{
      id: "1",
      operation_id: "4",
      project_id: "9",
      outbox_status: "pending",
      attempts: "0",
      fingerprint: "b".repeat(64),
    }]);
    const enqueue = vi.fn(async () => { throw Object.assign(new Error("down"), { code: "redis_down" }); });
    const result = await reconcilePublicationExtraOutbox({ pool, enqueue, limit: 1 });
    expect(result).toEqual({ scanned: 1, enqueued: 0, failed: 1 });
    expect(pool.query.mock.calls.some(([sql, values]) =>
      String(sql).includes("update publication_extra_outbox")
      && Array.isArray(values)
      && values.includes("redis_down"),
    )).toBe(true);
  });
});
