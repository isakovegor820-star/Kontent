import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  loadBrief: vi.fn(),
  query: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  loadBrief: mocks.loadBrief,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.requireSelectedProjectPermission };
});

import { GET, POST } from "./route";

function request(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/autopilot/brief", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /api/autopilot/brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 7,
      role: "author",
      version: 1,
    });
    mocks.resolveChannel.mockResolvedValue(21);
    mocks.query.mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("persists a complete onboarding brief with source quiz", async () => {
    const response = await POST(request({
      channelId: 21,
      niche: "Юридические технологии",
      audience: "Юристы и владельцы бизнеса",
      goal: "Объяснять изменения рынка",
      rubrics: ["Разбор кейса"],
      formats: ["Видео"],
      authorRole: "Юрист-практик",
      ready: true,
      source: "quiz",
    }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      brief: { source: "quiz", ready: true },
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("insert into content_brief"),
      expect.arrayContaining([88, 7, 21, "quiz"]),
    );
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 7, projectId: 88 },
      21,
    );
    expect(mocks.query.mock.calls[0][0]).toContain("on conflict (project_id, channel_id)");
    expect(mocks.query.mock.calls[0][1].at(-1)).toBe("quiz");
  });

  it("does not save a project A brief while project B is selected", async () => {
    mocks.resolveChannel.mockResolvedValue(null);

    const response = await POST(request({
      channelId: 99,
      niche: "Чужой проект",
      audience: "Чужая аудитория",
      ready: false,
    }));

    expect(response.status).toBe(422);
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 7, projectId: 88 },
      99,
    );
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("does not confirm an incomplete onboarding brief", async () => {
    const response = await POST(request({
      channelId: 21,
      niche: "",
      audience: "",
      ready: true,
      source: "quiz",
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({ ok: false, error: "incomplete" });
    expect(mocks.query).not.toHaveBeenCalled();
  });
});

describe("GET /api/autopilot/brief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: 88,
      userId: 7,
      role: "author",
      version: 1,
    });
    mocks.resolveChannel.mockResolvedValue(21);
    mocks.loadBrief.mockResolvedValue({ niche: "Общий бриф", ready: false });
  });

  it("loads the shared brief through the selected project scope", async () => {
    const response = await GET(new NextRequest("http://localhost/api/autopilot/brief?channel=21"));

    expect(response.status).toBe(200);
    expect(mocks.resolveChannel).toHaveBeenCalledWith(
      { actorUserId: 7, projectId: 88 },
      21,
    );
    expect(mocks.loadBrief).toHaveBeenCalledWith(
      { actorUserId: 7, projectId: 88 },
      21,
    );
  });
});
