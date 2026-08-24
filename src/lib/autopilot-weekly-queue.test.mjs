import { describe, expect, it, vi } from "vitest";

import {
  enqueueWeeklyAutopilotPlan,
  reconcileBuildingAutopilotPlans,
} from "./autopilot-weekly-queue.mjs";

function harness({ plans = [], queueRejects = false } = {}) {
  const tx = {
    query: vi.fn(async (sql) => {
      const normalized = String(sql).replace(/\s+/gu, " ").trim();
      if (["begin", "commit", "rollback"].includes(normalized)) return { rows: [], rowCount: 0 };
      if (normalized.startsWith("select settings.user_id")) {
        return {
          rows: [{
            user_id: "9",
            post_frequency: 5,
            generation_engine: "navy-deepseek-flash",
            planning_months: 1,
            planning_weeks: 1,
            quick_settings: { newsPerWeek: 3, detail: 2, energy: 2, emoji: 1 },
          }],
          rowCount: 1,
        };
      }
      if (normalized.startsWith("select id, status, items")) return { rows: plans, rowCount: plans.length };
      if (normalized.startsWith("insert into autopilot_plan")) return { rows: [{ id: "701" }], rowCount: 1 };
      throw new Error(`unexpected tx query: ${normalized}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => tx),
    query: vi.fn(async () => ({ rows: [], rowCount: 1 })),
  };
  const queue = {
    add: queueRejects
      ? vi.fn(async () => { throw new Error("redis unavailable"); })
      : vi.fn(async () => ({ id: "autopilot-plan-701" })),
  };
  return { tx, pool, queue };
}

describe("weekly Autopilot queue dispatch", () => {
  it("creates a durable placeholder and uses the dedicated retrying queue", async () => {
    const { tx, pool, queue } = harness();

    const result = await enqueueWeeklyAutopilotPlan({
      pool,
      queue,
      projectId: 4,
      userId: 9,
      channelId: 12,
      nowMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "queued",
      planId: 701,
      publicationTargetCount: 5,
    });
    expect(queue.add).toHaveBeenCalledWith(
      "autopilot-plan",
      { projectId: 4, userId: 9, channelId: 12, planId: 701 },
      expect.objectContaining({
        jobId: "autopilot-plan-701",
        attempts: 6,
        backoff: { type: "fixed", delay: 20_000 },
      }),
    );
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("status, generation_engine"))).toBe(true);
    expect(tx.query).toHaveBeenCalledWith("commit");
    expect(tx.release).toHaveBeenCalledOnce();
  });

  it("replays the deterministic job when a durable build already exists", async () => {
    const { pool, queue } = harness({
      plans: [{
        id: "44",
        status: "building",
        items: [],
        publication_target_count: 5,
        candidate_count: 7,
      }],
    });

    const result = await enqueueWeeklyAutopilotPlan({
      pool,
      queue,
      projectId: 4,
      userId: 9,
      channelId: 12,
    });

    expect(result).toEqual({
      status: "queued",
      planId: 44,
      publicationTargetCount: 5,
      candidateCount: 7,
      recovered: true,
    });
    expect(queue.add).toHaveBeenCalledWith(
      "autopilot-plan",
      { projectId: 4, userId: 9, channelId: 12, planId: 44 },
      expect.objectContaining({ jobId: "autopilot-plan-44" }),
    );
  });

  it("keeps sufficient future coverage instead of replacing an active plan", async () => {
    const { pool, queue } = harness({
      plans: [{
        id: "45",
        status: "pending",
        items: [{ scheduledAt: "2026-09-15T16:00:00.000Z" }],
      }],
    });

    const result = await enqueueWeeklyAutopilotPlan({
      pool,
      queue,
      projectId: 4,
      userId: 9,
      channelId: 12,
      nowMs: Date.parse("2026-08-24T12:00:00.000Z"),
    });

    expect(result).toEqual({ status: "skipped", reason: "coverage_sufficient" });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("keeps a durable build pending when Redis cannot confirm enqueue", async () => {
    const { pool, queue } = harness({ queueRejects: true });

    const result = await enqueueWeeklyAutopilotPlan({
      pool,
      queue,
      projectId: 4,
      userId: 9,
      channelId: 12,
    });

    expect(result).toEqual({ status: "pending_reconciliation", reason: "queue_unavailable", planId: 701 });
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("reconciles committed building rows with deterministic queue identities", async () => {
    const rows = [
      { id: "701", project_id: "4", user_id: "9", channel_id: "12" },
      { id: "702", project_id: "4", user_id: "9", channel_id: "13" },
    ];
    const pool = { query: vi.fn(async () => ({ rows, rowCount: rows.length })) };
    const queue = { add: vi.fn(async () => ({})) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue, limit: 50 })).resolves.toEqual({
      scanned: 2,
      enqueued: 2,
      pending: 0,
    });
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("where plan.status = 'building'"), [50]);
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "autopilot-plan",
      { projectId: 4, userId: 9, channelId: 13, planId: 702 },
      expect.objectContaining({ jobId: "autopilot-plan-702" }),
    );
  });

  it("leaves a failed reconciliation row pending for the next tick", async () => {
    const pool = {
      query: vi.fn(async () => ({
        rows: [{ id: "701", project_id: "4", user_id: "9", channel_id: "12" }],
        rowCount: 1,
      })),
    };
    const queue = { add: vi.fn(async () => { throw new Error("redis unavailable"); }) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue })).resolves.toEqual({
      scanned: 1,
      enqueued: 0,
      pending: 1,
    });
  });
});
