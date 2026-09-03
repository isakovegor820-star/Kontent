import { describe, expect, it } from "vitest";

import { buildSiteProfile } from "../site-profile/profile.mjs";
import { renderSiteReportExport, SITE_REPORT_EXPORT_FORMATS } from "./export.mjs";
import { buildInitialAuditReport, SITE_REPORT_VERSION } from "./initial-audit.mjs";

function page(url, overrides = {}) {
  return {
    url, status: 200, title: "Страница", description: "", headings: [], mainContent: "",
    schemaTypes: [], links: [], ctas: [], forms: [], publicComments: [], metadata: {},
    technical: { wordCount: 50 }, ...overrides,
  };
}

function profileFixture() {
  return buildSiteProfile({
    confirmedDomain: "law.example",
    checkedAt: "2026-09-01T10:00:00Z",
    pages: [
      page("https://law.example/", { title: "Юридическая фирма — банкротство физических лиц", headings: [{ level: 1, text: "Банкротство физических лиц" }], technical: { wordCount: 350 } }),
      page("https://law.example/uslugi/bankrotstvo", { title: "Банкротство физических лиц — услуга", headings: [{ level: 1, text: "Банкротство" }, { level: 2, text: "Сколько стоит банкротство?" }], technical: { wordCount: 90 }, schemaTypes: ["Service"] }),
      page("https://law.example/o-kompanii", { title: "О компании", headings: [{ level: 1, text: "О нас" }], technical: { wordCount: 200 } }),
    ],
    report: {
      optimization: {
        seo: { score: 55, status: "critical", checks: [
          { id: "indexing", label: "HTTPS и индексируемость", status: "critical", detail: "Страниц без HTTPS: 1.", recommendation: "Перевести страницы на HTTPS" },
        ] },
        geo: { score: 30, status: "needs_work", checks: [
          { id: "faq", label: "FAQ и короткие прямые ответы", status: "warning", detail: "FAQPage не найден.", recommendation: "Добавить FAQ с короткими прямыми ответами" },
        ] },
      },
      internalLinking: { orphanCandidates: [] },
    },
  });
}

const site = { confirmedDomain: "law.example", canonicalUrl: "https://law.example/", verificationState: "unverified" };

describe("buildInitialAuditReport", () => {
  it("assembles a versioned payload with seo/geo/aeo/content sections and honest limitations", () => {
    const { payload, summaryRu } = buildInitialAuditReport({
      site,
      profile: profileFixture(),
      analysis: { analysisId: 41, runRevision: 2, snapshotHash: `sha256:${"b".repeat(64)}` },
      generatedAt: "2026-09-02T12:00:00Z",
    });
    expect(payload.reportVersion).toBe(SITE_REPORT_VERSION);
    expect(payload.kind).toBe("initial_audit");
    expect(payload.generatedAt).toBe("2026-09-02T12:00:00.000Z");
    expect(payload.site).toEqual({ domain: "law.example", canonicalUrl: "https://law.example/", verified: false });
    expect(payload.analysis.analysisId).toBe(41);
    expect(payload.seo.score).toBe(55);
    expect(payload.seo.requiredIntegrations).toEqual(["yandex_webmaster", "google_search_console"]);
    expect(payload.geo.probe).toEqual({ status: "not_run", reason: "visibility_probe_not_enabled" });
    expect(payload.aeo.questionsWithoutAnswer).toBe(1);
    expect(payload.content.publicationCount).toBe(0);
    expect(payload.content.topics.total).toBeGreaterThan(0);
    expect(payload.limitations).toHaveLength(3);
    expect(typeof summaryRu).toBe("string");
  });

  it("turns technical issues and gaps into prioritized open recommendations", () => {
    const { payload } = buildInitialAuditReport({ site, profile: profileFixture() });
    const keys = payload.recommendations.map((item) => item.key);
    expect(keys[0]).toBe("technical:indexing");
    expect(payload.recommendations[0].priority).toBe("P0");
    expect(payload.recommendations[0].source).toBe("seo");
    expect(keys).toContain("technical:faq");
    expect(keys).toContain("gap:schema_missing:organization");
    expect(keys).toContain("gap:page_type_missing:contact");
    expect(payload.recommendations.every((item) => item.status === "open")).toBe(true);
    const organization = payload.recommendations.find((item) => item.key === "gap:schema_missing:organization");
    expect(organization.priority).toBe("P0");
    expect(organization.title).toContain("Organization");
    const question = payload.recommendations.find((item) => item.key.startsWith("gap:question_without_answer"));
    expect(question.title).toContain("Сколько стоит банкротство?");
    const priorities = payload.recommendations.map((item) => item.priority);
    expect([...priorities].sort()).toEqual(priorities);
  });

  it("builds the Russian summary from templates without promising traffic", () => {
    const { summaryRu } = buildInitialAuditReport({ site, profile: profileFixture() });
    expect(summaryRu).toContain("Стартовый аудит сайта law.example");
    expect(summaryRu).toContain("проверено 3 страницы");
    expect(summaryRu).toContain("Раздела новостей или статей нет");
    expect(summaryRu).toContain("критичных проблем: 1");
    expect(summaryRu).toContain("(55/100)");
    expect(summaryRu).toContain("нет структурированных данных об организации");
    expect(summaryRu).toContain("Вопросов аудитории без прямого ответа на сайте: 1");
    expect(summaryRu).toContain("не измерялись");
    expect(summaryRu).not.toMatch(/рост трафика|гарантируем|позиции вырастут/iu);
  });

  it("rejects missing site or a foreign profile version", () => {
    expect(() => buildInitialAuditReport({ site: {}, profile: profileFixture() })).toThrow("site_report_site_required");
    expect(() => buildInitialAuditReport({ site, profile: { profileVersion: "other" } })).toThrow("site_report_profile_required");
  });
});

