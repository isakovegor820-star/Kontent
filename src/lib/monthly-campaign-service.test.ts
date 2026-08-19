import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const permission = vi.hoisted(() => ({ projectId: 7, denied: false }));

vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return {
    ...actual,
    requireSelectedProjectPermission: vi.fn(async (_db, userId: number, requested: string) => {
      if (permission.denied) throw new actual.ProjectAccessError("permission_denied");
      return { projectId: permission.projectId, userId, role: "owner", version: 1, requested };
    }),
  };
});

import { ProjectAccessError } from "./project-permissions";
import {
  assertNoDuplicateCampaignTopics,
  listMonthlyCampaigns,
  moveMonthlyCampaignItem,
  normalizeMonthlyCampaignBrief,
  normalizeMonthlyCampaignItems,
  ensureMonthlyCampaignItemDraft,
  requestMonthlyCampaignRegeneration,
  transitionMonthlyCampaignPlan,
  updateMonthlyCampaign,
  type MonthlyCampaignSummary,
} from "./monthly-campaign-service";

type QueryResult = { rows: Record<string, unknown>[]; rowCount?: number };

async function withTimeZone<T>(timeZone: string, run: () => T | Promise<T>): Promise<T> {
  const previousTimeZone = process.env.TZ;
  process.env.TZ = timeZone;
  try {
    return await run();
  } finally {
    if (previousTimeZone === undefined) delete process.env.TZ;
    else process.env.TZ = previousTimeZone;
  }
}

function transactionHarness(handler: (sql: string, params: unknown[]) => QueryResult | Promise<QueryResult>) {
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    if (sql === "begin" || sql === "commit" || sql === "rollback") return { rows: [] };
    return handler(sql, params);
  });
  const client = { query, release: vi.fn() };
  return { pool: { connect: vi.fn(async () => client), query }, query };
}

const EMPTY_PROFILE_HASH = createHash("sha256").update("[]").digest("hex");

const brief = {
  goal: "Получить подтверждённые обращения по сопровождению бизнеса",
  startsOn: "2026-09-01",
  endsOn: "2026-09-30",
  timezone: "Europe/Moscow",
  rubrics: ["Практика", "Изменения", "Ошибки бизнеса"],
  practiceMix: [
    { name: "Корпоративное право", kind: "practice", weight: 60 },
    { name: "Судебное представительство", kind: "service", weight: 40 },
  ],
  audience: "Собственники малого и среднего бизнеса",
  funnelStages: ["awareness", "consideration", "consultation"],
  postsPerWeek: 5,
  importantDates: [{ date: "2026-09-15", label: "Срок отчётности" }],
  ctas: ["Записаться на консультацию"],
  metrics: ["Подтверждённые заявки"],
  profileVersion: 3,
  contentBriefVersion: 8,
};

function campaignRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 41,
    project_id: 7,
    goal: brief.goal,
    starts_on: brief.startsOn,
    ends_on: brief.endsOn,
    timezone: brief.timezone,
    rubrics: brief.rubrics,
    practice_mix: brief.practiceMix,
    audience: brief.audience,
    funnel_stages: brief.funnelStages,
    posts_per_week: brief.postsPerWeek,
    important_dates: brief.importantDates,
    ctas: brief.ctas,
    metrics: brief.metrics,
    profile_version: 3,
    content_brief_version: 8,
    profile_hash: EMPTY_PROFILE_HASH,
    brief_hash: createHash("sha256").update(JSON.stringify(normalizeMonthlyCampaignBrief(brief))).digest("hex"),
    version: 1,
    is_archived: false,
    created_at: "2026-08-14T10:00:00.000Z",
    updated_at: "2026-08-14T10:00:00.000Z",
    ...overrides,
  };
}

function planRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const campaign = campaignRow();
  return {
    id: 52,
    project_id: 7,
    campaign_id: 41,
    revision: 1,
    status: "draft",
    source_campaign_version: 1,
    source_brief_hash: campaign.brief_hash,
    source_profile_hash: EMPTY_PROFILE_HASH,
    source_profile_version: 3,
    source_content_brief_version: 8,
    version: 4,
    submitted_at: null,
    approved_at: null,
    created_at: "2026-08-14T10:05:00.000Z",
    updated_at: "2026-08-14T10:05:00.000Z",
    ...overrides,
  };
}

