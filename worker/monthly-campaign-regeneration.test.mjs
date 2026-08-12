import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  buildMonthlyRegenerationRevisionItems,
  monthlyCampaignTitleConflicts,
  monthlyCampaignTitleSimilarity,
  monthlyRegenerationJobId,
  processMonthlyCampaignRegeneration,
  reconcileMonthlyCampaignRegenerationOutbox,
  recoverStaleMonthlyCampaignRegenerations,
} from "./monthly-campaign-regeneration.mjs";

function withTimeZone(timeZone, run) {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return run();
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
}

function outboxPool({ failFirstAck = false } = {}) {
  const state = {
    status: "pending",
    leaseToken: null,
    leaseExpired: false,
    redeliveryDue: false,
    ackAttempts: 0,
  };
  const query = vi.fn(async (sqlValue, params = []) => {
    const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
    if (sql.startsWith("select outbox.id")) {
      const eligible = state.status === "pending"
        || state.status === "retryable_failed"
        || (state.status === "dispatching" && state.leaseExpired)
        || (state.status === "enqueued" && state.redeliveryDue);
      return {
        rows: eligible ? [{ id: 5, operation_id: 91, project_id: 11 }] : [],
        rowCount: eligible ? 1 : 0,
      };
    }
    if (sql.startsWith("update monthly_campaign_regeneration_outbox")
        && sql.includes("status = 'dispatching'")) {
      const eligible = state.status === "pending"
        || state.status === "retryable_failed"
        || (state.status === "dispatching" && state.leaseExpired)
        || (state.status === "enqueued" && state.redeliveryDue);
      if (!eligible) return { rows: [], rowCount: 0 };
      state.status = "dispatching";
      state.leaseToken = params[2];
      state.leaseExpired = false;
      state.redeliveryDue = false;
      return { rows: [{ operation_id: 91 }], rowCount: 1 };
    }
    if (sql.startsWith("update monthly_campaign_regeneration_outbox")
        && sql.includes("status = 'enqueued'")) {
      state.ackAttempts += 1;
      if (failFirstAck && state.ackAttempts === 1) return { rows: [], rowCount: 0 };
      state.status = "enqueued";
      state.leaseToken = null;
      return { rows: [], rowCount: 1 };
    }
    throw new Error(`unexpected SQL: ${sql}`);
  });
  return { pool: { query }, state, query };
}

describe("monthly campaign regeneration outbox", () => {
  it("reuses one project-bound job identity after a restart/ambiguous acknowledgement", async () => {
    const { pool, state } = outboxPool({ failFirstAck: true });
    const visibleJobs = new Set();
    const enqueue = vi.fn(async (projectId, operationId) => {
      expect(projectId).toBe(11);
      visibleJobs.add(monthlyRegenerationJobId(operationId));
    });

    const first = await reconcileMonthlyCampaignRegenerationOutbox({ pool, enqueue });
    expect(first).toEqual({ scanned: 1, enqueued: 0, pending: 1 });
    expect(state.status).toBe("dispatching");

    // The process died after enqueue and before the DB acknowledgement. On restart the
    // expired lease is reclaimed and BullMQ receives exactly the same deterministic id.
    state.leaseExpired = true;
    const replay = await reconcileMonthlyCampaignRegenerationOutbox({ pool, enqueue });

    expect(replay).toEqual({ scanned: 1, enqueued: 1, pending: 0 });
    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(visibleJobs).toEqual(new Set(["monthly-campaign-regeneration-91"]));
    expect(state.status).toBe("enqueued");
  });

  it("redelivers an acknowledged operation when Redis loses its job", async () => {
    const { pool, state } = outboxPool();
    const visibleJobs = new Set();
    const enqueue = vi.fn(async (_projectId, operationId) => {
      visibleJobs.add(monthlyRegenerationJobId(operationId));
    });

    await expect(reconcileMonthlyCampaignRegenerationOutbox({ pool, enqueue }))
      .resolves.toEqual({ scanned: 1, enqueued: 1, pending: 0 });
    expect(state.status).toBe("enqueued");

    // PostgreSQL still says the operation is unfinished, while the acknowledged Redis
    // job disappeared during a restart. A stale delivery is safe to send again because
    // BullMQ receives the exact same deterministic job id.
    state.redeliveryDue = true;
    await expect(reconcileMonthlyCampaignRegenerationOutbox({
      pool,
      enqueue,
      redeliverySeconds: 60,
    })).resolves.toEqual({ scanned: 1, enqueued: 1, pending: 0 });

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(visibleJobs).toEqual(new Set(["monthly-campaign-regeneration-91"]));
  });
});

