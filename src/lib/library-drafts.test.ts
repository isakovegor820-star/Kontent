import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildServerLibraryDraftContext, parseLibraryItemKey } from "./library-drafts";

function dbWith(rows: Record<string, unknown>) {
  return {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("select id from channels")) return { rows: [{ id: "11" }] };
      if (sql.includes("from competitor_posts post")) return { rows: rows.reference ? [rows.reference] : [] };
      if (sql.includes("from content_ideas idea")) return { rows: rows.idea ? [rows.idea] : [] };
      if (sql.includes("from saved_posts saved")) return { rows: rows.saved ? [rows.saved] : [] };
      throw new Error(`Unexpected query: ${sql}`);
    }),
  };
}

describe("server-owned library draft context", () => {
  it("accepts only stable registry keys", () => {
    expect(parseLibraryItemKey("reference:41")).toEqual({ kind: "reference", id: 41 });
    expect(() => parseLibraryItemKey("hit:41")).toThrow(expect.objectContaining({ code: "bad_library_item" }));
  });

  it("loads a reference inside the selected project and never accepts browser text", async () => {
    const db = dbWith({
      reference: {
        id: "41",
        text: "Серверный оригинал",
        source_id: "9",
        source_title: "Источник",
        handle: "source",
        tg_msg_id: "71",
      },
    });
    const context = await buildServerLibraryDraftContext({
      db: db as never,
      userId: 7,
      projectId: 3,
      channelId: 11,
      itemKey: "reference:41",
      clientKey: "draft_library-reference-1234567890",
    });

    expect(context).toMatchObject({
      text: "Серверный оригинал",
      origin: "competitor",
      channelIds: [11],
      sourceRef: { kind: "reference", id: "41", provenance: { kind: "competitor_post", id: "9" } },
    });
    expect(db.query.mock.calls[1][0]).toContain("channel.project_id = $4");
  });

  it("loads a ready idea with its semantic fields", async () => {
    const db = dbWith({
      idea: {
        id: "52",
        topic: "Тема",
        hook: "Хук",
        structure: "Структура",
        why_it_worked: "Наблюдаемая механика",
        source_id: "9",
        source_title: "Источник",
        handle: "source",
        tg_msg_id: "71",
      },
    });
    const context = await buildServerLibraryDraftContext({
      db: db as never,
      userId: 7,
      projectId: 3,
      channelId: 11,
      itemKey: "idea:52",
      clientKey: "draft_library-idea-1234567890",
    });

    expect(context).toMatchObject({
      origin: "idea",
      sourceRef: { kind: "idea", id: "52", topic: "Тема", hook: "Хук" },
    });
  });

  it("opens a saved server snapshot even when its original source disappeared", async () => {
    const db = dbWith({ saved: { id: "63", text: "Сохранённый снимок" } });
    const context = await buildServerLibraryDraftContext({
      db: db as never,
      userId: 7,
      projectId: 3,
      channelId: 11,
      itemKey: "saved:63",
      clientKey: "draft_library-saved-1234567890",
    });

    expect(context).toMatchObject({ text: "Сохранённый снимок", origin: "manual", sourceRef: null });
  });

  it("fails closed when the selected channel is outside the project", async () => {
    const db = { query: vi.fn(async () => ({ rows: [] })) };
    await expect(buildServerLibraryDraftContext({
      db: db as never,
      userId: 7,
      projectId: 3,
      channelId: 99,
      itemKey: "saved:63",
      clientKey: "draft_library-saved-1234567890",
    })).rejects.toMatchObject({ code: "library_channel_unavailable" });
  });
});
