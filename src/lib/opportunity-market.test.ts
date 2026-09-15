import { describe, expect, it } from "vitest";

import {
  buildProfileFallbackCandidates,
  loadChannelMarketCandidates,
  marketRelevance,
  opportunityPriority,
  opportunityWindow,
  researchProfile,
} from "./opportunity-market.mjs";

describe("opportunity market", () => {
  it("matches public signals against the channel profile and respects exclusions", () => {
    const profile = researchProfile({
      niche: "Загородное строительство",
      rubrics: ["Выбор материалов"],
      excludedKeywords: ["криптовалюта"],
    });
    expect(marketRelevance(profile, "Материалы для загородного строительства")).toBeGreaterThan(20);
    expect(marketRelevance(profile, "Криптовалюта для инвесторов")).toBe(-1);
  });

  it("gives breaking news a short publishing window and evergreen ideas a long one", () => {
    const now = new Date("2026-09-15T10:00:00.000Z");
    const news = opportunityWindow("breaking_news", now, now);
    const evergreen = opportunityWindow("evergreen_gap", now, now);
    expect(news.publishBefore?.toISOString()).toBe("2026-09-16T10:00:00.000Z");
    expect(news.expiresAt.getTime()).toBeLessThan(evergreen.expiresAt.getTime());
  });

  it("always creates five bounded fallback ideas for a configured new channel", () => {
    const profile = researchProfile({ niche: "Юридическая практика", rubrics: ["Договоры"] });
    const candidates = buildProfileFallbackCandidates(profile, new Date("2026-09-15T10:00:00.000Z"));
    expect(candidates).toHaveLength(5);
    expect(new Set(candidates.map((item) => item.sourceId)).size).toBe(5);
    expect(candidates.every((item) => item.type === "evergreen_gap" && item.sourceCount === 0)).toBe(true);
  });

  it("weights relevance and market momentum without exceeding the 0–100 scale", () => {
    expect(opportunityPriority({ relevance: 100, momentum: 100, freshness: 100, whitespace: 100, fit: 100, evidence: 100 })).toBe(100);
    expect(opportunityPriority({ relevance: 0, momentum: 0, freshness: 0, whitespace: 0, fit: 0, evidence: 0 })).toBe(0);
  });

  it("clusters the same story from different public sources into one opportunity", async () => {
    const now = new Date("2026-09-15T10:00:00.000Z");
    const row = {
      id: 1,
      kind: "news",
      title: "Новые правила для AI-сервисов в малом бизнесе",
      summary: "AI-сервисы меняют процессы малого бизнеса",
      momentum_score: 60,
      trust_score: 70,
      published_at: "2026-09-15T08:00:00.000Z",
      last_seen_at: "2026-09-15T09:00:00.000Z",
      source_count: 1,
      sources: [{ url: "https://one.example/story", label: "One", trust: 70 }],
    };
    const db = {
      query: async () => ({ rows: [
        row,
        { ...row, id: 2, sources: [{ url: "https://two.example/story", label: "Two", trust: 80 }] },
      ] }),
    } as unknown as Parameters<typeof loadChannelMarketCandidates>[0];
    const profile = researchProfile({ niche: "AI-сервисы для малого бизнеса" });
    const candidates = await loadChannelMarketCandidates(db, { projectId: 1, channelId: 2 }, profile, now);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceCount).toBe(2);
    expect(candidates[0].sources.map((source) => source.url)).toEqual([
      "https://two.example/story",
      "https://one.example/story",
    ]);
  });
});