function itemRow(id: number, day: number, position = day - 1, overrides: Record<string, unknown> = {}) {
  return {
    id,
    project_id: 7,
    plan_id: 52,
    item_key: `topic-${day}`,
    scheduled_for: `2026-09-${String(day).padStart(2, "0")}`,
    position,
    title: `Тема ${day}`,
    rubric: "Практика",
    practice: "Корпоративное право",
    funnel_stage: "awareness",
    state: "topic",
    approval_status: "approved",
    content_version: 1,
    approved_content_version: 1,
    source_item_id: null,
    weekly_autopilot_plan_id: null,
    weekly_autopilot_item_index: null,
    draft_id: null,
    post_id: null,
    latest_post_stats_id: null,
    regeneration_version: 0,
    regeneration_status: "idle",
    created_at: "2026-08-14T10:06:00.000Z",
    updated_at: "2026-08-14T10:06:00.000Z",
    ...overrides,
  };
}

function planItems(): Record<string, unknown>[] {
  return Array.from({ length: 30 }, (_, index) => ({
    itemKey: `topic-${index + 1}`,
    scheduledFor: `2026-09-${String(index + 1).padStart(2, "0")}`,
    position: index,
    title: `Тема ${index + 1}`,
    rubric: brief.rubrics[index % brief.rubrics.length],
    practice: brief.practiceMix[index % brief.practiceMix.length].name,
    funnelStage: brief.funnelStages[index % brief.funnelStages.length],
    state: index < 7 ? "detailed" : "topic",
  }));
}

describe("monthly campaign parsing", () => {
  it("accepts a project month, 3–6 rubrics, weighted practice/service mix and valid frequency", () => {
    const result = normalizeMonthlyCampaignBrief(brief);
    expect(result).toMatchObject({ startsOn: "2026-09-01", endsOn: "2026-09-30", postsPerWeek: 5 });
    expect(result.practiceMix.reduce((sum, item) => sum + item.weight, 0)).toBe(100);
    expect(normalizeMonthlyCampaignItems(planItems(), {
      ...result,
      profileHash: "",
      briefHash: "",
      id: 1,
      projectId: 7,
      version: 1,
      archived: false,
      createdAt: "",
      updatedAt: "",
    } as MonthlyCampaignSummary)).toHaveLength(30);
  });

  it("keeps PostgreSQL date-only values on the same calendar day outside UTC", async () => {
    await withTimeZone("Europe/Amsterdam", async () => {
      permission.projectId = 7;
      const localDate = new Date(2026, 8, 1);
      const query = vi.fn(async () => ({ rows: [campaignRow({
        starts_on: localDate,
        ends_on: new Date(2026, 8, 30),
      })] }));
      const [result] = await listMonthlyCampaigns({
        pool: { query } as never,
        actorUserId: 11,
      });
      expect(result).toMatchObject({ startsOn: "2026-09-01", endsOn: "2026-09-30" });
    });
  });

  it.each([
    ["two rubrics", { rubrics: ["Практика", "Ошибки"] }, "invalid_rubrics"],
    ["seven rubrics", { rubrics: ["1", "2", "3", "4", "5", "6", "7"] }, "invalid_rubrics"],
    ["invalid timezone", { timezone: "Mars/Moscow" }, "invalid_timezone"],
    ["short range", { endsOn: "2026-09-27" }, "invalid_period"],
    ["invalid frequency", { postsPerWeek: 0 }, "invalid_frequency"],
    ["unbalanced mix", { practiceMix: [{ name: "Суды", kind: "practice", weight: 90 }] }, "invalid_practice_mix"],
  ])("rejects %s", (_label, patch, code) => {
    expect(() => normalizeMonthlyCampaignBrief({ ...brief, ...patch })).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects detailed material outside the nearest week", () => {
    const items = planItems();
    items[20] = { ...items[20], state: "detailed" };
    const normalized = normalizeMonthlyCampaignBrief(brief);
    expect(() => normalizeMonthlyCampaignItems(items, normalized as never)).toThrowError(
      expect.objectContaining({ code: "invalid_items" }),
    );
  });

  it("rejects repeated topics inside the month and against the project library", () => {
    expect(() => assertNoDuplicateCampaignTopics([
      { itemKey: "a", title: "Пять ошибок директора при банкротстве" },
      { itemKey: "b", title: "5 ошибок директора в банкротстве" },
    ], [], 0.72)).toThrowError(expect.objectContaining({ code: "duplicate_topics" }));
    expect(() => assertNoDuplicateCampaignTopics([
      { itemKey: "a", title: "Как проверить договор поставки" },
    ], [{ id: "library:3", title: "Как проверить договор поставки" }]))
      .toThrowError(expect.objectContaining({ code: "duplicate_topics" }));
  });
});

