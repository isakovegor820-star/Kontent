import { describe, expect, it, vi } from "vitest";
import {
  duePublicationRevision,
  publicationGraceMs,
  quarantineOverduePublications,
} from "./publication-safety.mjs";

function fixturePool(rows) {
  const state = rows.map((row) => ({ ...row }));
  const connect = vi.fn(async () => ({
    release: vi.fn(),
    query: vi.fn(async (sqlValue, params = []) => {
      const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
      if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
      if (sql.startsWith("select p.id")) {
        const cutoff = new Date(params[0]).getTime();
        return {
          rows: state
            .filter((row) => row.status === "scheduled" && new Date(row.scheduled_at).getTime() < cutoff)
            .slice(0, Number(params[1])),
        };
      }
      if (sql.startsWith("update posts")) {
        const ids = new Set(params[0].map(Number));
        const updated = state.filter((row) => ids.has(row.id) && row.status === "scheduled");
        for (const row of updated) {
          row.status = "quarantined";
          row.quarantine_reason = "overdue_requires_new_schedule";
        }
        return { rows: updated.map(({ id }) => ({ id })), rowCount: updated.length };
      }
      throw new Error(`unexpected transaction SQL: ${sql}`);
    }),
  }));
  const query = vi.fn(async (sqlValue, params = []) => {
    const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
    if (sql.startsWith("select count(*)")) {
      const cutoff = new Date(params[0]).getTime();
      const count = state.filter(
        (row) => row.status === "scheduled" && new Date(row.scheduled_at).getTime() < cutoff,
      ).length;
      return { rows: [{ count }] };
    }
    throw new Error(`unexpected pool SQL: ${sql}`);
  });
  return { pool: { connect, query }, state };
}

describe("overdue publication safety", () => {
  it("quarantines every overdue origin but leaves future and retry-clock rows alone", async () => {
    const { pool, state } = fixturePool([
      { id: 1, channel_id: 10, publication_origin: "manual", status: "scheduled", scheduled_at: "2026-08-02T10:00:00Z" },
      { id: 2, channel_id: 10, publication_origin: "autopilot", status: "scheduled", scheduled_at: "2026-08-02T09:00:00Z" },
      { id: 3, channel_id: 20, publication_origin: "rss", status: "scheduled", scheduled_at: "2026-08-02T13:00:00Z" },
      { id: 4, channel_id: 10, publication_origin: "retry", status: "failed_retry", scheduled_at: "2026-08-02T09:00:00Z" },
    ]);
    const dryRun = vi.fn();
    const result = await quarantineOverduePublications(pool, {
      nowMs: Date.parse("2026-08-02T12:00:00Z"),
      graceMs: 5 * 60_000,
      onDryRun: dryRun,
    });
    expect(result).toMatchObject({ quarantined: 2, remaining: 0 });
    expect(state.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 1, status: "quarantined" },
      { id: 2, status: "quarantined" },
      { id: 3, status: "scheduled" },
      { id: 4, status: "failed_retry" },
    ]);
    expect(dryRun).toHaveBeenCalledWith(expect.objectContaining({ total: 2 }));
  });

  it("fails bootstrap if the bounded quarantine cannot clear all overdue rows", async () => {
    const { pool } = fixturePool([
      { id: 1, channel_id: 10, publication_origin: "legacy", status: "scheduled", scheduled_at: "2026-08-01T10:00:00Z" },
      { id: 2, channel_id: 10, publication_origin: "legacy", status: "scheduled", scheduled_at: "2026-08-01T10:00:00Z" },
    ]);
    await expect(quarantineOverduePublications(pool, {
      nowMs: Date.parse("2026-08-02T12:00:00Z"),
      graceMs: 5 * 60_000,
      batchSize: 1,
      maxBatches: 1,
    })).rejects.toMatchObject({ code: "OVERDUE_QUARANTINE_LIMIT", remaining: 1 });
  });

  it("rejects invalid job revisions and bounds the configured grace period", () => {
    expect(duePublicationRevision({ scheduleRevision: 3 })).toBe(3);
    expect(duePublicationRevision({ scheduleRevision: 0 })).toBeNull();
    expect(publicationGraceMs({ PUBLICATION_OVERDUE_GRACE_MS: "1" })).toBe(60_000);
  });
});

