import { describe, expect, it } from "vitest";

import {
  buildProfileFallbackCandidates,
  candidateRelevance,
  loadChannelMarketCandidates,
  marketRelevance,
  opportunityPriority,
  opportunityWindow,
  researchProfile,
  webResearchSignalInput,
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

describe("перенос фактов из интернета в сигналы рынка", () => {
  const retrievedAt = "2026-10-01T12:00:00.000Z";
  const base = {
    id: 7, fingerprint: "wf-abc-12", kind: "law",
    claim: "Федеральный закон вступает в силу с 1 марта 2027 года",
    quote: "вступает в силу с 1 марта 2027 года",
    legal_status: "in_force", source_url: "https://publication.pravo.gov.ru/document/1",
    source_domain: "pravo.gov.ru", source_label: "Официальный интернет-портал правовой информации",
    source_tier: "official", source_trust: 95, corroboration_count: 0,
    published_at: "2026-09-30T09:00:00.000Z", retrieved_at: retrievedAt,
  };

  it("ставит датой сигнала момент обнаружения, а не дату публикации", () => {
    const input = webResearchSignalInput(base);
    expect(input.publishedAt).toBe(retrievedAt);
    expect(input.lastSeenAt).toBe(retrievedAt);
    expect(input.rawMetadata.sourcePublishedAt).toBe("2026-09-30T09:00:00.000Z");
  });

  it("даёт норме права и бенчмарку долгоживущее окно", () => {
    expect(webResearchSignalInput(base).kind).toBe("evergreen_gap");
    expect(webResearchSignalInput({ ...base, kind: "benchmark" }).kind).toBe("evergreen_gap");
    expect(webResearchSignalInput({ ...base, kind: "statistics" }).kind).toBe("evergreen_gap");
  });

  it("свежее событие становится новостью, а недавнее — растущей темой", () => {
    const fresh = { ...base, kind: "event", published_at: "2026-10-01T06:00:00.000Z" };
    expect(webResearchSignalInput(fresh).kind).toBe("news");
    const weekOld = { ...base, kind: "market", published_at: "2026-09-26T12:00:00.000Z" };
    expect(webResearchSignalInput(weekOld).kind).toBe("rising_topic");
  });

  it("официальный источник даёт больший импульс, чем открытый", () => {
    const official = webResearchSignalInput(base);
    const open = webResearchSignalInput({ ...base, source_tier: "open", source_trust: 40 });
    expect(official.momentum).toBeGreaterThan(open.momentum);
    expect(official.trust).toBe(95);
    expect(open.trust).toBe(40);
  });

  it("сохраняет подтверждение и цитату для интерфейса", () => {
    const input = webResearchSignalInput({ ...base, corroboration_count: 2 });
    expect(input.rawMetadata.corroborationCount).toBe(2);
    expect(input.rawMetadata.quote).toContain("вступает в силу");
    expect(input.rawMetadata.legalStatus).toBe("in_force");
    expect(input.provider).toBe("web-research:official");
    expect(input.key).toBe("web-research:wf-abc-12");
  });

  it("заменяет слишком короткий заголовок цитатой", () => {
    const input = webResearchSignalInput({ ...base, claim: "Закон", quote: "Федеральный закон вступает в силу с 1 марта" });
    expect(input.title.length).toBeGreaterThan(3);
  });
});

describe("релевантность факта из интернета", () => {
  const profile = researchProfile({
    niche: "Юридическая практика для малого бизнеса",
    rubrics: ["Договоры", "Проверки"],
  });

  it("обычный сигнал без лексического совпадения отбрасывается", () => {
    const relevance = candidateRelevance(profile, "Федеральный закон вступает в силу с 1 марта", "");
    expect(relevance).toBeLessThan(25);
  });

  it("проверенный факт из интернета доходит до выдачи, даже когда словá не совпали", () => {
    const relevance = candidateRelevance(
      profile,
      "Федеральный закон вступает в силу с 1 марта",
      "",
      { webResearchFingerprint: "wf-abc-12" },
    );
    expect(relevance).toBeGreaterThanOrEqual(25);
    expect(relevance).toBe(32);
  });

  it("не завышает релевантность уже совпавшего факта", () => {
    const title = "Договоры и проверки малого бизнеса";
    const lexical = candidateRelevance(profile, title, "", null);
    const boosted = candidateRelevance(profile, title, "", { webResearchFingerprint: "wf-abc-12" });
    expect(boosted).toBe(Math.max(lexical, 32));
    expect(boosted).toBeGreaterThanOrEqual(lexical);
  });

  it("факт из интернета остаётся ниже лексически совпавшего кандидата", () => {
    const matched = candidateRelevance(profile, "Договоры для малого бизнеса", "проверки", null);
    const unmatched = candidateRelevance(profile, "Федеральный закон вступает в силу", "", { webResearchFingerprint: "wf-1" });
    expect(unmatched).toBeLessThanOrEqual(Math.max(35, matched));
  });
});