describe("monthly campaign project service", () => {
  it("keeps list reads inside the server-selected project", async () => {
    permission.projectId = 7;
    const query = vi.fn(async (sql: string, params: unknown[]) => {
      expect(sql).toContain("where project_id = $1");
      expect(params).toEqual([7]);
      return { rows: [campaignRow()] };
    });
    const result = await listMonthlyCampaigns({ pool: { query } as never, actorUserId: 11 });
    expect(result).toHaveLength(1);
    expect(result[0].projectId).toBe(7);
    expect(JSON.stringify(query.mock.calls)).not.toContain("project_id = 999");
  });

  it("denies a publisher/foreign role before any campaign write", async () => {
    permission.denied = true;
    const h = transactionHarness(() => ({ rows: [] }));
    await expect(updateMonthlyCampaign({
      pool: h.pool as never,
      actorUserId: 12,
      campaignId: 41,
      expectedVersion: 1,
      brief,
    })).rejects.toBeInstanceOf(ProjectAccessError);
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("update monthly_campaigns"))).toBe(false);
    permission.denied = false;
  });

  it("serializes optimistic updates so a stale tab loses the race", async () => {
    let row = campaignRow();
    const h = transactionHarness((sql, params) => {
      if (sql.startsWith("select timezone from projects")) return { rows: [{ timezone: brief.timezone }] };
      if (sql.includes("from monthly_campaigns") && sql.includes("for update")) return { rows: [row] };
      if (sql.includes("from content_brief")) return { rows: [] };
      if (sql.startsWith("update monthly_campaigns")) {
        if (Number(row.version) !== Number(params[19])) return { rows: [] };
        row = { ...row, version: Number(row.version) + 1, updated_at: "2026-08-14T11:00:00.000Z" };
        return { rows: [row] };
      }
      if (sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(updateMonthlyCampaign({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, expectedVersion: 1, brief,
    })).resolves.toMatchObject({ version: 2 });
    await expect(updateMonthlyCampaign({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, expectedVersion: 1, brief,
    })).rejects.toMatchObject({ code: "version_conflict" });
  });

  it("blocks submit when the server-owned profile hash changed", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) {
        return { rows: [planRow({ source_profile_hash: "f".repeat(64) })] };
      }
      if (sql.includes("from monthly_campaign_regeneration_operations")) return { rows: [] };
      if (sql.includes("from content_brief")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(transitionMonthlyCampaignPlan({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52,
      expectedPlanVersion: 4, action: "submit",
    })).rejects.toMatchObject({ code: "stale_campaign" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update monthly_campaign_plans"))).toBe(false);
  });

  it("blocks plan submission while its regenerated revision is still in progress", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_regeneration_operations")) return { rows: [{ id: 91 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(transitionMonthlyCampaignPlan({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52,
      expectedPlanVersion: 4, action: "submit",
    })).rejects.toMatchObject({ code: "regeneration_in_progress" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("update monthly_campaign_plans"))).toBe(false);
  });

  it("moves one approved item by swapping date/order without changing approved content", async () => {
    let rows = [itemRow(61, 1), itemRow(62, 2), itemRow(63, 3)];
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow({ status: "approved" })] };
      if (sql.includes("from monthly_campaign_regeneration_operations")) return { rows: [] };
      if (sql.includes("from monthly_campaign_items") && sql.includes("for update")) return { rows };
      if (sql.startsWith("set constraints")) return { rows: [] };
      if (sql.startsWith("update monthly_campaign_items")) {
        rows = [rows[0], { ...rows[1], scheduled_for: "2026-09-03", position: 2 },
          { ...rows[2], scheduled_for: "2026-09-02", position: 1 }];
        return { rows: [] };
      }
      if (sql.startsWith("update monthly_campaign_plans")) return { rows: [{ version: 5 }] };
      if (sql.startsWith("insert into audit_events")) return { rows: [] };
      if (sql.includes("from monthly_campaign_items")) return { rows };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await moveMonthlyCampaignItem({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52, itemId: 62,
      targetDate: "2026-09-03", targetPosition: 2, expectedPlanVersion: 4,
    });
    expect(result.planVersion).toBe(5);
    expect(result.items.map((item) => item.scheduledFor)).toEqual([
      "2026-09-01", "2026-09-03", "2026-09-02",
    ]);
    expect(result.items.every((item) => item.approvalStatus === "approved")).toBe(true);
    const moveSql = String(h.query.mock.calls.find(([sql]) => String(sql).startsWith("update monthly_campaign_items"))?.[0]);
    expect(moveSql).not.toMatch(/title\s*=|approval_status\s*=|content_version\s*=/u);
  });

  it("blocks item moves while the plan is being regenerated", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_regeneration_operations")) return { rows: [{ id: 91 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(moveMonthlyCampaignItem({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52, itemId: 62,
      targetDate: "2026-09-03", targetPosition: 2, expectedPlanVersion: 4,
    })).rejects.toMatchObject({ code: "regeneration_in_progress" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).includes("from monthly_campaign_items"))).toBe(false);
  });

  it("marks only the selected item pending and creates a durable outbox request", async () => {
    const target = itemRow(62, 2);
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.startsWith("select id, request_hash, status")) return { rows: [] };
      if (sql.includes("from content_brief")) return { rows: [] };
      if (sql.includes("from monthly_campaign_items") && sql.includes("for update")) return { rows: [target] };
      if (sql.startsWith("insert into monthly_campaign_regeneration_operations")) {
        return { rows: [{ id: 91, status: "pending" }] };
      }
      if (sql.startsWith("update monthly_campaign_plans")) return { rows: [{ version: 5 }] };
      if (sql.startsWith("insert into monthly_campaign_regeneration_targets")
          || sql.startsWith("update monthly_campaign_items")
          || sql.startsWith("insert into monthly_campaign_regeneration_outbox")
          || sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await requestMonthlyCampaignRegeneration({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52,
      expectedPlanVersion: 4, scope: "item", itemId: 62,
      idempotencyKey: "regenerate:item:62",
    });
    expect(result).toMatchObject({ operationId: 91, status: "pending", targetItemIds: [62], planVersion: 5 });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into monthly_campaign_regeneration_outbox"))).toBe(true);
    const markerSql = String(h.query.mock.calls.find(([sql]) => String(sql).startsWith("update monthly_campaign_items"))?.[0]);
    expect(markerSql).toContain("regeneration_status = 'pending'");
    expect(markerSql).not.toMatch(/title\s*=|approval_status\s*=|approved_content_version\s*=/u);
  });

  it("captures exactly one requested week without rewriting approved topics", async () => {
    const targets = [itemRow(62, 2), itemRow(63, 3), itemRow(64, 4)];
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow({ status: "approved" })] };
      if (sql.startsWith("select id, request_hash, status")) return { rows: [] };
      if (sql.includes("from content_brief")) return { rows: [] };
      if (sql.includes("from monthly_campaign_items") && sql.includes("scheduled_for >=")
          && sql.includes("for update")) return { rows: targets };
      if (sql.startsWith("insert into monthly_campaign_regeneration_operations")) {
        return { rows: [{ id: 92, status: "pending" }] };
      }
      if (sql.startsWith("update monthly_campaign_plans")) return { rows: [{ version: 5 }] };
      if (sql.startsWith("insert into monthly_campaign_regeneration_targets")
          || sql.startsWith("update monthly_campaign_items")
          || sql.startsWith("insert into monthly_campaign_regeneration_outbox")
          || sql.startsWith("insert into audit_events")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await requestMonthlyCampaignRegeneration({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52,
      expectedPlanVersion: 4, scope: "week", weekStartsOn: "2026-09-02",
      idempotencyKey: "regenerate:week:2026-09-02",
    });
    expect(result.targetItemIds).toEqual([62, 63, 64]);
    expect(result.status).toBe("pending");
    const markerSql = String(h.query.mock.calls.find(([sql]) => String(sql).startsWith("update monthly_campaign_items"))?.[0]);
    expect(markerSql).not.toMatch(/title\s*=|approval_status\s*=|approved_content_version\s*=/u);
  });

  it("reuses an already linked topic draft instead of inserting another", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_items")) return { rows: [itemRow(62, 2, 1, { draft_id: 901 })] };
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await ensureMonthlyCampaignItemDraft({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52, itemId: 62, channelId: 11,
    });
    expect(result).toMatchObject({ draftId: 901, created: false });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into drafts"))).toBe(false);
  });

  it("creates a scheduled topic draft and links only draft_id", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_items") && sql.includes("for update")) {
        return { rows: [itemRow(62, 2, 1)] };
      }
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      if (sql.startsWith("insert into drafts")) return { rows: [{ id: 901 }] };
      if (sql.startsWith("insert into draft_destinations")) return { rows: [] };
      if (sql.startsWith("update monthly_campaign_items")) {
        return { rows: [itemRow(62, 2, 1, { draft_id: 901 })] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await ensureMonthlyCampaignItemDraft({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52, itemId: 62, channelId: 11,
    });
    expect(result).toMatchObject({ draftId: 901, created: true });
    const draftInsert = h.query.mock.calls.find(([sql]) => String(sql).startsWith("insert into drafts"));
    expect(draftInsert?.[1]).toEqual(expect.arrayContaining([
      11, 7, "Тема 2", expect.stringMatching(/^2026-09-02T/),
    ]));
    const linkSql = String(h.query.mock.calls.find(([sql]) => String(sql).startsWith("update monthly_campaign_items"))?.[0]);
    expect(linkSql).toContain("draft_id = coalesce(draft_id, $4)");
    expect(linkSql).not.toContain("weekly_autopilot_plan_id =");
  });

  it("attaches an owned generated draft without creating another", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_items") && sql.includes("for update")) {
        return { rows: [itemRow(62, 2, 1)] };
      }
      if (sql.includes("from channels")) return { rows: [{ id: 11 }] };
      if (sql.includes("from drafts")) return { rows: [{ id: 777 }] };
      if (sql.startsWith("update monthly_campaign_items")) {
        return { rows: [itemRow(62, 2, 1, { draft_id: 777 })] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    });
    const result = await ensureMonthlyCampaignItemDraft({
      pool: h.pool as never,
      actorUserId: 11,
      campaignId: 41,
      planId: 52,
      itemId: 62,
      channelId: 11,
      attachDraftId: 777,
    });
    expect(result).toMatchObject({ draftId: 777, created: false });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into drafts"))).toBe(false);
  });

  it("rejects a channel outside the selected project before inserting a draft", async () => {
    const h = transactionHarness((sql) => {
      if (sql.includes("from monthly_campaigns")) return { rows: [campaignRow()] };
      if (sql.includes("from monthly_campaign_plans")) return { rows: [planRow()] };
      if (sql.includes("from monthly_campaign_items")) return { rows: [itemRow(62, 2, 1)] };
      if (sql.includes("from channels")) return { rows: [] };
      throw new Error(`unexpected SQL: ${sql}`);
    });
    await expect(ensureMonthlyCampaignItemDraft({
      pool: h.pool as never, actorUserId: 11, campaignId: 41, planId: 52, itemId: 62, channelId: 99,
    })).rejects.toMatchObject({ code: "invalid_channel" });
    expect(h.query.mock.calls.some(([sql]) => String(sql).startsWith("insert into drafts"))).toBe(false);
  });
});
