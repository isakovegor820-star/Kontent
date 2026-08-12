import { describe, expect, it, vi } from "vitest";

import { createProjectExportSnapshot, projectExportHash } from "./project-export.mjs";
import { processProjectExportOperation } from "./project-export-operation.mjs";

const snapshot = createProjectExportSnapshot({
  kind: "content_plan",
  exportedAt: "2026-08-11T10:00:00Z",
  project: { id: 7, name: "Право", timezone: "UTC" },
  period: { from: "2026-08-11", to: "2026-08-11" },
  rows: [{ projectId: 7, scheduledAt: "2026-08-11T12:00:00Z", channel: "Telegram", title: "Пост", status: "Запланирован" }],
});

function renderingPool() {
  const hash = projectExportHash(snapshot);
  const operationQuery = vi.fn(async (sql) => {
    if (sql.includes("returning id, project_id")) {
      return { rowCount: 1, rows: [{ id: 41, project_id: 7, format: "csv", snapshot, snapshot_hash: hash }] };
    }
    return { rowCount: 1, rows: [] };
  });
  let artifact = null;
  const clientQuery = vi.fn(async (sql, values = []) => {
    if (sql.includes("select status, snapshot_hash")) {
      return { rowCount: 1, rows: [{ status: "rendering", snapshot_hash: hash }] };
    }
    if (sql.includes("select id, file_name") && sql.includes("from project_export_artifacts")) {
      return { rowCount: artifact ? 1 : 0, rows: artifact ? [artifact] : [] };
    }
    if (sql.includes("insert into project_export_artifacts")) {
      artifact = {
        id: 9,
        file_name: values[2],
        mime_type: values[3],
        byte_size: values[4],
        sha256: values[5],
      };
      return { rowCount: 1, rows: [artifact] };
    }
    return { rowCount: 1, rows: [] };
  });
  return {
    hash,
    query: operationQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release: vi.fn() })),
    clientQuery,
  };
}

describe("project export operation renderer", () => {
  it("persists one hashed artifact and terminalizes its outbox atomically", async () => {
    const pool = renderingPool();
    const result = await processProjectExportOperation({
      pool,
      operationId: 41,
      projectId: 7,
      snapshotHash: pool.hash,
      now: () => new Date("2026-08-11T10:00:00Z"),
    });
    expect(result).toMatchObject({ outcome: "ready", artifactId: 9, sha256: expect.stringMatching(/^[0-9a-f]{64}$/u) });
    expect(pool.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("insert into project_export_artifacts"),
      expect.arrayContaining([41, 7, expect.stringMatching(/\.csv$/u), "text/csv; charset=utf-8"]),
    );
    expect(pool.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'cancelled'"),
      [41, 7],
    );
  });

  it("rejects a job whose immutable snapshot hash does not match", async () => {
    const pool = renderingPool();
    pool.query.mockResolvedValueOnce({
      rowCount: 1,
      rows: [{ id: 41, project_id: 7, format: "csv", snapshot, snapshot_hash: "b".repeat(64) }],
    });
    await expect(processProjectExportOperation({
      pool,
      operationId: 41,
      projectId: 7,
      snapshotHash: "b".repeat(64),
      finalAttempt: true,
    })).rejects.toMatchObject({ code: "export_snapshot_corrupt", retryable: false });
    expect(pool.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = $4"),
      expect.arrayContaining([41, 7, "b".repeat(64), "failed", "export_snapshot_corrupt"]),
    );
  });

  it("does not claim or re-render an operation already being rendered", async () => {
    const hash = projectExportHash(snapshot);
    const query = vi.fn(async (sql) => {
      if (sql.includes("update project_export_operations")) {
        expect(sql).toContain("status in ('pending','queued','retryable_failed')");
        expect(sql).not.toContain("'rendering','retryable_failed'");
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("select status, snapshot_hash")) {
        return { rowCount: 1, rows: [{ status: "rendering", snapshot_hash: hash }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    });
    const connect = vi.fn();
    await expect(processProjectExportOperation({
      pool: { query, connect },
      operationId: 41,
      projectId: 7,
      snapshotHash: hash,
    })).resolves.toEqual({ outcome: "terminal", status: "rendering" });
    expect(connect).not.toHaveBeenCalled();
  });
});
