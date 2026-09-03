import { describe, expect, it } from "vitest";

import { buildSiteProfile } from "../site-profile/profile.mjs";
import { buildInitialAuditReport } from "../site-report/initial-audit.mjs";
import { renderSiteReportExport } from "../site-report/export.mjs";
import {
  buildClassifierPrompt,
  buildInterpretationPrompt,
  parseClassifierResponse,
  validateInterpretation,
} from "./interpretation.mjs";

function page(url, overrides = {}) {
  return {
    url, status: 200, title: "Страница", description: "", headings: [], mainContent: "",
    schemaTypes: [], links: [], ctas: [], forms: [], publicComments: [], metadata: {},
    technical: { wordCount: 50 }, ...overrides,
  };
}

const pages = [
  page("https://clinic.example/", { title: "Стоматология Улыбка — имплантация зубов", headings: [{ level: 1, text: "Имплантация зубов" }], technical: { wordCount: 400 } }),
  page("https://clinic.example/uslugi/implantaciya", { title: "Имплантация зубов — цены и этапы", headings: [{ level: 1, text: "Имплантация" }, { level: 2, text: "Сколько стоит имплантация?" }], technical: { wordCount: 650 } }),
  page("https://clinic.example/blog/implanty-posle-40", { title: "Импланты после 40 лет", headings: [{ level: 1, text: "Импланты после 40" }], technical: { wordCount: 900 }, schemaTypes: ["Article"] }),
  page("https://clinic.example/kontakty", { title: "Контакты клиники", headings: [{ level: 1, text: "Контакты" }], technical: { wordCount: 80 } }),
];

describe("classifier prompt and parsing", () => {
  it("passes only url/title/headings and known types, and normalizes the response", () => {
    const baseline = buildSiteProfile({ confirmedDomain: "clinic.example", pages });
    const prompt = buildClassifierPrompt({ pages: baseline.topics.length ? pages.map((item) => ({ ...item, pageType: "other" })) : [], topics: baseline.topics, confirmedDomain: "clinic.example" });
    expect(prompt.system).toContain("недоверенный текст");
    expect(prompt.user).toContain("url: https://clinic.example/uslugi/implantaciya | title: Имплантация зубов — цены и этапы");
    expect(prompt.user).not.toContain("Слишком длинный текст");
    const parsed = parseClassifierResponse(`\`\`\`json\n{"pages":[{"url":"https://clinic.example/uslugi/implantaciya","type":"service"},{"url":"https://evil.example/","type":"home"},{"url":"https://clinic.example/kontakty","type":"spaceship"}],"topicClusters":[{"label":"имплантация","keys":["имплантация","импланты"]},{"label":"одиночка","keys":["зубов"]}]}\n\`\`\``, {
      knownUrls: pages.map((item) => item.url),
      knownTopicKeys: ["имплантация", "импланты", "зубов"],
    });
    expect(parsed.pageTypes).toEqual({ "https://clinic.example/uslugi/implantaciya": "service" });
    expect(parsed.topicClusters).toEqual([{ label: "имплантация", keys: ["имплантация", "импланты"] }]);
    expect(() => parseClassifierResponse("не json")).toThrow("json_missing");
  });

  it("applies classification to the deterministic profile: page type overrides and merged topics", () => {
    const baseline = buildSiteProfile({ confirmedDomain: "clinic.example", pages });
    expect(baseline.pageTypeCounts.product).toBe(1);
    expect(baseline.refined).toBe(false);
    const refined = buildSiteProfile({
      confirmedDomain: "clinic.example",
      pages,
      classification: {
        pageTypes: { "https://clinic.example/uslugi/implantaciya": "service" },
        topicClusters: [{ label: "имплантация", keys: ["имплантация", "импланты"] }],
      },
    });
    expect(refined.refined).toBe(true);
    expect(refined.pageTypeCounts.product).toBeUndefined();
    expect(refined.pageTypeCounts.service).toBe(1);
    const merged = refined.topics.find((topic) => topic.key === "имплантация");
    expect(merged.mergedFrom).toEqual(expect.arrayContaining(["имплантация"]));
    expect(refined.topics.some((topic) => topic.key === "импланты")).toBe(false);
    expect(refined.linkablePages.map((item) => item.pageType)).toContain("service");
  });
});

