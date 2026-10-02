import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { GuideArticle } from "@/components/guide/guide-article";
import { GUIDES, guideBySlug } from "@/lib/guides/articles";

const render = (slug: string) => {
  const guide = guideBySlug(slug);
  if (!guide) throw new Error(`нет разбора: ${slug}`);
  return renderToStaticMarkup(createElement(GuideArticle, { guide }));
};

describe("guide article layout", () => {
  it("renders every guide with its answer, questions and sources without JavaScript", () => {
    for (const guide of GUIDES) {
      const markup = render(guide.slug);

      // Прямой ответ — до остальных блоков: его вырезает генеративный движок.
      const answerAt = markup.indexOf(guide.answer);
      const firstSectionAt = markup.indexOf(guide.sections[0].heading);
      expect(answerAt, guide.slug).toBeGreaterThan(-1);
      expect(firstSectionAt, guide.slug).toBeGreaterThan(answerAt);

      // Вопросы — заголовками, иначе они не становятся отдельным входом.
      for (const item of guide.faq) {
        expect(markup, `${guide.slug}: ${item.question}`).toContain(`<h3 class="text-[17px] font-semibold leading-snug text-text">${item.question}</h3>`);
        expect(markup, guide.slug).toContain(item.answer);
      }

      // Источники — ссылками с rel="noreferrer nofollow": чужие страницы не должны
      // получать вес от нашего домена, но читатель обязан дойти до первоисточника.
      for (const source of guide.sources) {
        expect(markup, `${guide.slug}: ${source.url}`).toContain(source.url);
      }
      expect(markup, guide.slug).toContain('rel="noreferrer nofollow"');

      expect(markup, guide.slug).toContain(`Обновлено: ${guide.updatedAt}`);
      expect(markup, guide.slug).toContain("не являются юридической консультацией");
    }
  });

  it("keeps tables as real tables so they can be read and quoted", () => {
    for (const guide of GUIDES) {
      const tables = guide.sections.filter((section) => section.table).length;
      if (tables === 0) continue;
      const markup = render(guide.slug);
      expect(markup.split("<table").length - 1, guide.slug).toBe(tables);
      for (const section of guide.sections) {
        for (const head of section.table?.head ?? []) {
          expect(markup, `${guide.slug}: ${head}`).toContain(head);
        }
      }
    }
  });

  it("computes reading time from the text instead of hardcoding it", () => {
    const markup = render("pochemu-ne-citiruetsya");
    const match = markup.match(/чтение (\d+) мин/u);
    expect(match).not.toBeNull();
    // Число выведено из объёма текста, поэтому оно не ноль и не абсурдно велико.
    expect(Number(match?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(match?.[1])).toBeLessThanOrEqual(30);
  });

  it("does not leave a placeholder author name in the article", () => {
    for (const guide of GUIDES) {
      const markup = render(guide.slug);
      expect(markup, guide.slug).not.toContain("Имя Фамилия");
      expect(markup, guide.slug).not.toMatch(/\[НУЖНО|TODO|Lorem ipsum/iu);
    }
  });
});
