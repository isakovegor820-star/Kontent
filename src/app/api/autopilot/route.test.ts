import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  resolveChannel: vi.fn(),
  ensureSettings: vi.fn(),
  loadBrief: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  ensureSettings: mocks.ensureSettings,
  loadBrief: mocks.loadBrief,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { GET } from "./route";

describe("GET /api/autopilot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "author",
      version: 1,
    });
    mocks.ensureSettings.mockResolvedValue({
      enabled: false,
      mode: "confirm",
      post_frequency: 5,
      approvals_streak: 0,
      generation_engine: "navy-deepseek-pro",
      planning_months: 1,
      planning_weeks: 4,
    });
    mocks.loadBrief.mockResolvedValue({ ready: false });
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("from channels")) {
        return { rows: [{ id: "22", title: "Проект B", handle: "project_b" }], rowCount: 1 };
      }
      if (sql.includes("from autopilot_plan")) return { rows: [], rowCount: 0 };
      return { rows: [], rowCount: 0 };
    });
  });

  it("loads channels, settings, brief, and plan from the server-selected project", async () => {
    mocks.resolveChannel.mockResolvedValue(22);

    const response = await GET(new NextRequest("http://localhost/api/autopilot?channel=22"));

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("where project_id = $1"),
      [88],
    );
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      22,
    );
    expect(mocks.ensureSettings).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      22,
    );
    expect(mocks.loadBrief).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      22,
    );
    const planQuery = mocks.query.mock.calls.find(([sql]) => String(sql).includes("from autopilot_plan"));
    expect(planQuery?.[0]).toContain("where project_id = $1 and channel_id = $2");
    expect(planQuery?.[1]).toEqual([88, 22]);
  });

  it("returns 404 instead of falling back when a project A channel is requested from project B", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await GET(new NextRequest("http://localhost/api/autopilot?channel=99"));

    expect(response.status).toBe(404);
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      99,
    );
    expect(mocks.ensureSettings).not.toHaveBeenCalled();
    expect(mocks.loadBrief).not.toHaveBeenCalled();
  });

  it("returns durable build progress for a running plan", async () => {
    mocks.resolveChannel.mockResolvedValue(22);
    const checkpointedAt = new Date().toISOString();
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("from channels")) {
        return { rows: [{ id: "22", title: "Проект B", handle: "project_b" }], rowCount: 1 };
      }
      if (sql.includes("from autopilot_plan")) {
        return {
          rows: [{
            id: 91,
            status: "building",
            created_at: checkpointedAt,
            build_activity_at: checkpointedAt,
            planning_months: 1,
            planning_weeks: 1,
            generation_post_frequency: 7,
            expected_post_count: 7,
            items: [
              { i: 0, buildState: "ready", checkpointedAt, aiReady: true, draft: "Готово" },
              { i: 1, buildState: "queued", checkpointedAt },
            ],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const response = await GET(new NextRequest("http://localhost/api/autopilot?channel=22"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.plan.buildProgress).toMatchObject({
      completed: 1,
      total: 7,
      percent: 14,
      stage: "generating",
    });
  });

  it("keeps an old build active when its durable heartbeat is fresh", async () => {
    mocks.resolveChannel.mockResolvedValue(22);
    const oldCheckpoint = "2026-08-18T08:00:00.000Z";
    const freshHeartbeat = new Date().toISOString();
    mocks.query.mockImplementation(async (sqlValue: string) => {
      const sql = sqlValue.replace(/\s+/g, " ").trim();
      if (sql.includes("from channels")) {
        return { rows: [{ id: "22", title: "Проект B", handle: "project_b" }], rowCount: 1 };
      }
      if (sql.includes("from autopilot_plan")) {
        return {
          rows: [{
            id: 91,
            status: "building",
            created_at: oldCheckpoint,
            build_activity_at: freshHeartbeat,
            generation_post_frequency: 5,
            expected_post_count: 5,
            planning_months: 1,
            planning_weeks: 1,
            items: [{ i: 0, buildState: "queued", checkpointedAt: oldCheckpoint }],
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const response = await GET(new NextRequest("http://localhost/api/autopilot?channel=22"));
    const body = await response.json();

    expect(body.plan.status).toBe("building");
    expect(mocks.query).not.toHaveBeenCalledWith(
      expect.stringContaining("set status = 'error'"),
      expect.anything(),
    );
  });

  it("does not disguise an internal failure as an empty successful state", async () => {
    mocks.query.mockRejectedValueOnce(new Error("database unavailable"));

    const response = await GET(new NextRequest("http://localhost/api/autopilot"));

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({ error: "server" });
  });
});
