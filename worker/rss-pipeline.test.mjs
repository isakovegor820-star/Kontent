import { describe, expect, it, vi } from "vitest";
import { collectRssPipeline, RSS_IRRELEVANT_MARKER } from "./rss-pipeline.mjs";

function rss(items) {
  return `<rss><channel>${items
    .map(
      (item) =>
        `<item><title>${item.title}</title><link>${item.link}</link><description>${item.summary}</description><guid>${item.guid}</guid></item>`,
    )
    .join("")}</channel></rss>`;
}

function harness(feeds, xmlByUrl) {
  feeds = feeds.map((feed) => ({
    // Все прежние тесты описывают уже инициализированную ленту. null передаётся
    // явно только в регрессии первого запуска ниже.
    last_fetched_at: "2026-08-01T12:00:00.000Z",
    publish_existing: false,
    ...feed,
  }));
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
  it("собирает юридический инфоповод, но не публикует его без явного разрешения", async () => {
    const feed = {
      id: 1,
      url: "https://a.test/rss",
      channel_id: 11,
      user_id: 1,
      source_kind: "legal_opportunity",
      auto_publish_enabled: false,
      ai_summarize: true,
      max_per_day: 3,
      posted_today: 0,
    };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "Новая норма", link: "https://a.test/1", summary: "Факты", guid: "a1" }]),
    });
    const summarize = vi.fn();

    const result = await collectRssPipeline({ ...h, summarize });

    expect(result).toEqual({ feeds: 1, posts: 0 });
    expect(summarize).not.toHaveBeenCalled();
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries[0].sql).toContain("f.auto_publish_enabled");
    expect(h.queries).toContainEqual({
      sql: "update rss_feeds set last_fetched_at = now() where id = $1",
      params: [1],
    });
  });

  it("первый сбор запоминает текущую историю и ничего не публикует", async () => {
    const feed = {
      id: 1,
      url: "https://a.test/rss",
      channel_id: 11,
      user_id: 1,
      ai_summarize: true,
      max_per_day: 3,
      posted_today: 0,
      last_fetched_at: null,
    };
    const h = harness([feed], {
      [feed.url]: rss([
        { title: "Старая A", link: "https://a.test/1", summary: "Alpha", guid: "a1" },
        { title: "Старая B", link: "https://a.test/2", summary: "Beta", guid: "a2" },
      ]),
    });
    const summarize = vi.fn();

    const result = await collectRssPipeline({ ...h, summarize });

    expect(result).toEqual({ feeds: 1, posts: 0 });
    expect(summarize).not.toHaveBeenCalled();
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries.filter((query) => query.sql.includes("skip_reason = 'baseline'"))).toEqual([
      {
        sql: "update rss_items set status = 'skipped', skip_reason = 'baseline' where id = $1",
        params: [100],
      },
      {
        sql: "update rss_items set status = 'skipped', skip_reason = 'baseline' where id = $1",
        params: [101],
      },
    ]);
    expect(h.queries).toContainEqual({
      sql: "update rss_feeds set last_fetched_at = now() where id = $1",
      params: [1],
    });
  });

  it("первый сбор публикует текущие элементы при явном publish_existing=true", async () => {
    const feed = {
      id: 1,
      url: "https://a.test/rss",
      channel_id: 11,
      user_id: 1,
      ai_summarize: false,
      max_per_day: 1,
      posted_today: 0,
      last_fetched_at: null,
      publish_existing: true,
    };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });

    const result = await collectRssPipeline({ ...h });

    expect(result).toEqual({ feeds: 1, posts: 1 });
    expect(h.enqueuePost).toHaveBeenCalledOnce();
    expect(h.queries.some((query) => query.sql.includes("skip_reason = 'baseline'"))).toBe(false);
  });

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
    expect(h.queries[0].sql).toContain(
      "join channels c on c.id = f.channel_id and c.user_id = f.user_id",
    );
    expect(h.queries[0].params).toEqual([42]);
    expect(h.enqueuePost).toHaveBeenCalledOnce();
    expect(h.enqueuePost).toHaveBeenCalledWith(
      42,
      7,
      "Новость\n\nТекст\n\nhttps://example.com/1",
      "2023-11-14T22:18:20.000Z",
      { rssItemId: 100, feedId: 1, aiUsageReservationId: null },
    );
    expect(result).toEqual({ feeds: 1, posts: 1 });
  });

  it("ручная проверка канала не затрагивает ленты других каналов пользователя", async () => {
    const feed = {
      id: 1,
      url: "https://example.com/a.xml",
      channel_id: 18,
      user_id: 42,
      ai_summarize: false,
      max_per_day: 3,
      posted_today: 0,
    };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "Новость", link: "https://example.com/1", summary: "Текст", guid: "1" }]),
    });

    await collectRssPipeline({ ...h, userId: 42, channelId: 18 });

    expect(h.queries[0].sql).toContain("f.user_id = $1");
    expect(h.queries[0].sql).toContain("f.channel_id = $2");
    expect(h.queries[0].params).toEqual([42, 18]);
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

  it("разносит несколько RSS-постов одного канала по времени", async () => {
    const feed = { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 2, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([
        { title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" },
        { title: "A2", link: "https://a.test/2", summary: "Beta", guid: "a2" },
      ]),
    });

    await collectRssPipeline({ ...h, now: () => 1_700_000_000_000 });

    expect(h.enqueuePost.mock.calls.map((call) => call[3])).toEqual([
      "2023-11-14T22:18:20.000Z",
      "2023-11-14T22:33:20.000Z",
    ]);
  });

  it("не ставит в календарь больше трёх RSS-постов канала за сутки", async () => {
    const feeds = [
      { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 3, posted_today: 0, channel_posted_today: 2 },
      { id: 2, url: "https://b.test/rss", channel_id: 11, user_id: 1, ai_summarize: false, max_per_day: 3, posted_today: 0, channel_posted_today: 2 },
    ];
    const h = harness(feeds, {
      [feeds[0].url]: rss([{ title: "A", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
      [feeds[1].url]: rss([{ title: "B", link: "https://b.test/1", summary: "Beta", guid: "b1" }]),
    });

    const result = await collectRssPipeline({ ...h });

    expect(result.posts).toBe(1);
    expect(h.enqueuePost).toHaveBeenCalledOnce();
    expect(h.queries).toContainEqual({
      sql: "update rss_items set status = 'skipped', skip_reason = 'limit' where id = $1",
      params: [101],
    });
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
    expect(h.queries).toContainEqual({
      sql: "update rss_items set status = 'skipped', skip_reason = 'limit' where id = $1",
      params: [101],
    });
  });

  it("сохраняет нерелевантный элемент как skipped и не ставит его в publish queue", async () => {
    const feed = { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    const summarize = vi.fn().mockResolvedValueOnce(`  \n${RSS_IRRELEVANT_MARKER}\n  `);

    const result = await collectRssPipeline({ ...h, summarize });

    expect(result.posts).toBe(0);
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries).toContainEqual({
      sql: "update rss_items set status = 'skipped', skip_reason = 'irrelevant' where id = $1",
      params: [100],
    });
    expect(h.queries.some((q) => q.sql.includes("delete from rss_items"))).toBe(false);
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

  it("не публикует сырой RSS-текст и сохраняет GUID для детерминированного повтора, если ИИ отклонил запрос", async () => {
    const feed = { id: 1, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "Секретный заголовок", link: "https://a.test/1", summary: "Секретный текст", guid: "a1" }]),
    });
    const summarize = vi.fn().mockRejectedValueOnce(new Error("provider failed with source content"));

    const result = await collectRssPipeline({ ...h, summarize });

    expect(result.posts).toBe(0);
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.sql.includes("delete from rss_items"))).toBe(false);
    expect(h.queries.find((q) => q.sql.includes("insert into rss_items"))?.sql)
      .toContain("where rss_items.status = 'new'");
    expect(h.logger.error).toHaveBeenCalledWith(
      "[rss] ИИ-адаптация не выполнена: feed=1, item=100, reason=failed",
    );
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("Секретный");
    expect(JSON.stringify(h.logger.error.mock.calls)).not.toContain("source content");
  });

  it("не публикует сырой RSS-текст и сохраняет GUID при пустом ответе ИИ", async () => {
    const feed = { id: 2, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    const summarize = vi.fn().mockResolvedValueOnce("   \n  ");

    const result = await collectRssPipeline({ ...h, summarize });

    expect(result.posts).toBe(0);
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.sql.includes("delete from rss_items"))).toBe(false);
    expect(h.logger.error).toHaveBeenCalledWith(
      "[rss] ИИ-адаптация не выполнена: feed=2, item=100, reason=empty",
    );
  });

  it("не публикует сырой RSS-текст и сохраняет GUID, если summarize не передан", async () => {
    const feed = { id: 3, url: "https://a.test/rss", channel_id: 11, user_id: 1, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });

    const result = await collectRssPipeline(h);

    expect(result.posts).toBe(0);
    expect(h.enqueuePost).not.toHaveBeenCalled();
    expect(h.queries.some((q) => q.sql.includes("delete from rss_items"))).toBe(false);
    expect(h.logger.error).toHaveBeenCalledWith(
      "[rss] ИИ-адаптация не выполнена: feed=3, item=100, reason=unavailable",
    );
  });

  it("передаёт reservation в атомарную запись поста и завершает lifecycle ровно один раз", async () => {
    const feed = { id: 4, url: "https://a.test/rss", channel_id: 11, user_id: 7, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    const usage = { reservationId: 771, commit: vi.fn(), finish: vi.fn() };
    const summarize = vi.fn().mockResolvedValue({ text: "Готовый пост", usage });
    h.enqueuePost.mockResolvedValue({ postId: 901, rssLinked: true, aiUsageCommitted: true });

    await collectRssPipeline({ ...h, summarize });

    expect(h.enqueuePost).toHaveBeenCalledWith(
      7,
      11,
      "Готовый пост\n\nhttps://a.test/1",
      expect.any(String),
      { rssItemId: 100, feedId: 4, aiUsageReservationId: 771 },
    );
    expect(usage.commit).not.toHaveBeenCalled();
    expect(usage.finish).toHaveBeenCalledOnce();
    expect(usage.finish).toHaveBeenCalledWith(true);
  });

  it("коммитит успешный verdict irrelevant как один учтённый AI-результат", async () => {
    const feed = { id: 5, url: "https://a.test/rss", channel_id: 11, user_id: 7, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    const usage = {
      reservationId: 772,
      commit: vi.fn().mockResolvedValue(true),
      finish: vi.fn(),
    };

    await collectRssPipeline({
      ...h,
      summarize: vi.fn().mockResolvedValue({ text: RSS_IRRELEVANT_MARKER, usage }),
    });

    expect(usage.commit).toHaveBeenCalledOnce();
    expect(usage.finish).toHaveBeenCalledOnce();
    expect(usage.finish).toHaveBeenCalledWith(true);
    expect(h.enqueuePost).not.toHaveBeenCalled();
  });

  it("releases, а не коммитит reservation, если scheduled post не сохранился", async () => {
    const feed = { id: 6, url: "https://a.test/rss", channel_id: 11, user_id: 7, ai_summarize: true, max_per_day: 1, posted_today: 0 };
    const h = harness([feed], {
      [feed.url]: rss([{ title: "A1", link: "https://a.test/1", summary: "Alpha", guid: "a1" }]),
    });
    const usage = { reservationId: 773, commit: vi.fn(), finish: vi.fn() };
    h.enqueuePost.mockRejectedValueOnce(new Error("database unavailable"));

    await collectRssPipeline({
      ...h,
      summarize: vi.fn().mockResolvedValue({ text: "Готовый пост", usage }),
    });

    expect(usage.finish).toHaveBeenCalledOnce();
    expect(usage.finish).toHaveBeenCalledWith(false);
    expect(h.queries.some((q) => q.sql.includes("delete from rss_items"))).toBe(false);
  });
});
