import { describe, expect, it, vi } from "vitest";

import {
  AUTOPILOT_CONTINUATION_JOB,
  autopilotAutoRecoveryReport,
  enqueueWeeklyAutopilotPlan,
  reconcileBuildingAutopilotPlans,
  resumeAutopilotPartialPlan,
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
      if (normalized.startsWith("select id, project_id, user_id")) return { rows: plans, rowCount: plans.length };
      if (normalized.startsWith("insert into autopilot_plan")) return { rows: [{ id: "701" }], rowCount: 1 };
      throw new Error(`unexpected tx query: ${normalized}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    connect: vi.fn(async () => tx),
    query: vi.fn(async (sql, params = []) => {
      const normalized = String(sql).replace(/\s+/gu, " ").trim();
      if (normalized.startsWith("update autopilot_plan") && normalized.includes("returning id, project_id")) {
        const source = plans.find((plan) => Number(plan.id) === Number(params[0]));
        if (!source) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            ...source,
            project_id: source.project_id ?? "4",
            user_id: source.user_id ?? "9",
            channel_id: source.channel_id ?? "12",
            build_report: JSON.parse(String(params[3])),
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 1 };
    }),
  };
  const queue = {
    add: queueRejects
      ? vi.fn(async () => { throw new Error("redis unavailable"); })
      : vi.fn(async () => ({ id: "autopilot-plan-701" })),
  };
  return { tx, pool, queue };
}

describe("weekly Autopilot queue dispatch", () => {
  it("persists a delayed recovery token without changing the quality diagnosis", () => {
    const report = autopilotAutoRecoveryReport(
      { passed: 4, failed: 6, primaryFix: "rewrite" },
      {
        recoveryJobId: "113229a4-6c97-4ad0-90c9-0dc8d5c598a3",
        attemptNumber: 2,
        nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
      },
    );

    expect(report).toMatchObject({
      passed: 4,
      failed: 6,
      primaryFix: "rewrite",
      recoveryState: "auto_retry_scheduled",
      attemptNumber: 2,
      nextRetryAt: "2026-08-27T07:01:00.000Z",
      autoRecovery: {
        jobId: "113229a4-6c97-4ad0-90c9-0dc8d5c598a3",
        nextRetryAt: "2026-08-27T07:01:00.000Z",
      },
    });
  });

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

  it("retires a build that exhausted its attempts so the replay is not deduplicated away", async () => {
    // Production wedged exactly here: BullMQ ignores `add` for an id it already holds, so a
    // terminally failed job made every later replay a silent no-op and the plan stayed
    // `building` for eight days while each reconciliation reported success.
    const remove = vi.fn(async () => {});
    const { pool, queue } = harness({
      plans: [{
        id: "44",
        status: "building",
        items: [],
        publication_target_count: 5,
        candidate_count: 7,
      }],
    });
    queue.getJob = vi.fn(async () => ({
      isFailed: async () => true,
      isCompleted: async () => false,
      remove,
    }));

    await enqueueWeeklyAutopilotPlan({ pool, queue, projectId: 4, userId: 9, channelId: 12 });

    expect(queue.getJob).toHaveBeenCalledWith("autopilot-plan-44");
    expect(remove).toHaveBeenCalledOnce();
    expect(queue.add).toHaveBeenCalledWith(
      "autopilot-plan",
      { projectId: 4, userId: 9, channelId: 12, planId: 44 },
      expect.objectContaining({ jobId: "autopilot-plan-44" }),
    );
  });

  it("leaves a build that is still queued to the job that already owns it", async () => {
    const remove = vi.fn(async () => {});
    const { pool, queue } = harness({
      plans: [{
        id: "44",
        status: "building",
        items: [],
        publication_target_count: 5,
        candidate_count: 7,
      }],
    });
    queue.getJob = vi.fn(async () => ({
      isFailed: async () => false,
      isCompleted: async () => false,
      remove,
    }));

    await enqueueWeeklyAutopilotPlan({ pool, queue, projectId: 4, userId: 9, channelId: 12 });

    expect(remove).not.toHaveBeenCalled();
  });

  it("resumes the newest partial plan instead of creating a replacement", async () => {
    const items = Array.from({ length: 10 }, (_, i) => ({
      i,
      topic: `Тема ${i + 1}`,
      draft: i < 4 ? `Готовый текст ${i + 1}` : "",
      aiReady: i < 4,
      scheduledAt: `2026-08-${String(28 + Math.floor(i / 2)).padStart(2, "0")}T16:00:00.000Z`,
    }));
    const { tx, pool, queue } = harness({
      plans: [{
        id: "46",
        project_id: "4",
        user_id: "9",
        channel_id: "12",
        status: "partial",
        items,
        build_report: { passed: 4, primaryFix: "rewrite" },
        repair_strategy: "rewrite",
        repair_attempt: 0,
        publication_target_count: 7,
        candidate_count: 10,
      }],
    });

    const result = await enqueueWeeklyAutopilotPlan({
      pool,
      queue,
      projectId: 4,
      userId: 9,
      channelId: 12,
      nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
    });

    expect(result).toMatchObject({
      status: "queued",
      planId: 46,
      publicationTargetCount: 7,
      candidateCount: 10,
      recovered: true,
    });
    expect(queue.add).toHaveBeenCalledWith(
      AUTOPILOT_CONTINUATION_JOB,
      expect.objectContaining({ projectId: 4, userId: 9, channelId: 12, planId: 46 }),
      expect.objectContaining({ jobId: expect.stringContaining("autopilot-continue-46-") }),
    );
    expect(tx.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into autopilot_plan"))).toBe(false);
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("set build_report"))).toBe(true);
  });

  it("lets another permitted actor re-enable the original owner's partial plan", async () => {
    const row = {
      id: "47",
      project_id: "4",
      user_id: "9",
      channel_id: "12",
      status: "partial",
      build_report: { passed: 4, primaryFix: "rewrite" },
      repair_strategy: "rewrite",
      repair_attempt: 1,
      enabled: true,
    };
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [{
            ...row,
            build_report: autopilotAutoRecoveryReport(row.build_report, {
              recoveryJobId: "223229a4-6c97-4ad0-90c9-0dc8d5c598a3",
              attemptNumber: 2,
              nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
            }),
          }],
          rowCount: 1,
        }),
    };
    const queue = { add: vi.fn(async () => ({})) };

    await expect(resumeAutopilotPartialPlan({
      pool,
      queue,
      projectId: 4,
      userId: 15,
      channelId: 12,
      nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
    })).resolves.toMatchObject({ status: "queued", planId: 47, delay: 0 });
    expect(pool.query.mock.calls[0][0]).not.toContain("plan.user_id = $2");
    expect(queue.add.mock.calls[0][1]).toMatchObject({ userId: 9, planId: 47 });
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
    expect(pool.query).toHaveBeenCalledWith(expect.stringContaining("plan.status = 'building'"), [50]);
    expect(queue.add).toHaveBeenNthCalledWith(
      2,
      "autopilot-plan",
      { projectId: 4, userId: 9, channelId: 13, planId: 702 },
      expect.objectContaining({ jobId: "autopilot-plan-702" }),
    );
  });

  it("reconciles a recoverable partial plan as a continuation", async () => {
    const recoveryJobId = "333229a4-6c97-4ad0-90c9-0dc8d5c598a3";
    const row = {
      id: "703",
      project_id: "4",
      user_id: "9",
      channel_id: "12",
      status: "partial",
      enabled: true,
      repair_strategy: "rewrite",
      build_report: autopilotAutoRecoveryReport({ primaryFix: "rewrite" }, {
        recoveryJobId,
        nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
      }),
    };
    const pool = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) };
    const queue = { add: vi.fn(async () => ({})) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue })).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      pending: 0,
    });
    expect(queue.add).toHaveBeenCalledWith(
      AUTOPILOT_CONTINUATION_JOB,
      { projectId: 4, userId: 9, channelId: 12, planId: 703, recoveryJobId },
      expect.objectContaining({ jobId: `autopilot-continue-703-${recoveryJobId}` }),
    );
  });

  it("continues a manually requested build even while recurring Autopilot is paused", async () => {
    const recoveryJobId = "433229a4-6c97-4ad0-90c9-0dc8d5c598a3";
    const row = {
      id: "704",
      project_id: "4",
      user_id: "9",
      channel_id: "12",
      status: "partial",
      enabled: false,
      repair_strategy: "rewrite",
      build_report: autopilotAutoRecoveryReport(
        { primaryFix: "rewrite", requestedBy: "human" },
        {
          recoveryJobId,
          nowMs: Date.parse("2026-08-27T07:00:00.000Z"),
        },
      ),
    };
    const pool = { query: vi.fn(async () => ({ rows: [row], rowCount: 1 })) };
    const queue = { add: vi.fn(async () => ({})) };

    await expect(reconcileBuildingAutopilotPlans({ pool, queue })).resolves.toEqual({
      scanned: 1,
      enqueued: 1,
      pending: 0,
    });
    expect(queue.add).toHaveBeenCalledWith(
      AUTOPILOT_CONTINUATION_JOB,
      { projectId: 4, userId: 9, channelId: 12, planId: 704, recoveryJobId },
      expect.objectContaining({ jobId: `autopilot-continue-704-${recoveryJobId}` }),
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
