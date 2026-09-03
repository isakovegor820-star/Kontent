import { describe, expect, it } from "vitest";

import { buildSiteProfile, classifySitePages } from "./profile.mjs";

function page(url, overrides = {}) {
  return {
    url,
    status: 200,
    title: "Страница",
    description: "Описание",
    headings: [],
    mainContent: "",
    schemaTypes: [],
    links: [],
    ctas: [],
    forms: [],
    publicComments: [],
    metadata: {},
    technical: { wordCount: 50 },
    ...overrides,
  };
}

const words = (count) => Array.from({ length: count }, (_, index) => `слово${index}`).join(" ");

function dentalSite() {
  return [
    page("https://clinic.example/", {
      title: "Стоматология «Улыбка» — имплантация и лечение зубов",
      headings: [{ level: 1, text: "Стоматология в Казани" }, { level: 2, text: "Имплантация зубов" }],
      technical: { wordCount: 400 },
      schemaTypes: ["WebPage"],
    }),
    page("https://clinic.example/uslugi/implantaciya", {
      title: "Имплантация зубов — цены и этапы",
      headings: [{ level: 1, text: "Имплантация зубов" }, { level: 2, text: "Сколько стоит имплантация?" }],
      technical: { wordCount: 650 },
      schemaTypes: ["Service"],
    }),
    page("https://clinic.example/uslugi/otbelivanie", {
      title: "Отбеливание зубов — услуга клиники",
      headings: [{ level: 1, text: "Отбеливание зубов" }, { level: 2, text: "Больно ли отбеливать зубы?" }],
      technical: { wordCount: 60 },
    }),
    page("https://clinic.example/blog/implantaciya-posle-40", {
      title: "Статья: имплантация зубов после 40 лет",
      headings: [{ level: 1, text: "Имплантация после 40" }],
      technical: { wordCount: 900 },
      schemaTypes: ["Article"],
      metadata: { publishedAt: "2026-05-10T00:00:00Z" },
    }),
    page("https://clinic.example/kontakty", {
      title: "Контакты клиники",
      headings: [{ level: 1, text: "Контакты" }],
      technical: { wordCount: 80 },
    }),
    page("https://clinic.example/old-page", { status: 404, title: null }),
  ];
}

function crawlerReport() {
  return {
    optimization: {
      seo: {
        score: 72,
        status: "needs_work",
        checks: [
          { id: "title", label: "Title страниц", status: "passed", detail: "ok", recommendation: "—" },
          { id: "description", label: "Meta description", status: "warning", detail: "Без description: 2 из 5.", recommendation: "Добавить description отсутствующим страницам" },
          { id: "speed", label: "Скорость загрузки", status: "not_checked", detail: "Нужен Lighthouse", recommendation: "Измерить" },
        ],
      },
      geo: {
        score: 40,
        status: "needs_work",
        checks: [
          { id: "structure", label: "Структурированная информация", status: "warning", detail: "Сущности не найдены", recommendation: "Разметить организацию через Schema.org" },
        ],
      },
    },
    internalLinking: { orphanCandidates: [{ url: "https://clinic.example/old-page" }] },
  };
}

