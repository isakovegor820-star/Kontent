import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  ensureSettings: vi.fn(),
  loadBrief: vi.fn(),
  getWorkersCount: vi.fn(),
  add: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  poolQuery: vi.fn(),
  resolveAiEngineRuntime: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  ensureSettings: mocks.ensureSettings,
  loadBrief: mocks.loadBrief,
}));
vi.mock("@/lib/brief", () => ({ briefComplete: () => true }));
vi.mock("@/lib/queue", () => ({
  getStatsQueue: () => ({ getWorkersCount: mocks.getWorkersCount, add: mocks.add }),
}));
vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: async () => ({ query: mocks.clientQuery, release: mocks.release }),
  }),
}));
vi.mock("@/lib/ai-engine-policy.mjs", () => ({
  resolveAiEngineRuntime: mocks.resolveAiEngineRuntime,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { POST } from "./route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/autopilot/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/autopilot/generate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "author",
      version: 1,
    });
    mocks.resolveChannel.mockResolvedValue(22);
    mocks.loadBrief.mockResolvedValue({ ready: true });
    mocks.ensureSettings.mockResolvedValue({
      enabled: true,
      mode: "confirm",
      post_frequency: 7,
      approvals_streak: 0,
      generation_engine: "navy-deepseek-pro",
      planning_months: 1,
      planning_weeks: 4,
    });
    mocks.resolveAiEngineRuntime.mockReturnValue({ supported: true, configured: true });
    mocks.getWorkersCount.mockResolvedValue(1);
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("status = 'building'") && sql.includes("select id")) return { rows: [] };
      if (sql.includes("insert into autopilot_plan")) return { rows: [{ id: "91" }] };
      return { rows: [], rowCount: 1 };
    });
    mocks.add.mockResolvedValue({ id: "autopilot-plan-91" });
  });

  it("rejects an unknown model before creating a plan", async () => {
    const response = await POST(request({
      channelId: 22,
      generationEngine: "unknown",
      planningMonths: 3,
    }));

    expect(response.status).toBe(422);
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("snapshots the model and freely selected weekly horizon into the queued plan", async () => {
    const response = await POST(request({
      channelId: 22,
      generationEngine: "navy-gpt-5-4",
      planningWeeks: 7,
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, planId: "91" });
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("generation_engine = $3"),
      [88, 22, "navy-gpt-5-4", 2, 7],
    );
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("insert into autopilot_plan"),
      [88, 4, 22, "navy-gpt-5-4", 2, 7, null],
    );
    expect(mocks.add).toHaveBeenCalledWith(
      "autopilot-plan",
      { projectId: 88, userId: 4, channelId: 22, planId: "91" },
      expect.objectContaining({ jobId: "autopilot-plan-91" }),
    );
  });

  it("does not create a plan for a project A channel while project B is selected", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request({ channelId: 99 }));

    expect(response.status).toBe(422);
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      99,
    );
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("fails clearly when the selected Navy model has no API key", async () => {
    mocks.resolveAiEngineRuntime.mockReturnValue({ supported: true, configured: false });

    const response = await POST(request({
      channelId: 22,
      generationEngine: "navy-deepseek-pro",
      planningMonths: 1,
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "engine_unavailable" });
    expect(mocks.add).not.toHaveBeenCalled();
  });

  it("accepts only an approved monthly plan from the selected project and forces one week", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [{ id: 73 }], rowCount: 1 });

    const response = await POST(request({
      channelId: 22,
      planningWeeks: 1,
      monthlyCampaignPlanId: 73,
    }));

    expect(response.status).toBe(200);
    expect(mocks.poolQuery).toHaveBeenCalledWith(
      expect.stringContaining("plan.project_id = $2 and plan.status = 'approved'"),
      [73, 88],
    );
    expect(mocks.clientQuery).toHaveBeenCalledWith(
      expect.stringContaining("monthly_campaign_plan_id"),
      [88, 4, 22, "navy-deepseek-pro", 1, 1, 73],
    );
  });

  it("does not reveal or queue another project's monthly plan", async () => {
    mocks.poolQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const response = await POST(request({ channelId: 22, monthlyCampaignPlanId: 999 }));
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "monthly_plan_unavailable" });
    expect(mocks.clientQuery).not.toHaveBeenCalled();
    expect(mocks.add).not.toHaveBeenCalled();
  });
});
