import { describe, expect, it, vi } from "vitest";

import {
  createSearxngTelegramProvider,
  discoverTelegramCandidates,
  normalizeRadarQuery,
  normalizeTelegramCandidate,
  parseTelegramCandidates,
  rankVerifiedTelegramSource,
  scoreRadarRelevance,
} from "./radar-search.mjs";

describe("radar hybrid-search core", () => {
  it("normalizes arbitrary Russian queries without losing their meaning", () => {
    expect(normalizeRadarQuery("  Рыбалка — на Волге!!! ")).toBe("рыбалка на волге");
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

  it("uses a configured local SearXNG instance through the same provider contract", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ results: [{ url: "https://t.me/s/fishing_ru", content: "Рыбалка" }] }),
    });
    const provider = createSearxngTelegramProvider({ endpoint: "http://127.0.0.1:8080", fetchImpl });
    await expect(provider.search("рыбалка")).resolves.toMatchObject([{ handle: "fishing_ru" }]);
    expect(String(fetchImpl.mock.calls[0][0])).toContain("format=json");
  });

  it("falls back to another free provider without inventing a handle", async () => {
    const failed = { name: "failed", search: vi.fn().mockRejectedValue(new Error("offline")) };
    const working = { name: "working", search: vi.fn().mockResolvedValue([
      normalizeTelegramCandidate("https://t.me/garden_people"),
    ]) };
    await expect(discoverTelegramCandidates("садоводство", { providers: [failed, working] }))
      .resolves.toMatchObject([{ handle: "garden_people" }]);
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

  it("does not publish an abandoned channel as a high-quality discovery result", () => {
    const now = Date.parse("2026-08-06T10:00:00.000Z");
    const rank = rankVerifiedTelegramSource("садоводство", {
      ok: true,
      title: "Садоводство",
      description: "Советы по садоводству",
      subscribers: 10,
      posts: [{ text: "Садоводство", postedAt: "2025-05-01T10:00:00.000Z" }],
      activity: { lastPostAt: "2025-05-01T10:00:00.000Z", postsPerWeek: 0.1 },
    }, now);
    expect(rank.accepted).toBe(false);
  });
});
