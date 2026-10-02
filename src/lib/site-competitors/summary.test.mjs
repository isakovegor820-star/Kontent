import { describe, expect, it } from "vitest";

import { buildCompetitorSummary, compareWithCompetitors } from "./summary.mjs";

function page(url, { words = 0, schema = [], clientRendered = false, status = 200 } = {}) {
  return {
    url,
    status,
    schemaTypes: schema,
    technical: { wordCount: words, clientRendered },
  };
}

describe("buildCompetitorSummary", () => {
  it("считает страницы, среднюю длину, разметку и темы", () => {
    const summary = buildCompetitorSummary({
      domain: "rival.ru",
      pages: [
        page("https://rival.ru/", { words: 300, schema: ["Organization"] }),
        page("https://rival.ru/uslugi", { words: 500, schema: ["Service"] }),
        page("https://rival.ru/closed", { status: 404 }),
      ],
      report: { themes: [{ theme: "банкротство", occurrences: 9 }, { theme: "налоги", occurrences: 4 }] },
    });

    expect(summary).toMatchObject({
      domain: "rival.ru",
      pages: 2,
      avgWords: 400,
      pagesWithSchema: 2,
      hasOrganization: true,
      hasFaq: false,
    });
    expect(summary.themes).toHaveLength(2);
  });

  it("не падает на пустом ответе и не выдумывает цифры", () => {
    const summary = buildCompetitorSummary({ domain: "empty.ru", pages: [] });
    expect(summary).toMatchObject({ pages: 0, avgWords: 0, pagesWithSchema: 0, hasOrganization: false, hasFaq: false });
    expect(summary.themes).toEqual([]);
  });

  it("отмечает страницы, которые рисует JavaScript", () => {
    const summary = buildCompetitorSummary({
      domain: "spa.ru",
      pages: [page("https://spa.ru/", { clientRendered: true }), page("https://spa.ru/about", { words: 200 })],
    });
    expect(summary.clientRenderedPages).toBe(1);
  });
});

describe("compareWithCompetitors", () => {
  const profile = {
    pageCount: 11,
    topics: [{ key: "bankrotstvo", label: "банкротство" }],
    technical: { avgWords: 180, pagesWithSchema: 0, hasOrganization: false, hasFaqSchema: false },
  };

  it("показывает темы конкурентов, которых нет у нас, и где текст длиннее", () => {
    const result = compareWithCompetitors(profile, [
      {
        domain: "rival.ru",
        status: "ready",
        summary: {
          pages: 30,
          avgWords: 420,
          pagesWithSchema: 12,
          hasOrganization: true,
          hasFaq: true,
          themes: [{ theme: "налоги", occurrences: 7 }, { theme: "банкротство", occurrences: 5 }],
        },
      },
    ]);

    expect(result.own).toMatchObject({ pages: 11, avgWords: 180, hasOrganization: false });
    expect(result.missingThemes).toEqual([{ theme: "налоги", competitor: "rival.ru" }]);
    expect(result.deeperCompetitors).toEqual([{ domain: "rival.ru", avgWords: 420 }]);
  });

  it("считает одной темой разные падежи одного слова", () => {
    const result = compareWithCompetitors(profile, [
      {
        domain: "rival.ru",
        status: "ready",
        summary: { pages: 5, avgWords: 100, themes: [{ theme: "банкротству", occurrences: 3 }, { theme: "налогам", occurrences: 3 }] },
      },
    ]);
    // «банкротству» — та же тема, что и «банкротство» в профиле
    expect(result.missingThemes).toEqual([{ theme: "налогам", competitor: "rival.ru" }]);
  });

  it("игнорирует конкурентов без готового снимка", () => {
    const result = compareWithCompetitors(profile, [
      { domain: "pending.ru", status: "pending", summary: null },
      { domain: "failed.ru", status: "error", summary: null },
    ]);
    expect(result.rows).toEqual([]);
    expect(result.missingThemes).toEqual([]);
    expect(result.deeperCompetitors).toEqual([]);
  });

  it("без профиля сайта отдаёт только строки конкурентов", () => {
    const result = compareWithCompetitors(null, [{ domain: "rival.ru", status: "ready", summary: { pages: 5, themes: [] } }]);
    expect(result.own).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.missingThemes).toEqual([]);
  });
});
