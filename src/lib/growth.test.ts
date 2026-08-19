import { describe, expect, it } from "vitest";

import {
  buildGrowthDiagnosis,
  buildGrowthMoves,
  coversTopic,
  growthActionHref,
  growthFingerprint,
  growthWeekStart,
  previousGrowthWeekStart,
  tokenOverlap,
  type GrowthSignals,
} from "./growth";

function signals(overrides: Partial<GrowthSignals> = {}): GrowthSignals {
  return {
    ownPosts30d: [],
    ownPosts7d: 0,
    competitorCount: 0,
    competitorHits: [],
    competitorWeeklyMedian: null,
    siteOffer: null,
    audienceQuestion: null,
    ...overrides,
  };
}

describe("growth week", () => {
  it("starts on Monday in Moscow calendar time", () => {
    expect(growthWeekStart(new Date("2026-08-19T10:00:00+02:00"))).toBe("2026-08-17");
    expect(previousGrowthWeekStart("2026-08-17")).toBe("2026-08-10");
  });
});

describe("topic coverage", () => {
  it("treats overlapping case reviews as the same topic", () => {
    expect(tokenOverlap(
      "разобрали кейс договора поставки и ошибки сторон",
      "кейс договора поставки: какие ошибки повторяются",
    )).toBeGreaterThan(0.28);
    expect(coversTopic(
      [{ id: 1, text: "разобрали кейс договора поставки", publishedAt: "2026-08-01" }],
      "кейс договора поставки и типичные ошибки",
    )).toBe(true);
  });

  it("does not treat unrelated posts as coverage", () => {
    expect(coversTopic(
      [{ id: 1, text: "сегодня короткий статус по офису", publishedAt: "2026-08-01" }],
      "разбор судебной практики по интеллектуальной собственности",
    )).toBe(false);
  });
});

describe("growth diagnosis and moves", () => {
  it("builds at most three evidence-backed moves", () => {
    const next = buildGrowthMoves(signals({
      ownPosts7d: 2,
      ownPosts30d: [{ id: 1, text: "короткий статус", publishedAt: "2026-08-18" }],
      competitorCount: 3,
      competitorWeeklyMedian: 5,
      competitorHits: [{
        id: 41,
        text: "Разбор кейса по интеллектуальной собственности",
        views: 1200,
        handle: "legal_notes",
        title: "Правовые заметки",
      }],
      siteOffer: {
        jobId: 9,
        domain: "example.test",
        answer: "Консультация по договорам",
        landing: "https://example.test/consult",
      },
      audienceQuestion: { id: 7, question: "Сколько стоит первичная консультация?" },
    }));

    expect(next).toHaveLength(3);
    expect(next.map((move) => move.kind)).toEqual(["topic", "rhythm", "offer"]);
    expect(next.every((move) => move.fingerprint)).toBe(true);
    expect(next[0]?.prompt).not.toContain("Скопируй");
  });

  it("falls back to an audience question when topic, rhythm and offer are absent", () => {
    const next = buildGrowthMoves(signals({
      audienceQuestion: { id: 7, question: "Сколько стоит первичная консультация?" },
    }));
    expect(next).toHaveLength(1);
    expect(next[0]?.kind).toBe("audience");
    expect(next[0]?.prompt).toContain("Сколько стоит первичная консультация?");
  });

  it("names rhythm, topic and unused site offer without promising subscribers", () => {
    const { diagnosis } = buildGrowthDiagnosis(signals({
      ownPosts7d: 1,
      ownPosts30d: [{ id: 1, text: "короткий статус", publishedAt: "2026-08-18" }],
      competitorCount: 3,
      competitorWeeklyMedian: 5,
      competitorHits: [{
        id: 41,
        text: "Разбор кейса по интеллектуальной собственности",
        views: 1200,
        handle: "legal_notes",
        title: "Правовые заметки",
      }],
      siteOffer: {
        jobId: 9,
        domain: "example.test",
        answer: "Консультация по договорам",
      },
    }));
    const text = diagnosis.map((item) => item.text).join(" ");
    expect(text).toMatch(/реже конкурентов/u);
    expect(text).toMatch(/интеллектуальной собственности/u);
    expect(text).toMatch(/Консультация по договорам/u);
    expect(text).not.toMatch(/\+12%|подписчик/u);
  });

  it("explains empty competitor and site gaps without inventing an offer", () => {
    const { diagnosis, gaps } = buildGrowthDiagnosis(signals({
      competitorCount: 0,
      siteOffer: null,
    }));
    expect(diagnosis.some((item) => item.id === "offer")).toBe(false);
    expect(gaps.join(" ")).toMatch(/конкурентов/i);
    expect(gaps.join(" ")).toMatch(/сайта/i);
  });

  it("keeps action URLs on owned ids, not competitor text", () => {
    const href = growthActionHref({
      id: 18,
      kind: "topic",
      channelId: 4,
      sourceId: "41",
    });
    expect(href).toBe("/app/studio?growthMove=18&channel=4&intent=create");
    expect(growthActionHref({
      id: 19,
      kind: "rhythm",
      channelId: 4,
      sourceId: "7d",
    })).toBe("/app/autopilot?growthMove=19&channel=4");
    expect(growthActionHref({
      id: 20,
      kind: "audience",
      channelId: 4,
      sourceId: "7",
    })).toBe("/app/studio/questions");
    expect(href).not.toContain("text=");
    expect(growthFingerprint({
      kind: "topic",
      sourceKind: "competitor_post",
      sourceId: "41",
    })).toMatch(/^[0-9a-f]{64}$/u);
  });
});
