import { describe, expect, it, vi } from "vitest";
import { collectRssPipeline } from "./rss-pipeline.mjs";

function rss(items) {
  return `<rss><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><description>${item.summary}</description><guid>${item.guid}</guid></item>`,
    )
    .join("")}</channel></rss>`;
}

function harness(feeds, xmlByUrl) {
  let itemId = 100;
  const queries = [];
  const pool = {
    query: vi.fn(async (sql, params = []) => {
      queries.push({ sql, params });
      if (sql.includes("from rss_feeds f")) return { rows: feeds };
      if (sql.includes("insert into rss_items")) return { rowCount: 1, rows: [{ id: itemId++ }] };
      return { rowCount: 1, rows: [] };
    }),
  };
  const enqueuePost = vi.fn(async () => 900 + enqueuePost.mock.calls.length);
  const fetchFn = vi.fn(async (url) => ({ ok: true, text: async () => xmlByUrl[url] }));
  const logger = { log: vi.fn(), error: vi.fn() };
  return { pool, queries, enqueuePost, fetchFn, logger };
}

describe("collectRssPipeline", () => {
  it("ручной запуск запрашивает только feeds конкретного пользователя", async () => {
    const feeds = [{
      id: 1,
      url: "https://example.com/a.xml",
      channel_id: 7,
      user_id: 42,
      ai_summarize: false,
      max_per_day: 3,
      posted_today: 0,
    }];
    const h = harness(feeds, {
      [feeds[0].url]: rss([{ title: "Новость", link: "https://example.com/1", summary: "Текст", guid: "1" }]),
    });

    const result = await collectRssPipeline({ ...h, userId: 42, now: () => 1_700_000_000_000 });

    expect(h.queries[0].sql).toContain("f.user_id = $1");
    expect(h.queries[0].params).toEqual([42]);
    expect(h.enqueuePost).toHaveBeenCalledOnce();
    expect(h.enqueuePost).toHaveBeenCalledWith(
      42,
      7,
      "Новость\n\nТекст\n\nhttps://example.com/1",
      "2023-11-14T22:18:20.000Z",
    );
    expect(result).toEqual({ feeds: 1, posts: 1 });
  });

  it("лимит считается отдельно для каждой ленты, а не глобально", async () => {
    const feeds = [
      { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 1, posted_today: 0 },
      { id: 2, url: "https://b.test/rss", channel_id: 22, user_id: 2, ai_summarize: false, max_per_day: 1, posted_today: 0 },
    ];
    const h = harness(feeds, {
      [feeds[0].url]: rss([{ title: "A", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
      [feeds[1].url]: rss([{ title: "B", link: "https://b.test/1", summary: "Beta", guid: "b1" }]),
    });

    const result = await collectRssPipeline({ ...h });

    expect(h.enqueuePost).toHaveBeenCalledTimes(2);
    expect(h.enqueuePost.mock.calls.map((call) => call.slice(0, 2))).toEqual([[1, 11], [2, 22]]);
    expect(result.posts).toBe(2);
  });

  it("помечает лишние элементы skipped и не ставит их в publish queue", async () => {
    const feed = { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([
        { title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" },
        { title: "A2", link: "https://a.test/2", summary: "Beta", guid: "a2" },
      ]),
    });

    await collectRssPipeline({ ...h });

    expect(h.enqueuePost).toHaveBeenCalledOnce();
    expect(h.queries.some((q) => q.sql.includes("status = 'skipped'"))).toBe(true);
  });

  it("освобождает GUID для повтора, если publish queue не приняла пост", async () => {
    const feed = { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    h.enqueuePost.mockRejectedValueOnce(new Error("redis unavailable"));

    const result = await collectRssPipeline({ ...h });

    expect(result.posts).toBe(0);
    expect(h.queries).toContainEqual({
      sql: "delete from rss_items where id = $1 and status = 'new'",
      params: [100],
    });
    expect(h.logger.error).toHaveBeenCalledOnce();
  });
});
