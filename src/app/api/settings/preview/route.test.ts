import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

import { normalizePostQuality } from "@/lib/post-quality.mjs";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
  channelAiContextFor: vi.fn(),
  completeAiText: vi.fn(),
  query: vi.fn(),
  connect: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/ai-usage", () => ({ channelAiContextFor: mocks.channelAiContextFor }));
vi.mock("@/lib/ai-completion-service.mjs", () => ({ completeAiText: mocks.completeAiText }));
vi.mock("@/lib/ai-provider", () => ({ buildSystemPrompt: () => "system prompt" }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query, connect: mocks.connect }) }));

import { POST } from "./route";

function request() {
  return new NextRequest("http://localhost/api/settings/preview", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost" },
    body: JSON.stringify({ channelId: 21, topic: "Ошибки в договоре" }),
  });
}

describe("POST /api/settings/preview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 12 });
    mocks.connect.mockResolvedValue({ query: mocks.clientQuery, release: mocks.release });
    mocks.clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("count(*)::text")) return { rows: [{ used: "2" }] };
      if (sql.includes("returning id")) return { rows: [{ id: "31" }] };
      return { rows: [], rowCount: 1 };
    });
    mocks.channelAiContextFor.mockResolvedValue({
      id: 21,
      title: "Право",
      network: "tg",
      profile: "Ниша канала: право\n\nСловарь бренда проекта:\n— legal tech → LegalTech",
      profileProvenance: {},
      quality: normalizePostQuality({ tone: "экспертно" }),
      postIndex: 4,
      facts: [],
      styleSamples: ["Пример голоса"],
    });
    mocks.completeAiText.mockResolvedValue({ text: "Готовый тестовый пост", engine: "navy-deepseek-flash" });
  });

  it("refuses a channel outside the selected project before calling the model", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

    const response = await POST(request());

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "channel_not_found" });
    expect(mocks.channelAiContextFor).not.toHaveBeenCalled();
    expect(mocks.completeAiText).not.toHaveBeenCalled();
  });

  it("uses its own quota row and returns a deterministic application report", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from channels")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("from users")) return { rows: [{ ai_engine: null, ai_mood: null, ai_post_settings: {} }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });

    const response = await POST(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      text: "Готовый тестовый пост",
      used: 3,
      limit: 10,
      remaining: 7,
      report: expect.arrayContaining([expect.objectContaining({ id: "brand_dictionary", status: "applied" })]),
    });
    expect(mocks.completeAiText).toHaveBeenCalledOnce();
    expect(mocks.clientQuery.mock.calls.map(([sql]) => String(sql).trim())).toEqual([
      "begin",
      expect.stringContaining("pg_advisory_xact_lock"),
      expect.stringContaining("from settings_preview_runs"),
      expect.stringContaining("insert into settings_preview_runs"),
      "commit",
    ]);
    expect(mocks.query.mock.calls.some(([sql]) => String(sql).includes("insert into ai_usage"))).toBe(false);
  });

  it("reports the consumed preview quota when the provider is unavailable", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("from channels")) return { rows: [{ "?column?": 1 }], rowCount: 1 };
      if (sql.includes("from users")) return { rows: [{ ai_engine: null, ai_mood: null, ai_post_settings: {} }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mocks.completeAiText.mockRejectedValueOnce(Object.assign(new Error("provider unavailable"), { name: "AiCompletionError" }));

    const response = await POST(request());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: "preview_provider_unavailable",
      used: 3,
      limit: 10,
      remaining: 7,
    });
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("set status = 'failed'"),
      [31, "AiCompletionError", 7],
    );
  });
});
