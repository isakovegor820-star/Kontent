import { describe, expect, it, vi } from "vitest";

import { importTelegramPublicPosts } from "./telegram-public-import.mjs";

describe("Telegram public channel import", () => {
  it("materializes valid external posts inside the exact project and channel", async () => {
    const db = { query: vi.fn(async () => ({ rowCount: 1, rows: [] })) };
    const result = await importTelegramPublicPosts(db, {
      projectId: 7,
      userId: 9,
      channelId: 11,
    }, {
      kind: "window",
      posts: [
        { externalMessageId: 42, text: "Пост вручную", publishedAt: "2026-09-01T10:00:00.000Z" },
        { externalMessageId: 42, text: "Дубликат", publishedAt: "2026-09-01T10:00:00.000Z" },
        { externalMessageId: 0, text: "Некорректный", publishedAt: "2026-09-01T10:00:00.000Z" },
      ],
    });

    expect(result).toEqual({ discovered: 1, imported: 1 });
    expect(db.query).toHaveBeenCalledWith(
      expect.stringContaining("publication_origin"),
      [7, 9, 11, expect.stringContaining('"external_message_id":42')],
    );
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toContain("from publication_parts part");
    expect(sql).toContain("parent.project_id = $1");
    expect(sql).toContain("parent.channel_id = $3");
    expect(sql).toContain("on conflict (channel_id, external_message_id)");
  });

  it("does not write when the public feed is unavailable", async () => {
    const db = { query: vi.fn() };
    await expect(importTelegramPublicPosts(db, { projectId: 7, userId: 9, channelId: 11 }, {
      kind: "temporary_error",
      posts: [],
    })).resolves.toEqual({ discovered: 0, imported: 0 });
    expect(db.query).not.toHaveBeenCalled();
  });
});
