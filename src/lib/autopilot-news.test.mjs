import { describe, expect, it } from "vitest";

import {
  appendAutopilotSourceFooter,
  autopilotNewsEvidence,
  buildAutopilotNewsCandidates,
  normalizeAutopilotNewsSources,
} from "./autopilot-news.mjs";

const NOW = Date.parse("2026-08-21T12:00:00.000Z");
const source = {
  id: "cbr",
  title: "Банк России",
  url: "https://example.com/feed.xml",
  category: "Финансы",
  language: "RU",
  score: 42,
  reason: "Подходит к теме «Финансы»",
};

describe("Autopilot news discovery", () => {
  it("keeps only safe unique source URLs", () => {
    expect(normalizeAutopilotNewsSources([
      source,
      { ...source, id: "duplicate" },
      { id: "bad", title: "Bad", url: "javascript:alert(1)" },
    ])).toEqual([source]);
  });

  it("prefers fresh relevant and announced events", () => {
    const candidates = buildAutopilotNewsCandidates([
      {
        source,
        items: [
          {
            guid: "fresh",
            title: "В сентябре пройдёт день цифрового рубля",
            summary: "Банк России объявил программу события для финансового рынка и предпринимателей.",
            link: "https://example.com/fresh",
            publishedAt: "2026-08-21T10:00:00.000Z",
          },
          {
            guid: "old",
            title: "Старое решение",
            summary: "Материал был опубликован давно и больше не является свежей новостью.",
            link: "https://example.com/old",
            publishedAt: "2026-08-01T10:00:00.000Z",
          },
        ],
      },
    ], { context: "Финансы для предпринимателей", now: NOW });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ sourceTitle: "Банк России", kind: "news" });
    expect(candidates[0].title).toContain("цифрового рубля");
  });

  it("turns a candidate into semantic evidence with a stable safe id", () => {
    const [candidate] = buildAutopilotNewsCandidates([{
      source,
      items: [{
        guid: "one",
        title: "Регулятор объявил новое событие",
        summary: "Событие состоится в сентябре и будет посвящено платёжным технологиям.",
        link: "https://example.com/event",
        publishedAt: "2026-08-21T10:00:00.000Z",
      }],
    }], { now: NOW });

    expect(autopilotNewsEvidence(candidate)).toMatchObject({
      id: expect.stringMatching(/^news-[a-f0-9]{20}$/),
      kind: "news",
      url: "https://example.com/event",
    });
  });

  it("adds a compact source footer without exceeding the post limit", () => {
    const body = "Полезный контекст. ".repeat(80).trim();
    const result = appendAutopilotSourceFooter(body, [{ title: "Банк России", url: "https://example.com/event" }], 700);
    expect(result.length).toBeLessThanOrEqual(700);
    expect(result).toContain("Источник: Банк России");
    expect(result).toContain("https://example.com/event");
  });
});
