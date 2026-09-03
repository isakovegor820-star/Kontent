import { describe, expect, it } from "vitest";

import { buildProbeQuestions, extractMentions, summarizeProbeRun } from "./questions.mjs";

const profile = {
  topics: [{ key: "имплантация", label: "имплантация" }, { key: "отбеливание", label: "отбеливание" }],
  gaps: [
    { key: "question_without_answer:x", kind: "question_without_answer", label: "Больно ли отбеливать зубы?" },
    { key: "schema_missing:organization", kind: "schema_missing", label: "Нет Organization" },
  ],
};

describe("buildProbeQuestions", () => {
  it("prefers audience questions, then gaps, then topic templates, without the brand name", () => {
    const questions = buildProbeQuestions({
      profile,
      brandName: "Клиника Улыбка",
      domain: "ulybka.ru",
      audienceQuestions: [
        { question: "Сколько стоит имплантация в Клиника Улыбка", occurrences: 9 },
        { question: "Как долго заживает имплант", occurrences: 4 },
        { question: "как долго заживает имплант?", occurrences: 1 },
      ],
    });
    const texts = questions.map((item) => item.text);
    expect(texts[0]).toBe("Как долго заживает имплант?");
    expect(texts).toContain("Больно ли отбеливать зубы?");
    expect(texts.some((text) => text.includes("Улыбка"))).toBe(false);
    expect(texts.some((text) => text.includes("имплантация"))).toBe(true);
    expect(new Set(questions.map((item) => item.key)).size).toBe(questions.length);
    expect(questions.length).toBeLessThanOrEqual(12);
    const again = buildProbeQuestions({ profile, brandName: "Клиника Улыбка", domain: "ulybka.ru", audienceQuestions: [{ question: "Как долго заживает имплант", occurrences: 4 }] });
    expect(again[0].key).toBe(questions[0].key);
  });

  it("caps the registry size", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({ question: `Вопрос номер ${index} про зубы`, occurrences: 30 - index }));
    expect(buildProbeQuestions({ profile, audienceQuestions: many })).toHaveLength(12);
    expect(buildProbeQuestions({ profile, audienceQuestions: many, maxQuestions: 3 })).toHaveLength(3);
  });
});

describe("extractMentions", () => {
  it("detects brand, own domain and competitors by name and domain", () => {
    const mention = extractMentions({
      answer: "Обычно советуют Клинику Улыбка (ulybka.ru) и Дента-Люкс, а также смотрят отзывы на prodoctorov.ru и сайт stom-city.ru.",
      brandName: "Клиника Улыбка",
      domain: "www.ulybka.ru",
      competitorNames: ["Дента-Люкс", "Стом Сити"],
    });
    expect(mention.brandMentioned).toBe(false);
    expect(mention.siteCited).toBe(true);
    expect(mention.competitors.map((item) => item.name)).toEqual(expect.arrayContaining(["prodoctorov.ru", "stom-city.ru", "Дента-Люкс"]));
    expect(mention.competitors.some((item) => item.name === "ulybka.ru")).toBe(false);
    const exact = extractMentions({ answer: "Клиника Улыбка — один из вариантов.", brandName: "Клиника Улыбка", domain: "ulybka.ru" });
    expect(exact.brandMentioned).toBe(true);
    expect(exact.siteCited).toBe(false);
    const nothing = extractMentions({ answer: "Сравните несколько клиник и почитайте отзывы.", brandName: "Клиника Улыбка", domain: "ulybka.ru", competitorNames: ["Дента-Люкс"] });
    expect(nothing).toMatchObject({ brandMentioned: false, siteCited: false, competitors: [] });
  });
});

describe("summarizeProbeRun", () => {
  it("counts per question across engines and ranks competitors", () => {
    const rows = [
      { question_key: "a", engine: "e1", status: "answered", brand_mentioned: true, site_cited: false, competitors_mentioned: [{ name: "x.ru" }] },
      { question_key: "a", engine: "e2", status: "answered", brand_mentioned: false, site_cited: true, competitors_mentioned: [{ name: "x.ru" }, { name: "Y" }] },
      { question_key: "b", engine: "e1", status: "answered", brand_mentioned: false, site_cited: false, competitors_mentioned: [] },
      { question_key: "b", engine: "e2", status: "failed", brand_mentioned: false, site_cited: false, competitors_mentioned: [] },
      { question_key: "c", engine: "e1", status: "skipped_budget", brand_mentioned: false, site_cited: false, competitors_mentioned: [] },
    ];
    const summary = summarizeProbeRun(rows);
    expect(summary).toMatchObject({ questions: 2, answers: 3, skipped: 1, failed: 1, brandMentioned: 1, siteCited: 1 });
    expect(summary.engines.sort()).toEqual(["e1", "e2"]);
    expect(summary.competitorsTop).toEqual([{ name: "x.ru", mentions: 2 }, { name: "Y", mentions: 1 }]);
  });
});