describe("interpretation prompt and validation", () => {
  const site = { confirmedDomain: "clinic.example", canonicalUrl: "https://clinic.example/", verificationState: "verified" };
  const profile = buildSiteProfile({ confirmedDomain: "clinic.example", pages, report: { optimization: { seo: { score: 61, status: "needs_work", checks: [{ id: "description", label: "Meta description", status: "warning", detail: "Без description: 2 из 4.", recommendation: "Добавить description" }] }, geo: { score: 35, status: "needs_work", checks: [] } } } });
  const report = buildInitialAuditReport({ site, profile, generatedAt: "2026-09-03T12:00:00Z" });

  it("feeds only report facts and open recommendation keys into the prompt", () => {
    const prompt = buildInterpretationPrompt({ payload: report.payload, brandName: "Улыбка", niche: "имплантация" });
    expect(prompt.system).toContain("Не обещай результатов");
    expect(prompt.user).toContain("SEO on-page: оценка 61");
    expect(prompt.user).toContain("key: technical:description");
    expect(prompt.user).toContain("key: gap:schema_missing:organization");
    expect(prompt.user).toContain("BRAND: Улыбка");
  });

  it("removes promises and unknown recommendation keys, keeps titles for start-with items", () => {
    const raw = JSON.stringify({
      summary: "Сайт технически в порядке, но о компании нечего сказать машинам: нет структурированных данных. Позиции вырастут в разы уже через месяц. Поэтому движки называют конкурентов.",
      whatItMeans: ["Нет Organization-разметки — ИИ-ассистенты не могут подтвердить, кто вы.", "Гарантируем рост трафика после правок.", "Description отсутствует на половине страниц — сниппеты в поиске случайные."],
      startWith: [
        { key: "gap:schema_missing:organization", why: "Самая дешёвая правка с эффектом на видимость в ИИ." },
        { key: "gap:придуманная", why: "ничего" },
        { key: "technical:description", why: "Влияет на кликабельность в выдаче." },
        { key: "gap:schema_missing:organization", why: "дубль" },
      ],
      watchOut: ["Позиции и трафик не измерялись.", "Попадёте в топ за неделю."],
    });
    const result = validateInterpretation(raw, { payload: report.payload, engine: "navy-deepseek-flash" });
    expect(result.ok).toBe(true);
    expect(result.interpretation.summary).not.toContain("Позиции вырастут");
    expect(result.interpretation.summary).toContain("нет структурированных данных");
    expect(result.interpretation.whatItMeans).toHaveLength(2);
    expect(result.interpretation.startWith.map((item) => item.key)).toEqual(["gap:schema_missing:organization", "technical:description"]);
    expect(result.interpretation.startWith[0].title).toContain("Organization");
    expect(result.interpretation.startWith[0].priority).toBe("P0");
    expect(result.interpretation.watchOut).toEqual(["Позиции и трафик не измерялись."]);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining(["forbidden_claim_in_summary", "forbidden_claim_removed", "unknown_recommendation_key"]));
    expect(result.interpretation.engine).toBe("navy-deepseek-flash");
    expect(result.interpretation.disclaimer).toContain("источником истины");
  });

  it("rejects an interpretation that is empty after cleaning", () => {
    const result = validateInterpretation(JSON.stringify({ summary: "Гарантируем рост.", whatItMeans: ["Трафик вырастет."], startWith: [], watchOut: [] }), { payload: report.payload });
    expect(result.ok).toBe(false);
    expect(() => validateInterpretation("нет json", { payload: report.payload })).toThrow("json_missing");
  });

  it("renders the interpretation section in markdown and html exports", async () => {
    const validation = validateInterpretation(JSON.stringify({
      summary: "Главная проблема — машинам нечего цитировать о компании: нет Organization-разметки и ответов на вопросы.",
      whatItMeans: ["Клиенты, спрашивающие ИИ, получают конкурентов."],
      startWith: [{ key: "gap:schema_missing:organization", why: "Быстро и дёшево." }],
      watchOut: [],
    }), { payload: report.payload });
    const markdown = (await renderSiteReportExport("markdown", { ...report, interpretation: validation.interpretation })).bytes.toString("utf8");
    expect(markdown).toContain("## Интерпретация Авроры");
    expect(markdown).toContain("| С чего начать | Почему |");
    expect(markdown.indexOf("## Интерпретация Авроры")).toBeLessThan(markdown.indexOf("## SEO (on-page)"));
    const html = (await renderSiteReportExport("html", { ...report, interpretation: validation.interpretation })).bytes.toString("utf8");
    expect(html).toContain("<h2>Интерпретация Авроры</h2>");
    const plain = (await renderSiteReportExport("markdown", report)).bytes.toString("utf8");
    expect(plain).not.toContain("Интерпретация Авроры");
  });
});
