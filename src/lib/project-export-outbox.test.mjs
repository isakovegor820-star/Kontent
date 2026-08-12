import { describe, expect, it, vi } from "vitest";

import { expireProjectExportArtifacts, reconcileProjectExportOutbox } from "./project-export-outbox.mjs";

function outboxPool(row) {
  let claimed = false;
  const transactionQuery = vi.fn(async (sql) => {
    if (sql.includes("select outbox.id")) {
      if (claimed || !row) return { rowCount: 0, rows: [] };
      claimed = true;
      return { rowCount: 1, rows: [row] };
    }
    return { rowCount: 1, rows: [] };
  });
  const query = vi.fn(async (sql) => {
    if (sql.includes("update project_export_outbox") && sql.includes("where id = $1")) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  });
  return {
    query,
    connect: vi.fn(async () => ({ query: transactionQuery, release: vi.fn() })),
  };
}

const row = {
  id: 5,
  operation_id: 41,
  project_id: 7,
  attempts: 0,
  outbox_status: "pending",
  snapshot_hash: "a".repeat(64),
};

describe("project export durable outbox", () => {
  it("dispatches the immutable operation identity and marks the outbox enqueued", async () => {
    const pool = outboxPool(row);
    const enqueue = vi.fn(async () => ({}));
    await expect(reconcileProjectExportOutbox({ pool, enqueue, operationId: 41 })).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      failed: 0,
    });
    expect(enqueue).toHaveBeenCalledWith({ operationId: 41, projectId: 7, snapshotHash: "a".repeat(64) });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'queued'"),
      [41, 7],
    );
    expect(pool.query.mock.calls[0][0]).toContain("operation.status = 'rendering'");
    expect(pool.query.mock.calls[0][0]).toContain("interval '30 minutes'");
  });

  it("keeps queue failure retryable without discarding DB ownership", async () => {
    const pool = outboxPool(row);
    const error = Object.assign(new Error("offline"), { code: "queue_unavailable" });
    const enqueue = vi.fn(async () => { throw error; });
    await expect(reconcileProjectExportOutbox({ pool, enqueue })).resolves.toEqual({
      scanned: 1,
      enqueued: 0,
      failed: 1,
    });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = $3"),
      expect.arrayContaining([5, expect.any(String), "retryable_failed"]),
    );
  });

  it("expires durable artifacts and their download tokens transactionally", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("select artifact.id")) {
        return { rowCount: 1, rows: [{ id: 81, operation_id: 41 }] };
      }
      return { rowCount: 1, rows: [] };
    });
    const client = { query, release: vi.fn() };
    const pool = { connect: vi.fn(async () => client) };
    await expect(expireProjectExportArtifacts(pool, 25)).resolves.toEqual({ expiredArtifacts: 1 });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'expired'"),
      [[41]],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("delete from project_export_artifacts"),
      [[81]],
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("delete from project_export_download_tokens"),
      [25],
    );
    expect(query).toHaveBeenCalledWith("commit");
  });
});
