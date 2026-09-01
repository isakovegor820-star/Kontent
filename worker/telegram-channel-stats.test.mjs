import { describe, expect, it, vi } from "vitest";

import {
  captureTelegramChannelPost,
  captureTelegramReactionCount,
  telegramReactionTotal,
} from "./telegram-channel-stats.mjs";

describe("Telegram live channel statistics", () => {
  it("materializes a direct channel post in the connected project", async () => {
    const db = { query: vi.fn(async () => ({ rows: [{
      post_id: "51", project_id: "7", user_id: "9", channel_id: "11", publication_origin: "manual",
    }] })) };
    const result = await captureTelegramChannelPost(db, {
      message_id: 42,
      date: 1_788_258_800,
      chat: { id: -100123, type: "channel" },
      text: "Пост напрямую",
    });

    expect(result).toMatchObject({ captured: true, postId: 51, projectId: 7, channelId: 11, messageId: 42 });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("telegram_channel_post"), [
      "-100123", 42, "Пост напрямую", expect.stringMatching(/^2026-/u),
    ]);
    expect(String(db.query.mock.calls[0][0])).toContain("on conflict (channel_id, external_message_id)");
  });

  it("rejects non-channel messages without touching storage", async () => {
    const db = { query: vi.fn() };
    await expect(captureTelegramChannelPost(db, {
      message_id: 1, date: 1_788_258_800, chat: { id: 5, type: "private" },
    })).resolves.toEqual({ captured: false, reason: "invalid_channel_post" });
    expect(db.query).not.toHaveBeenCalled();
  });

  it("sums reaction counts and preserves views in the upsert", async () => {
    expect(telegramReactionTotal({ reactions: [
      { total_count: 4 }, { total_count: 3 }, { total_count: -1 },
    ] })).toBe(7);
    const db = { query: vi.fn(async () => ({ rows: [{ post_id: "51", project_id: "7" }] })) };
    await expect(captureTelegramReactionCount(db, {
      chat: { id: -100123 }, message_id: 42,
      reactions: [{ total_count: 4 }, { total_count: 3 }],
    }, "2026-09-01")).resolves.toEqual({ captured: true, postId: 51, projectId: 7, reactions: 7 });
    const sql = String(db.query.mock.calls[0][0]);
    expect(sql).toContain("coalesce(post_stats.views, excluded.views)");
    expect(sql).toContain("count(*) from publication_parts");
    expect(db.query.mock.calls[0][1]).toEqual(["-100123", 42, "2026-09-01", 7]);
  });
});