describe("buildSiteProfile", () => {
  it("classifies pages, counts publications and keeps failed pages out of coverage", () => {
    const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), report: crawlerReport() });
    expect(profile.profileVersion).toBe("site-profile-v1");
    expect(profile.pageCount).toBe(6);
    expect(profile.publicationCount).toBe(1);
    expect(profile.lastPublishedAt).toBe("2026-05-10T00:00:00.000Z");
    expect(profile.pageTypeCounts.article).toBe(1);
    // «цены» в title переводит страницу услуги в product — это правило классификатора анализа.
    expect(profile.pageTypeCounts.product).toBe(1);
    expect(profile.pageTypeCounts.service).toBe(1);
    expect(profile.pageTypeCounts.contact).toBe(1);
    expect(profile.technical.pagesChecked).toBe(5);
    expect(profile.technical.failedPages).toBe(1);
  });

  it("derives topics from titles and headings and marks depth of coverage", () => {
    const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), report: crawlerReport() });
    const implant = profile.topics.find((topic) => topic.key === "имплантация");
    expect(implant).toBeDefined();
    expect(implant.pageCount).toBe(3);
    expect(implant.coverage).toBe("strong");
    const teeth = profile.topics.find((topic) => topic.key === "зубов");
    expect(teeth.pageCount).toBeGreaterThanOrEqual(3);
    expect(profile.topics.every((topic) => topic.pageUrls.length <= 5)).toBe(true);
  });

  it("finds gaps: missing page types, missing schema and unanswered questions", () => {
    const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), report: crawlerReport() });
    const keys = profile.gaps.map((gap) => gap.key);
    expect(keys).toContain("page_type_missing:about");
    expect(keys).toContain("page_type_missing:case");
    expect(keys).not.toContain("page_type_missing:offer");
    expect(keys).not.toContain("page_type_missing:contact");
    expect(keys).toContain("schema_missing:organization");
    expect(keys).toContain("schema_missing:faq");
    const unanswered = profile.gaps.filter((gap) => gap.kind === "question_without_answer");
    expect(unanswered).toHaveLength(1);
    expect(unanswered[0].label).toBe("Больно ли отбеливать зубы?");
    expect(unanswered[0].evidenceUrls).toEqual(["https://clinic.example/uslugi/otbelivanie"]);
    expect(profile.questions).toEqual({ pagesWithQuestions: 2, answeredPages: 1, faqSchemaPages: 0, unansweredQuestions: 1 });
  });

  it("carries only failing checks into technical and keeps not_checked separately", () => {
    const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), report: crawlerReport() });
    expect(profile.technical.seoScore).toBe(72);
    expect(profile.technical.geoScore).toBe(40);
    expect(profile.technical.seoIssues.map((issue) => issue.id)).toEqual(["description"]);
    expect(profile.technical.geoIssues.map((issue) => issue.id)).toEqual(["structure"]);
    expect(profile.technical.notChecked).toEqual(["speed"]);
    expect(profile.technical.orphanCandidates).toBe(1);
  });

  it("lists linkable pages in priority order without articles or failed pages", () => {
    const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), report: crawlerReport() });
    expect(profile.linkablePages.map((item) => item.pageType)).toEqual(["home", "service", "product", "contact"]);
    expect(profile.linkablePages.some((item) => item.url.includes("/blog/"))).toBe(false);
    expect(profile.linkablePages.some((item) => item.url.includes("/old-page"))).toBe(false);
  });

  it("is deterministic and works without a crawler report", () => {
    const first = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), checkedAt: "2026-09-01T00:00:00Z" });
    const second = buildSiteProfile({ confirmedDomain: "clinic.example", pages: dentalSite(), checkedAt: "2026-09-01T00:00:00Z" });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.technical.seoScore).toBeNull();
    expect(first.technical.seoIssues).toEqual([]);
    expect(first.summary).toContain("clinic.example");
    expect(first.summary).not.toContain("Оценка on-page SEO");
  });

  it("summary states when there are no publications and no topics", () => {
    const profile = buildSiteProfile({
      confirmedDomain: "Solo.Example",
      pages: [page("https://solo.example/", { title: "Главная", technical: { wordCount: 30 } })],
    });
    expect(profile.confirmedDomain).toBe("solo.example");
    expect(profile.publicationCount).toBe(0);
    expect(profile.topics).toEqual([]);
    expect(profile.summary).toContain("Раздела статей или новостей не найдено.");
    expect(profile.summary).toContain("Устойчивых тем между страницами не найдено.");
  });

  it("rejects an empty domain and dedupes repeated urls", () => {
    expect(() => buildSiteProfile({ confirmedDomain: "", pages: [] })).toThrow("site_profile_domain_required");
    const inventory = classifySitePages([page("https://a.example/x?utm_source=tg"), page("https://a.example/x")]);
    expect(inventory).toHaveLength(1);
    expect(inventory[0].url).toBe("https://a.example/x");
  });

  it("caps question gaps and keeps the article count within page count", () => {
    const many = Array.from({ length: 15 }, (_, index) => page(`https://q.example/q${index}`, {
      title: `Вопрос ${index}`,
      headings: [{ level: 2, text: `Как сделать шаг ${index}?` }],
      technical: { wordCount: 20 },
    }));
    const profile = buildSiteProfile({ confirmedDomain: "q.example", pages: many });
    expect(profile.gaps.filter((gap) => gap.kind === "question_without_answer")).toHaveLength(10);
    expect(profile.questions.unansweredQuestions).toBe(10);
    expect(profile.publicationCount).toBeLessThanOrEqual(profile.pageCount);
    expect(words(3)).toBe("слово0 слово1 слово2");
  });
});
