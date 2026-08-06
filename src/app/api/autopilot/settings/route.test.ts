import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
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
    mocks.query.mockResolvedValue({
      rows: [{ enabled: true, mode: "confirm", post_frequency: 30, approvals_streak: 0 }],
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
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rejects a channel that is not owned by the authenticated account", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request({ channelId: 99, enabled: true }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ ok: false, error: "no_channel" });
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

  it("returns authoritative settings and clamps frequency to the server limit", async () => {
    const response = await POST(request({ channelId: 22, enabled: true, post_frequency: 999 }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      settings: { enabled: true, mode: "confirm", post_frequency: 30, approvals_streak: 0 },
    });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("returning enabled"), [
      4,
      22,
      true,
      null,
      30,
      null,
      null,
      null,
    ]);
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
      4,
      22,
      null,
      null,
      null,
      "navy-gpt-5-4",
      2,
      7,
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
