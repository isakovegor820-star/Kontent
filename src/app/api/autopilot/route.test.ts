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
});
