import { describe, expect, it, vi } from "vitest";

import {
  persistAuroraProductEvents,
  productEventRetentionDays,
  pruneExpiredProductEvents,
} from "./product-events";
import type { AuroraProductEventDraft } from "./product-event-contract.mjs";

const baseEvent: AuroraProductEventDraft = {
  eventId: "11111111-1111-4111-8111-111111111111",
  sectionId: "studio",
  featureId: "generation",
  action: "result_received",
  stage: "completed",
  outcome: "success",
  durationMs: 1200,
  errorCode: null,
  requestId: null,
  operationId: "generation:41",
  sessionId: "22222222-2222-4222-8222-222222222222",
  occurredAt: "2026-08-30T10:00:00.000Z",
  safeContext: { device: "desktop", source: "ui" },
  important: false,
};

describe("durable Aurora product events", () => {
  it("stores server-owned tenant identity, deduplicates and aggregates only inserted events", async () => {
    let rawInserts = 0;
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      if (sql.includes("insert into product_events")) {
        rawInserts += 1;
        return rawInserts === 1 ? { rows: [{ id: 91 }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as never;

    const result = await persistAuroraProductEvents({
      pool,
      actorUserId: 7,
      projectId: 31,
      events: [baseEvent, { ...baseEvent, eventId: "33333333-3333-4333-8333-333333333333" }],
      fallbackRequestId: "api-request-1",
      release: {
        release: "aurora-2026.08.30",
        commitSha: "a".repeat(40),
        deployedAt: "2026-08-30T09:00:00.000Z",
      },
    });

    expect(result).toEqual({ accepted: 1, replayed: 1, release: "aurora-2026.08.30" });
    const eventInsert = query.mock.calls.find(([sql]) => String(sql).includes("insert into product_events"));
    expect((eventInsert?.[1] ?? []).slice(0, 4)).toEqual([
      baseEvent.eventId,
      31,
      7,
      "studio",
    ]);
    expect(String(eventInsert?.[0])).toContain("on conflict (project_id, user_id, event_id) do nothing");
    expect(query.mock.calls.filter(([sql]) => String(sql).includes("insert into product_event_daily"))).toHaveLength(1);
    expect(query).toHaveBeenCalledWith("commit");
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back atomically when aggregation fails", async () => {
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void values;
      if (sql.includes("insert into product_events")) return { rows: [{ id: 1 }], rowCount: 1 };
      if (sql.includes("insert into product_event_daily")) throw new Error("private database detail");
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) } as never;
    await expect(persistAuroraProductEvents({
      pool,
      actorUserId: 7,
      projectId: 31,
      events: [baseEvent],
      fallbackRequestId: "api-request-1",
      release: { release: null, commitSha: null, deployedAt: null },
    })).rejects.toThrow("private database detail");
    expect(query).toHaveBeenCalledWith("rollback");
    expect(release).toHaveBeenCalledOnce();
  });

  it("bounds retention and prunes raw rows without touching daily aggregates", async () => {
    expect(productEventRetentionDays({ AURORA_PRODUCT_EVENT_RETENTION_DAYS: "30" })).toBe(30);
    expect(productEventRetentionDays({ AURORA_PRODUCT_EVENT_RETENTION_DAYS: "1000" })).toBe(90);
    const query = vi.fn(async (sql: string, values?: unknown[]) => {
      void sql;
      void values;
      return { rows: [], rowCount: 17 };
    });
    await expect(pruneExpiredProductEvents({ query } as never, 30, 500)).resolves.toBe(17);
    expect(String(query.mock.calls[0][0])).toContain("delete from product_events event");
    expect(String(query.mock.calls[0][0])).not.toContain("product_event_daily");
    expect(query.mock.calls[0][1]).toEqual([30, 500]);
  });
});
