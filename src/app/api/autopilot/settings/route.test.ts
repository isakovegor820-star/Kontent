import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  ensureSettings: vi.fn(),
  loadBrief: vi.fn(),
  query: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  checkRateLimit: vi.fn(),
  getAutopilotQueue: vi.fn(),
  resumeAutopilotPartialPlan: vi.fn(),
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
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...actual, checkRateLimit: mocks.checkRateLimit };
});
vi.mock("@/lib/queue", () => ({ getAutopilotQueue: mocks.getAutopilotQueue }));
vi.mock("@/lib/autopilot-weekly-queue.mjs", () => ({
  resumeAutopilotPartialPlan: mocks.resumeAutopilotPartialPlan,
}));

import { POST } from "./route";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/autopilot/settings", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const readyBrief = {
  niche: "Кофейня",
  audience: "Жители района",
  rubrics: [],
  goal: "",
  cta: "",
  taboo: "",
  quality: {},
  ready: true,
  source: "quiz",
};

describe("POST /api/autopilot/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 4 });
    mocks.checkRateLimit.mockResolvedValue({
      allowed: true,
      limit: 120,
      remaining: 119,
      retryAfter: 0,
    });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 4,
      role: "owner",
      version: 1,
    });
    mocks.resolveChannel.mockResolvedValue(22);
    mocks.ensureSettings.mockResolvedValue({
      enabled: false,
      mode: "confirm",
      post_frequency: 3,
      approvals_streak: 0,
      generation_engine: "navy-deepseek-pro",
      planning_months: 1,
      planning_weeks: 4,
    });
    mocks.loadBrief.mockResolvedValue(readyBrief);
    mocks.getAutopilotQueue.mockReturnValue({ add: vi.fn() });
    mocks.resumeAutopilotPartialPlan.mockResolvedValue({ status: "skipped" });
    mocks.query.mockResolvedValue({
      rows: [{ enabled: true, mode: "confirm", post_frequency: 5, approvals_streak: 0 }],
      rowCount: 1,
    });
  });

  it("rejects a cross-origin mutation before authentication", async () => {
    const response = await POST(request({ channelId: 22 }, { origin: "https://evil.example" }));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
  });

  it("never resolves or updates a channel for a guest", async () => {
    mocks.getSessionUser.mockResolvedValue(null);

    const response = await POST(request({ channelId: 22, enabled: true }));

    expect(response.status).toBe(401);
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("fails closed before reading the body when the limiter is unavailable", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      limit: 120,
      remaining: 0,
      retryAfter: 30,
      unavailable: true,
    });

    const response = await POST(request({ channelId: 22, enabled: true }));

    expect(response.status).toBe(503);
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();
    expect(mocks.resolveChannel).not.toHaveBeenCalled();
  });

  it("rejects oversized streamed input and unexpected fields", async () => {
    const oversized = new NextRequest("http://localhost/api/autopilot/settings", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "2" },
      body: JSON.stringify({ channelId: 22, padding: "x".repeat(17 * 1024) }),
    });
    const oversizedResponse = await POST(oversized);
    expect(oversizedResponse.status).toBe(400);
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();

    const unknownResponse = await POST(request({ channelId: 22, project_id: 999 }));
    expect(unknownResponse.status).toBe(400);
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();
  });

  it("requires JSON instead of parsing an ambiguous content type", async () => {
    const response = await POST(new NextRequest("http://localhost/api/autopilot/settings", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ channelId: 22 }),
    }));

    expect(response.status).toBe(400);
    expect(mocks.requireSelectedProjectPermission).not.toHaveBeenCalled();
  });

  it("rejects a channel from project A while project B is selected", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request({ channelId: 99, enabled: true }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "no_channel" });
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 4, projectId: 88 },
      99,
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not enable Autopilot until the selected channel has a confirmed brief", async () => {
    mocks.loadBrief.mockResolvedValue({ ...readyBrief, ready: false });

    const response = await POST(request({ channelId: 22, enabled: true }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "no_brief" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("keeps full-auto locked until two approval streaks", async () => {
    const response = await POST(request({ channelId: 22, mode: "full" }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "streak_required" });
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns authoritative settings and saves the requested weekly frequency", async () => {
    const response = await POST(request({ channelId: 22, enabled: true, post_frequency: 5 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      settings: { enabled: true, mode: "confirm", post_frequency: 5, approvals_streak: 0 },
      resumedPartialPlan: false,
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("returning enabled"), [
      88,
      22,
      true,
      null,
      5,
      null,
      null,
      null,
      expect.stringContaining('"id"'),
      null,
    ]);
  });

  it("immediately resumes a partial plan when Autopilot is enabled", async () => {
    mocks.resumeAutopilotPartialPlan.mockResolvedValue({ status: "queued", planId: 91 });

    const response = await POST(request({ channelId: 22, enabled: true }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ ok: true, resumedPartialPlan: true });
    expect(mocks.resumeAutopilotPartialPlan).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 88,
      userId: 4,
      channelId: 22,
    }));
  });

  it("marks a delayed partial recovery as paused as soon as Autopilot is disabled", async () => {
    mocks.query
      .mockResolvedValueOnce({
        rows: [{ enabled: false, mode: "confirm", post_frequency: 5, approvals_streak: 0 }],
        rowCount: 1,
      })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });

    const response = await POST(request({ channelId: 22, enabled: false }));

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('"recoveryState":"paused"'),
      [88, 22],
    );
    expect(mocks.resumeAutopilotPartialPlan).not.toHaveBeenCalled();
  });

  it("saves an Autopilot model and planning horizon", async () => {
    mocks.query.mockResolvedValue({
      rows: [{
        enabled: false,
        mode: "confirm",
        post_frequency: 3,
        approvals_streak: 0,
        generation_engine: "navy-gpt-5-4",
        planning_months: 2,
        planning_weeks: 7,
      }],
      rowCount: 1,
    });

    const response = await POST(request({
      channelId: 22,
      generation_engine: "navy-gpt-5-4",
      planning_weeks: 7,
    }));

    expect(response.status).toBe(200);
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("generation_engine"), [
      88,
      22,
      null,
      null,
      null,
      "navy-gpt-5-4",
      2,
      7,
      null,
      null,
    ]);
  });

  it("rejects unknown generation settings", async () => {
    const response = await POST(request({
      channelId: 22,
      generation_engine: "not-a-model",
      planning_months: 12,
    }));

    expect(response.status).toBe(422);
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("returns a retryable service failure instead of pretending settings were saved", async () => {
    mocks.query.mockRejectedValue(new Error("database offline"));
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(request({ channelId: 22, post_frequency: 5 }));
    errorLog.mockRestore();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "unavailable" });
  });
});
