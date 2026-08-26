import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  resolveChannel: vi.fn(),
  ensureSettings: vi.fn(),
  loadBrief: vi.fn(),
  query: vi.fn(),
  release: vi.fn(),
  connect: vi.fn(),
  requireProjectPermission: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ connect: mocks.connect }) }));
vi.mock("@/lib/autopilot", () => ({
  resolveChannel: mocks.resolveChannel,
  ensureSettings: mocks.ensureSettings,
  loadBrief: mocks.loadBrief,
}));
vi.mock("@/lib/project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/project-permissions")>();
  return {
    ...actual,
    requireProjectPermission: mocks.requireProjectPermission,
    requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
  };
});

import { POST } from "./route";

function request(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/settings/channel", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

const brief = {
  niche: "Кофе и домашнее заваривание",
  audience: "Люди, которые хотят варить вкуснее",
  rubrics: ["Полезный совет"],
  formats: ["Текст", "Фото"],
  authorRole: "Обжарщик и автор канала",
  goal: "Растить доверие",
  cta: "В магазин",
  taboo: "Политика",
  quality: { preset: "expert", styleExamples: ["Проверенный авторский пример длиной больше двадцати символов."] },
  ready: true,
  source: "manual",
};

const settings = {
  enabled: false,
  mode: "confirm",
  post_frequency: 5,
  approvals_streak: 0,
};

describe("POST /api/settings/channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.requireProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.resolveChannel.mockResolvedValue(21);
    mocks.connect.mockResolvedValue({ query: mocks.query, release: mocks.release });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("select enabled, mode")) return { rows: [settings], rowCount: 1 };
      if (sql.includes("returning enabled")) return { rows: [settings], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
  });

  it("rejects a cross-origin save before authentication", async () => {
    const response = await POST(request(
      { channelId: 21, brief, settings },
      { origin: "https://evil.example" },
    ));

    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.connect).not.toHaveBeenCalled();
  });

  it("saves the brief and autopilot settings in one transaction", async () => {
    const response = await POST(request({ channelId: 21, brief, settings }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      channelId: 21,
      brief: { niche: brief.niche, ready: true },
      settings,
    });
    const statements = mocks.query.mock.calls.map(([sql]) => String(sql).trim());
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      "content.edit",
    );
    expect(mocks.requireProjectPermission).toHaveBeenCalledWith(
      expect.anything(),
      7,
      12,
      "content.publish",
    );
    expect(statements[0]).toBe("begin");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("generation_engine"),
      [12, 7, 21, "navy-deepseek-flash"],
    );
    const settingsInsert = statements.find((sql) => sql.includes("insert into autopilot_settings"));
    expect(settingsInsert).toContain("on conflict do nothing");
    expect(statements.some((sql) => sql.includes("on conflict (project_id, channel_id)"))).toBe(true);
    expect(statements.some((sql) => sql.includes("where user_id = $1 and channel_id = $2"))).toBe(false);
    expect(statements.some((sql) => sql.includes("insert into content_brief"))).toBe(true);
    expect(statements.some((sql) => sql.includes("update autopilot_settings"))).toBe(true);
    expect(statements.at(-1)).toBe("commit");
    expect(mocks.release).toHaveBeenCalledOnce();
  });

  it("rejects a member without publication permission before opening a transaction", async () => {
    const { ProjectAccessError } = await import("@/lib/project-permissions");
    mocks.requireProjectPermission.mockRejectedValueOnce(new ProjectAccessError("permission_denied"));

    const response = await POST(request({ channelId: 21, brief, settings }));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ error: "access_denied" });
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it("rolls back the whole profile when full auto is still locked", async () => {
    const response = await POST(request({
      channelId: 21,
      brief,
      settings: { ...settings, mode: "full" },
    }));

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "streak_required" });
    expect(mocks.query).toHaveBeenCalledWith("rollback");
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("content_brief"))).toBe(false);
  });
});
