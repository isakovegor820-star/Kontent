import { describe, expect, it, vi } from "vitest";
import { loadBotIdeaStyleSamples } from "./bot-idea-context.mjs";

describe("bot idea style context", () => {
  it("uses explicit examples plus channel-scoped externally verified non-RSS posts", async () => {
    const pool = {
      query: vi.fn(async (sql, params) => {
        if (sql.includes("from posts")) {
          expect(sql).toContain("p.channel_id = $2");
          expect(sql).toContain("p.verification_state = 'verified'");
          expect(sql).toContain("not exists (select 1 from rss_items");
          expect(params).toEqual([7, 18, 8]);
          return { rows: [{ text: "Проверенный живой пост канала" }] };
        }
        if (sql.includes("from content_brief")) {
          expect(params).toEqual([7, 18]);
          return { rows: [{ quality: { styleExamples: ["Одобренный владельцем пример"] } }] };
        }
        throw new Error("unexpected query");
      }),
    };

    await expect(loadBotIdeaStyleSamples(pool, 7, 18)).resolves.toEqual([
      "Одобренный владельцем пример",
      "Проверенный живой пост канала",
    ]);
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("rejects a missing channel instead of falling back to all-user posts", async () => {
    const pool = { query: vi.fn() };
    await expect(loadBotIdeaStyleSamples(pool, 7, null)).rejects.toThrow(/channel/u);
    expect(pool.query).not.toHaveBeenCalled();
  });
});
