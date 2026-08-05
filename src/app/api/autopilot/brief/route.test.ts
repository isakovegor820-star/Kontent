import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  query: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  loadBrief: vi.fn(),
}));

import { POST } from "./route";

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
      expect.arrayContaining([7, 21, "quiz"]),
    );
    expect(mocks.query.mock.calls[0][1].at(-1)).toBe("quiz");
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
