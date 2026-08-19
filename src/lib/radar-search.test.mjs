import { describe, expect, it, vi } from "vitest";

import {
  buildRadarDiscoveryQueries,
  competitorDiscoveryQuery,
  createBingRssTelegramProvider,
  createDuckDuckGoTelegramProvider,
  createSearxngTelegramProvider,
  discoverTelegramCandidates,
  normalizeRadarQuery,
  normalizeTelegramCandidate,
  parseTelegramCandidates,
  rankVerifiedTelegramSource,
  rankVerifiedTelegramSourceAcrossQueries,
  scoreRadarRelevance,
  scoreRadarSemanticSimilarity,
} from "./radar-search.mjs";

describe("radar hybrid-search core", () => {
  it("normalizes arbitrary Russian queries without losing their meaning", () => {
    expect(normalizeRadarQuery("  Рыбалка — на Волге!!! ")).toBe("рыбалка на волге");
  });

  it("builds a competitor web-search query from the channel brief, not from invented handles", () => {
    expect(competitorDiscoveryQuery({
      niche: "Банкротство бизнеса",
      audience: "Собственники",
      channelTitle: "Правовой канал",
    })).toBe("банкротство бизнеса");
    expect(competitorDiscoveryQuery({
      audience: "Садоводы",
      channelTitle: "Дача",
    })).toBe("садоводы");
    expect(competitorDiscoveryQuery({})).toBe("");
  });

  it("accepts only canonical public Telegram channel and post links", () => {
    expect(normalizeTelegramCandidate("https://t.me/s/fishing_ru/42?single")).toMatchObject({
      handle: "fishing_ru",
      messageId: 42,
      canonicalUrl: "https://t.me/fishing_ru/42",
    });
    expect(normalizeTelegramCandidate("https://t.me/+privateInvite")).toBeNull();
    expect(normalizeTelegramCandidate("https://example.com/fishing_ru")).toBeNull();
  });

  it("deduplicates channel, preview and post URLs from a web-search response", () => {
    const results = parseTelegramCandidates(`
      <a href="https://t.me/fishing_ru">one</a>
      <a href="https://t.me/s/fishing_ru/42">two</a>
      <link>https://t.me/garden_people</link>
    `, "test");
    expect(results.map((item) => item.handle)).toEqual(["fishing_ru", "garden_people"]);
  });

  it("does not truncate a large set of public candidates", () => {
    const payload = Array.from(
      { length: 140 },
      (_, index) => `<a href="https://t.me/public_source_${String(index).padStart(3, "0")}">source</a>`,
    ).join("\n");
    expect(parseTelegramCandidates(payload, "test")).toHaveLength(140);
  });

  it("uses a configured local SearXNG instance through the same provider contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: "https://t.me/s/fishing_ru", content: "Рыбалка" }] }),
    });
    const provider = createSearxngTelegramProvider({ endpoint: "http://127.0.0.1:8080", fetchImpl });
    await expect(provider.search("рыбалка")).resolves.toMatchObject([{ handle: "fishing_ru" }]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("format=json");
  });

  it("walks SearXNG pages until the provider is exhausted", async () => {
    const fetchImpl = vi.fn(async (url) => {
      const page = Number(new URL(String(url)).searchParams.get("pageno"));
      return {
        ok: true,
        json: async () => ({
          number_of_results: 3,
          results: page <= 3
            ? [{ url: `https://t.me/s/public_page_${page}`, content: "Строительство" }]
            : [],
        }),
      };
    });
    const provider = createSearxngTelegramProvider({ endpoint: "http://127.0.0.1:8080", fetchImpl });
    await expect(provider.search("строительство")).resolves.toHaveLength(3);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("uses broad channel wording when a search engine ignores site:t.me", async () => {
    const response = {
      ok: true,
      text: async () => '<a href="https://t.me/russiabuild">Строительство</a>',
    };
    const bingFetch = vi.fn().mockResolvedValue(response);
    const duckFetch = vi.fn().mockResolvedValue(response);
    await expect(createBingRssTelegramProvider({ fetchImpl: bingFetch }).search("строительство"))
      .resolves.toMatchObject([{ handle: "russiabuild" }]);
    await expect(createDuckDuckGoTelegramProvider({ fetchImpl: duckFetch }).search("строительство"))
      .resolves.toMatchObject([{ handle: "russiabuild" }]);
    expect(String(bingFetch.mock.calls[0][0])).toContain("Telegram+%D0%BA%D0%B0%D0%BD%D0%B0%D0%BB%D1%8B");
    expect(String(duckFetch.mock.calls[0][0])).toContain("Telegram+%D0%BA%D0%B0%D0%BD%D0%B0%D0%BB%D1%8B");
  });

  it("falls back to another free provider without inventing a handle", async () => {
    const failed = { name: "failed", search: vi.fn().mockRejectedValue(new Error("offline")) };
    const working = { name: "working", search: vi.fn().mockResolvedValue([
      normalizeTelegramCandidate("https://t.me/garden_people"),
    ]) };
    await expect(discoverTelegramCandidates("садоводство", { providers: [failed, working] }))
      .resolves.toMatchObject([{ handle: "garden_people" }]);
  });

  it("searches every bounded semantic formulation and merges providers", async () => {
    const provider = {
      name: "search",
      search: vi.fn(async (query) => query.includes("девелопмент")
        ? [{ ...normalizeTelegramCandidate("https://t.me/block_media"), provider: "search" }]
        : []),
    };
    const results = await discoverTelegramCandidates("строительство", {
      providers: [provider],
      expandedQueries: ["девелопмент", "жилые комплексы", "девелопмент"],
    });
    expect(provider.search).toHaveBeenCalledTimes(3);
    expect(results).toMatchObject([{
      handle: "block_media",
      matchedQuery: "девелопмент",
      matchedQueries: ["девелопмент"],
    }]);
    expect(buildRadarDiscoveryQueries("Строительство", ["Девелопмент", "строительство"]))
      .toEqual(["строительство", "девелопмент"]);
  });

  it("turns a natural-language request into a compact content query without AI", () => {
    expect(buildRadarDiscoveryQueries("Найди мне каналы, где пишут про строительство"))
      .toEqual([
        "найди мне каналы где пишут про строительство",
        "строительство",
      ]);
  });

  it("keeps every unique semantic formulation instead of applying a query cap", () => {
    const expanded = Array.from({ length: 18 }, (_, index) => `термин${index}`);
    expect(buildRadarDiscoveryQueries("строительство", expanded)).toHaveLength(19);
  });

  it("accepts a verified source through a transparent close formulation", () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    const rank = rankVerifiedTelegramSourceAcrossQueries("строительство", ["девелопмент"], {
      ok: true,
      title: "Блок",
      description: "Девелопмент и городская среда",
      subscribers: 9000,
      posts: [{ text: "Новости девелопмента", postedAt: "2026-08-05T10:00:00.000Z" }],
      activity: { lastPostAt: "2026-08-05T10:00:00.000Z", postsPerWeek: 4 },
    }, now);
    expect(rank).toMatchObject({ accepted: true, matchedQuery: "девелопмент" });
    expect(rank.reason).toContain("близкой формулировке");
  });

  it("accepts a channel whose post corpus matches the query semantically", () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    expect(scoreRadarSemanticSimilarity(0.65)).toBeGreaterThan(75);
    const rank = rankVerifiedTelegramSource("строительство", {
      ok: true,
      title: "Блок",
      description: "Авторский журнал",
      subscribers: 9000,
      posts: [{ text: "Новые жилые комплексы и работа девелоперов", postedAt: "2026-08-05T10:00:00.000Z" }],
      activity: { lastPostAt: "2026-08-05T10:00:00.000Z", postsPerWeek: 4 },
      semanticSimilarity: 0.65,
    }, now);
    expect(rank).toMatchObject({ accepted: true });
    expect(rank.reason).toContain("по смыслу");
  });

  it("rejects a live but irrelevant channel and rewards fresh matching posts", () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    const relevant = {
      ok: true,
      title: "Рыбалка круглый год",
      description: "Снасти, водоёмы и рыболовные отчёты",
      subscribers: 12000,
      posts: [
        { text: "Как выбрать снасти для летней рыбалки", postedAt: "2026-08-05T10:00:00.000Z" },
        { text: "Отчёт о рыбалке на Волге", postedAt: "2026-08-03T10:00:00.000Z" },
      ],
      activity: { lastPostAt: "2026-08-05T10:00:00.000Z", postsPerWeek: 4 },
    };
    const irrelevant = { ...relevant, title: "Маркетинг", description: "Реклама", posts: [{ text: "Продажи через рекламу" }] };
    expect(scoreRadarRelevance("рыбалка", relevant)).toBeGreaterThan(70);
    expect(rankVerifiedTelegramSource("рыбалка", relevant, now)).toMatchObject({ accepted: true });
    expect(rankVerifiedTelegramSource("рыбалка", irrelevant, now)).toMatchObject({ accepted: false });
  });

  it("treats one incidental mention in a long unrelated post as noise", () => {
    const legalText = `${"Разбор судебной практики по банкротству и реализации имущества. ".repeat(16)} Земельный участок для садоводства включён в конкурсную массу.`;
    expect(scoreRadarRelevance("садоводство", { title: "Судебная практика", posts: [{ text: legalText }] }))
      .toBeLessThan(35);
    expect(scoreRadarRelevance("садоводство", {
      title: "Школа садоводства",
      posts: [{ text: legalText }],
    })).toBeGreaterThan(60);
  });

  it("keeps an old but relevant public channel in the exhaustive search", () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    const rank = rankVerifiedTelegramSource("садоводство", {
      ok: true,
      title: "Садоводство",
      description: "Советы по садоводству",
      subscribers: 10,
      posts: [{ text: "Садоводство", postedAt: "2025-05-01T10:00:00.000Z" }],
      activity: { lastPostAt: "2025-05-01T10:00:00.000Z", postsPerWeek: 0.1 },
    }, now);
    expect(rank.accepted).toBe(true);
    expect(rank.freshness).toBeLessThan(30);
  });
});