describe("renderSiteReportExport", () => {
  const report = buildInitialAuditReport({ site, profile: profileFixture(), generatedAt: "2026-09-02T12:00:00Z" });

  it("renders every supported format with the right content type", async () => {
    expect(SITE_REPORT_EXPORT_FORMATS).toEqual(["json", "markdown", "html", "pdf"]);
    for (const format of SITE_REPORT_EXPORT_FORMATS) {
      const rendered = await renderSiteReportExport(format, report);
      expect(rendered.bytes.length).toBeGreaterThan(200);
      expect(rendered.contentType).toBeTruthy();
      expect(rendered.extension).toBeTruthy();
    }
    await expect(renderSiteReportExport("docx", report)).rejects.toThrow("unsupported_site_report_export_format");
  });

  it("json export keeps summary and payload together", async () => {
    const rendered = await renderSiteReportExport("json", report);
    const parsed = JSON.parse(rendered.bytes.toString("utf8"));
    expect(parsed.summaryRu).toBe(report.summaryRu);
    expect(parsed.reportVersion).toBe(SITE_REPORT_VERSION);
    expect(parsed.recommendations.length).toBe(report.payload.recommendations.length);
  });

  it("markdown export has section headings, facts and recommendation rows", async () => {
    const markdown = (await renderSiteReportExport("markdown", report)).bytes.toString("utf8");
    expect(markdown.startsWith("# Стартовый аудит сайта — law.example")).toBe(true);
    for (const heading of ["## Сводка", "## SEO (on-page)", "## GEO (генеративный поиск)", "## AEO (быстрые ответы)", "## Контент и темы", "## Пробелы", "## Рекомендации", "## Ограничения"]) {
      expect(markdown).toContain(heading);
    }
    expect(markdown).toContain("| P0 | SEO | Перевести страницы на HTTPS |");
    expect(markdown).toContain("- **Оценка:** 55/100");
  });

  it("html export escapes user-controlled text", async () => {
    const hostile = buildInitialAuditReport({
      site,
      profile: buildSiteProfile({
        confirmedDomain: "law.example",
        pages: [page("https://law.example/", { title: "<script>alert(1)</script>", headings: [{ level: 2, text: "Как <b>взломать</b>?" }], technical: { wordCount: 10 } })],
      }),
    });
    const html = (await renderSiteReportExport("html", hostile)).bytes.toString("utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;b&gt;взломать&lt;/b&gt;");
    expect(html).toContain("<h2>Рекомендации</h2>");
  });

  it("pdf export produces a PDF document", async () => {
    const rendered = await renderSiteReportExport("pdf", report);
    expect(rendered.bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(rendered.contentType).toBe("application/pdf");
  });
});
