import { describe, expect, it } from "vitest";

import { GUIDES, guideBreadcrumb, guideBySlug, guideSlugs } from "./articles";

const wordCount = (value: string) => value.split(/\s+/u).filter(Boolean).length;

describe("guide pages", () => {
  it("has unique slugs and resolves every one of them", () => {
    const slugs = guideSlugs();
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const slug of slugs) {
      expect(guideBySlug(slug)?.slug).toBe(slug);
    }
    expect(guideBySlug("nesushchestvuyushchiy")).toBeUndefined();
  });

  it("opens every guide with a direct answer of 40 to 60 words", () => {
    for (const guide of GUIDES) {
      const words = wordCount(guide.answer);
      expect(words, `${guide.slug}: ${words} слов`).toBeGreaterThanOrEqual(40);
      expect(words, `${guide.slug}: ${words} слов`).toBeLessThanOrEqual(60);
      // Ответ должен начинаться с законченной мысли, а не с «в этой статье мы рассмотрим».
      expect(guide.answer).not.toMatch(/в этой статье|мы рассмотрим|данная статья/iu);
    }
  });

  it("keeps meta title inside the search snippet and description inside the limit", () => {
    for (const guide of GUIDES) {
      expect(guide.metaTitle.length, guide.slug).toBeLessThanOrEqual(65);
      expect(guide.description.length, guide.slug).toBeGreaterThanOrEqual(120);
      expect(guide.description.length, guide.slug).toBeLessThanOrEqual(200);
    }
  });

  it("carries at least five questions and a real source for every factual claim", () => {
    for (const guide of GUIDES) {
      expect(guide.faq.length, guide.slug).toBeGreaterThanOrEqual(5);
      expect(guide.sources.length, guide.slug).toBeGreaterThanOrEqual(1);
      for (const source of guide.sources) {
        expect(source.url, guide.slug).toMatch(/^https:\/\//u);
        expect(source.label.length, guide.slug).toBeGreaterThan(10);
      }
      for (const item of guide.faq) {
        expect(item.question.endsWith("?"), `${guide.slug}: ${item.question}`).toBe(true);
        expect(item.answer.length, guide.slug).toBeGreaterThan(60);
      }
    }
  });

  it("says who the page is for and when it was updated", () => {
    for (const guide of GUIDES) {
      expect(guide.audience.length, guide.slug).toBeGreaterThan(40);
      expect(guide.updatedAt, guide.slug).toMatch(/^\d{1,2} [а-яё]+ \d{4}$/u);
    }
  });

  it("does not promise ranking growth or guaranteed results", () => {
    // Обещания результата запрещены и юридически, и репутационно: их нельзя выполнить.
    const banned = /гарантируем|гарантированн|выведем в топ|100%|за первую неделю|быстрый результат/iu;
    for (const guide of GUIDES) {
      const text = [
        guide.title,
        guide.answer,
        guide.description,
        ...guide.sections.flatMap((section) => [
          ...(section.body ?? []),
          ...(section.list ?? []),
          ...(section.steps ?? []).flatMap((step) => [step.title, step.text]),
          ...(section.table?.rows ?? []).flat(),
        ]),
        ...guide.faq.flatMap((item) => [item.question, item.answer]),
      ].join(" ");
      expect(text, guide.slug).not.toMatch(banned);
    }
  });

  it("builds breadcrumbs from the product root down to the article", () => {
    for (const guide of GUIDES) {
      const crumbs = guideBreadcrumb(guide);
      expect(crumbs[0].path).toBe("/");
      expect(crumbs[1].path).toBe("/guide");
      expect(crumbs[2].path).toBe(`/guide/${guide.slug}`);
      expect(crumbs[2].name).toBe(guide.title);
    }
  });

  it("cites the llms.txt study with a link, not as a bare number", () => {
    // Цифра 97% встречается на двух страницах. Без ссылки на первоисточник она
    // превращается в выдуманное утверждение, поэтому источник обязателен.
    for (const guide of GUIDES) {
      const mentions = JSON.stringify(guide).includes("97%");
      if (mentions) {
        expect(
          guide.sources.some((source) => source.url.includes("ahrefs.com")),
          `${guide.slug}: цифра без ссылки на первоисточник`,
        ).toBe(true);
      }
    }
  });
});