describe("monthly campaign regeneration revisions", () => {
  it("never overwrites an approved item and clears stale lineage only on regenerated targets", () => {
    const items = [
      {
        id: 101,
        item_key: "2026-08-10-1",
        scheduled_for: "2026-08-10",
        position: 0,
        title: "Утверждённый разбор договора",
        rubric: "Разбор",
        practice: "Договоры",
        funnel_stage: "consideration",
        state: "detailed",
        approval_status: "approved",
        content_version: 3,
        approved_content_version: 3,
        weekly_autopilot_plan_id: 44,
        weekly_autopilot_item_index: 0,
        draft_id: 501,
        post_id: 601,
        latest_post_stats_id: 701,
        regeneration_version: 4,
      },
      {
        id: 102,
        item_key: "2026-08-12-2",
        scheduled_for: "2026-08-12",
        position: 1,
        title: "Старый утверждённый анонс",
        rubric: "Новости",
        practice: "События",
        funnel_stage: "awareness",
        state: "topic",
        approval_status: "approved",
        content_version: 2,
        approved_content_version: 2,
        weekly_autopilot_plan_id: 45,
        weekly_autopilot_item_index: 1,
        draft_id: 502,
        post_id: 602,
        latest_post_stats_id: 702,
        regeneration_version: 2,
      },
    ];
    const copied = buildMonthlyRegenerationRevisionItems(items, [{
      itemId: 102,
      title: "Как команда готовит LegalTech-конференцию",
      rubric: "За кулисами",
      practice: "События",
      funnelStage: "awareness",
      state: "detailed",
    }]);

    expect(copied[0]).toMatchObject({
      title: items[0].title,
      approval_status: "approved",
      content_version: 3,
      approved_content_version: 3,
      source_item_id: 101,
      weekly_autopilot_plan_id: 44,
      draft_id: 501,
      post_id: 601,
      latest_post_stats_id: 701,
      regeneration_version: 4,
    });
    expect(copied[1]).toMatchObject({
      title: "Как команда готовит LegalTech-конференцию",
      approval_status: "draft",
      content_version: 3,
      approved_content_version: null,
      source_item_id: 102,
      weekly_autopilot_plan_id: null,
      weekly_autopilot_item_index: null,
      draft_id: null,
      post_id: null,
      latest_post_stats_id: null,
      regeneration_version: 2,
    });
  });

  it("keeps PostgreSQL date-only values on their local calendar day", () => {
    withTimeZone("Europe/Amsterdam", () => {
      const [copied] = buildMonthlyRegenerationRevisionItems([{
        id: 101,
        item_key: "2026-09-01-1",
        scheduled_for: new Date(2026, 8, 1),
        position: 0,
        title: "Исходная тема",
        rubric: "Практика",
        practice: "Договоры",
        funnel_stage: "awareness",
        state: "topic",
        approval_status: "approved",
        content_version: 1,
        approved_content_version: 1,
        weekly_autopilot_plan_id: null,
        weekly_autopilot_item_index: null,
        draft_id: null,
        post_id: null,
        latest_post_stats_id: null,
        regeneration_version: 0,
      }], []);

      expect(copied.scheduled_for).toBe("2026-09-01");
    });
  });

  it("recognizes near-identical topics before a regenerated revision is persisted", () => {
    expect(monthlyCampaignTitleSimilarity(
      "Пять ошибок при заключении договора",
      "5 ошибок при заключении договора",
    )).toBeGreaterThan(0.7);
    expect(monthlyCampaignTitleSimilarity(
      "Пять ошибок при заключении договора",
      "Как команда готовит конференцию",
    )).toBeLessThan(0.3);
    expect(monthlyCampaignTitleConflicts(
      "Пять ошибок при заключении договора",
      ["5 ошибок при заключении договора", "Новость компании"],
    )).toBe(true);
  });

  it("replays a completed operation and rejects a foreign project without calling AI", async () => {
    const operationRow = {
      id: 91,
      project_id: 11,
      campaign_id: 21,
      plan_id: 31,
      status: "completed",
      result_plan_id: 41,
    };
    const sameProject = {
      query: vi.fn(async (sqlValue) => {
        const sql = String(sqlValue);
        if (sql.includes("from monthly_campaign_regeneration_operations operation")) {
          return { rows: [operationRow], rowCount: 1 };
        }
        if (sql.includes("from monthly_campaign_items item")) return { rows: [], rowCount: 0 };
        if (sql.includes("from content_brief")) return { rows: [], rowCount: 0 };
        throw new Error("unexpected query");
      }),
    };
    const generate = vi.fn();

    await expect(processMonthlyCampaignRegeneration({
      pool: sameProject,
      projectId: 11,
      operationId: 91,
      generate,
    })).resolves.toEqual({ state: "completed", replayed: true, planId: 41 });
    expect(generate).not.toHaveBeenCalled();

    const foreignProject = {
      query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    };
    await expect(processMonthlyCampaignRegeneration({
      pool: foreignProject,
      projectId: 12,
      operationId: 91,
      generate,
    })).resolves.toEqual({ state: "missing" });
    expect(foreignProject.query.mock.calls[0][1]).toEqual([91, 12]);
    expect(generate).not.toHaveBeenCalled();
  });

  it("persists one new project revision and finalizes usage in the same transaction", async () => {
    const profileHash = createHash("sha256").update("[]", "utf8").digest("hex");
    let operationStatus = "pending";
    const operation = {
      id: 91,
      project_id: 11,
      campaign_id: 21,
      plan_id: 31,
      requested_by_user_id: 3,
      scope: "item",
      week_starts_on: null,
      base_plan_version: 1,
      base_brief_hash: "a".repeat(64),
      base_profile_hash: profileHash,
      status: operationStatus,
      result_plan_id: null,
      goal: "Доверие к бренду",
      starts_on: "2026-08-01",
      ends_on: "2026-08-31",
      timezone: "Europe/Moscow",
      rubrics: ["Разбор", "Новости"],
      practice_mix: [{ name: "Договоры" }, { name: "События" }],
      audience: "Предприниматели",
      funnel_stages: ["awareness", "consideration"],
      posts_per_week: 2,
      important_dates: [],
      ctas: [],
      metrics: [],
      profile_version: 1,
      content_brief_version: 1,
      profile_hash: profileHash,
      brief_hash: "a".repeat(64),
      campaign_version: 1,
      is_archived: false,
      plan_revision: 1,
      plan_version: 2,
      plan_status: "approved",
      source_campaign_version: 1,
      source_brief_hash: "a".repeat(64),
      source_profile_hash: profileHash,
    };
    const items = [
      {
        id: 101,
        project_id: 11,
        plan_id: 31,
        item_key: "2026-08-10-1",
        scheduled_for: "2026-08-10",
        position: 0,
        title: "Утверждённый разбор договора",
        rubric: "Разбор",
        practice: "Договоры",
        funnel_stage: "consideration",
        state: "detailed",
        approval_status: "approved",
        content_version: 3,
        approved_content_version: 3,
        source_item_id: null,
        weekly_autopilot_plan_id: 44,
        weekly_autopilot_item_index: 0,
        draft_id: 501,
        post_id: 601,
        latest_post_stats_id: 701,
        regeneration_version: 0,
        regeneration_status: "idle",
        target_content_version: null,
        target_regeneration_version: null,
        targeted: false,
      },
      {
        id: 102,
        project_id: 11,
        plan_id: 31,
        item_key: "2026-08-12-2",
        scheduled_for: "2026-08-12",
        position: 1,
        title: "Старый анонс",
        rubric: "Новости",
        practice: "События",
        funnel_stage: "awareness",
        state: "topic",
        approval_status: "approved",
        content_version: 2,
        approved_content_version: 2,
        source_item_id: null,
        weekly_autopilot_plan_id: 45,
        weekly_autopilot_item_index: 1,
        draft_id: 502,
        post_id: 602,
        latest_post_stats_id: 702,
        regeneration_version: 1,
        regeneration_status: "pending",
        target_content_version: 2,
        target_regeneration_version: 1,
        targeted: true,
      },
    ];
    const statements = [];
    const answer = (sqlValue, params = []) => {
      const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
      statements.push({ sql, params });
      if (sql.includes("from monthly_campaign_regeneration_operations operation")) {
        return { rows: [{ ...operation, status: operationStatus }], rowCount: 1 };
      }
      if (sql.includes("from monthly_campaign_items item") && sql.includes("left join")) {
        return { rows: structuredClone(items), rowCount: items.length };
      }
      if (sql.includes("from content_brief")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("select candidate.title")) {
        return { rows: [{ title: "Архивная тема проекта" }], rowCount: 1 };
      }
      if (sql.startsWith("select project.id")) return { rows: [{ id: 11 }], rowCount: 1 };
      if (sql.startsWith("select channel.id")) return { rows: [{ id: 7 }], rowCount: 1 };
      if (sql === "lock table content_brief in share mode") return { rows: [], rowCount: null };
      if (sql.startsWith("select item.id") && sql.includes("join monthly_campaign_regeneration_operations")) {
        return { rows: [{ id: 101 }, { id: 102 }], rowCount: 2 };
      }
      if (sql.startsWith("update monthly_campaign_regeneration_operations")
          && sql.includes("set status = 'processing'")) {
        operationStatus = "processing";
        return { rows: [{ id: 91 }], rowCount: 1 };
      }
      if (sql.startsWith("update monthly_campaign_items item")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("select status, result_plan_id")) {
        return { rows: [{ status: operationStatus, result_plan_id: null }], rowCount: 1 };
      }
      if (sql.startsWith("select coalesce(max(revision)")) {
        return { rows: [{ next_revision: 2 }], rowCount: 1 };
      }
      if (sql.startsWith("insert into monthly_campaign_plans")) {
        return { rows: [{ id: 41 }], rowCount: 1 };
      }
      if (sql.startsWith("insert into monthly_campaign_items")) {
        return { rows: [{ id: 201 }, { id: 202 }], rowCount: 2 };
      }
      if (sql.startsWith("update monthly_campaign_regeneration_operations")) {
        operationStatus = "completed";
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("update monthly_campaign_regeneration_outbox")) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith("insert into audit_events")) return { rows: [], rowCount: 1 };
      if (["begin", "commit", "rollback"].includes(sql)) return { rows: [], rowCount: null };
      throw new Error(`unexpected SQL: ${sql}`);
    };
    const query = vi.fn(async (sql, params) => answer(sql, params));
    const txQuery = vi.fn(async (sql, params) => answer(sql, params));
    const release = vi.fn();
    const tx = { query: txQuery, release };
    const pool = { query, connect: vi.fn(async () => tx) };
    const generate = vi.fn(async () => [{
      itemId: 102,
      title: "Как подготовить гостя к отраслевой конференции",
      rubric: "Новости",
      practice: "События",
      funnelStage: "awareness",
      state: "detailed",
    }]);
    const commitUsage = vi.fn(async (client) => client === tx);

    await expect(processMonthlyCampaignRegeneration({
      pool,
      projectId: 11,
      operationId: 91,
      generate,
      commitUsage,
    })).resolves.toEqual({ state: "completed", replayed: false, planId: 41, revision: 2 });

    expect(generate).toHaveBeenCalledOnce();
    expect(generate).toHaveBeenCalledWith(expect.objectContaining({
      historicalTitles: ["Архивная тема проекта"],
    }));
    expect(commitUsage).toHaveBeenCalledWith(tx);
    expect(statements.some(({ sql }) => sql.includes("for update of campaign, plan"))).toBe(true);
    expect(statements.some(({ sql }) => sql.includes("for update of item"))).toBe(true);
    expect(statements.some(({ sql }) => sql === "lock table content_brief in share mode"))
      .toBe(true);
    expect(statements.some(({ sql }) => sql.startsWith("select project.id") && sql.endsWith("for share")))
      .toBe(true);
    const planLockIndex = statements.findIndex(({ sql }) => sql.includes("for update of campaign, plan"));
    const projectLockIndex = statements.findIndex(({ sql }) => sql.startsWith("select project.id"));
    const briefLockIndex = statements.findIndex(({ sql }) => sql === "lock table content_brief in share mode");
    expect(planLockIndex).toBeLessThan(projectLockIndex);
    expect(projectLockIndex).toBeLessThan(briefLockIndex);
    expect(statements.findIndex(({ sql }) => sql.startsWith("insert into audit_events")))
      .toBeLessThan(statements.findIndex(({ sql }) => sql === "commit"));
    const itemInsert = statements.find(({ sql }) => sql.startsWith("insert into monthly_campaign_items"));
    const revisionItems = JSON.parse(itemInsert.params[2]);
    expect(revisionItems[0]).toMatchObject({
      source_item_id: 101,
      approval_status: "approved",
      post_id: 601,
    });
    expect(revisionItems[1]).toMatchObject({
      source_item_id: 102,
      approval_status: "draft",
      content_version: 3,
      post_id: null,
    });
    expect(operationStatus).toBe("completed");
    expect(release).toHaveBeenCalledOnce();
  });

  it("does not let late failure bookkeeping overwrite a terminal operation", async () => {
    const profileHash = createHash("sha256").update("[]", "utf8").digest("hex");
    const operation = {
      id: 91,
      project_id: 11,
      campaign_id: 21,
      plan_id: 31,
      status: "pending",
      base_plan_version: 1,
      plan_version: 2,
      base_brief_hash: "a".repeat(64),
      brief_hash: "a".repeat(64),
      source_brief_hash: "a".repeat(64),
      base_profile_hash: profileHash,
      profile_hash: profileHash,
      source_profile_hash: profileHash,
      is_archived: false,
    };
    const item = {
      id: 102,
      project_id: 11,
      plan_id: 31,
      content_version: 2,
      target_content_version: 2,
      regeneration_version: 1,
      target_regeneration_version: 1,
      targeted: true,
    };
    const query = vi.fn(async (sqlValue) => {
      const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
      if (sql.includes("from monthly_campaign_regeneration_operations operation")) {
        return { rows: [operation], rowCount: 1 };
      }
      if (sql.includes("from monthly_campaign_items item") && sql.includes("left join")) {
        return { rows: [item], rowCount: 1 };
      }
      if (sql.includes("from content_brief")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("select candidate.title")) return { rows: [], rowCount: 0 };
      if (sql.startsWith("update monthly_campaign_regeneration_operations")) {
        operation.status = "processing";
        return { rows: [{ id: 91 }], rowCount: 1 };
      }
      if (sql.startsWith("update monthly_campaign_items item")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const markQueries = [];
    const markQuery = vi.fn(async (sqlValue) => {
      const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
      markQueries.push(sql);
      if (sql.startsWith("update monthly_campaign_regeneration_operations")) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: null };
    });
    const release = vi.fn();
    const pool = {
      query,
      connect: vi.fn(async () => ({ query: markQuery, release })),
    };
    const generationError = new Error("provider failed after another worker completed");

    await expect(processMonthlyCampaignRegeneration({
      pool,
      projectId: 11,
      operationId: 91,
      generate: async () => { throw generationError; },
    })).rejects.toBe(generationError);

    expect(markQueries).toContain("rollback");
    expect(markQueries.some((sql) => sql.startsWith("update monthly_campaign_items"))).toBe(false);
    expect(markQueries.some((sql) => sql.startsWith("update monthly_campaign_regeneration_outbox")))
      .toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });
});

describe("monthly campaign regeneration recovery", () => {
  it("returns stale processing operations to the durable outbox on worker restart", async () => {
    const statements = [];
    const query = vi.fn(async (sqlValue) => {
      const sql = String(sqlValue).replace(/\s+/gu, " ").trim();
      statements.push(sql);
      if (sql.startsWith("update monthly_campaign_regeneration_operations")) {
        return { rows: [{ id: 91, project_id: 11 }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    });
    const release = vi.fn();
    const pool = { connect: vi.fn(async () => ({ query, release })) };

    await expect(recoverStaleMonthlyCampaignRegenerations({
      pool,
      staleSeconds: 1_800,
    })).resolves.toEqual({ recovered: 1 });

    expect(statements).toContain("commit");
    expect(statements.some((sql) => sql.includes("status = 'retryable_failed'"))).toBe(true);
    expect(statements.some((sql) => sql.includes("regeneration_status = 'failed'"))).toBe(true);
    expect(statements.some((sql) =>
      sql.includes("item.regeneration_version = target.item_regeneration_version"),
    )).toBe(true);
    expect(release).toHaveBeenCalledOnce();
  });
});
