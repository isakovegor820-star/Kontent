import { describe, expect, it, vi } from "vitest";

import { reconcileStaleMediaGeneration } from "./media-generation-reconciliation";

describe("stale media reconciliation", () => {
  it("terminalizes a missing terminal event and releases its reservation atomically", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("returning id, ai_usage_reservation_id")) {
        return { rows: [{ id: "41", ai_usage_reservation_id: "91" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(reconcileStaleMediaGeneration(pool as never, {
      userId: 7,
      generationId: 41,
    })).resolves.toEqual({ reconciled: [41], released: [91] });

    expect(query.mock.calls.map(([sql]) => sql)).toEqual(expect.arrayContaining([
      "begin",
      expect.stringContaining("status in ('queued','submitting','generating','saving')"),
      expect.stringContaining("status = 'released'"),
      "commit",
    ]));
    expect(release).toHaveBeenCalledOnce();
  });

  it("leaves a fresh active generation and its reserved usage unchanged", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("returning id, ai_usage_reservation_id")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(reconcileStaleMediaGeneration(pool as never, {
      userId: 7,
      requestKey: "media-fresh-0001",
    })).resolves.toEqual({ reconciled: [], released: [] });

    expect(query.mock.calls.some(([sql]) => String(sql).includes("update ai_usage"))).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and never broad-matches without an identity", async () => {
    await expect(reconcileStaleMediaGeneration({ connect: vi.fn() } as never, { userId: 7 }))
      .rejects.toBeInstanceOf(TypeError);
  });
});
