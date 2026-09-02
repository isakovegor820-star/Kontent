import { describe, expect, it } from "vitest";

import { buildSiteProfile } from "../site-profile/profile.mjs";
import { renderSiteReportExport } from "./export.mjs";
import { buildInitialAuditReport } from "./initial-audit.mjs";
import { buildMonthlyReport, reconcileRecommendations } from "./monthly.mjs";

function page(url, overrides = {}) {
  return {
    url, status: 200, title: "Страница", description: "", headings: [], mainContent: "",
    schemaTypes: [], links: [], ctas: [], forms: [], publicComments: [], metadata: {},
    technical: { wordCount: 50 }, ...overrides,
  };
}

const site = { confirmedDomain: "law.example", canonicalUrl: "https://law.example/", verificationState: "verified" };

function profileWithoutOrganization() {
  return buildSiteProfile({
    confirmedDomain: "law.example",
    checkedAt: "2026-08-01T00:00:00Z",
    pages: [
      page("https://law.example/", { title: "Юристы — банкротство физических лиц", headings: [{ level: 1, text: "Банкротство физических лиц" }], technical: { wordCount: 350 } }),
      page("https://law.example/uslugi", { title: "Банкротство физических лиц — услуги", headings: [{ level: 2, text: "Сколько стоит банкротство?" }], technical: { wordCount: 60 }, schemaTypes: ["Service"] }),
    ],
  });
}

function profileWithOrganization() {
  return buildSiteProfile({
    confirmedDomain: "law.example",
    checkedAt: "2026-09-01T00:00:00Z",
    pages: [
      page("https://law.example/", { title: "Юристы — банкротство физических лиц", headings: [{ level: 1, text: "Банкротство физических лиц" }], technical: { wordCount: 350 }, schemaTypes: ["Organization"] }),
      page("https://law.example/uslugi", { title: "Банкротство физических лиц — услуги", headings: [{ level: 2, text: "Сколько стоит банкротство?" }], technical: { wordCount: 400 }, schemaTypes: ["Service", "FAQPage"] }),
      page("https://law.example/o-kompanii", { title: "О компании", headings: [{ level: 1, text: "О нас" }], technical: { wordCount: 200 } }),
    ],
  });
}

const period = { start: "2026-08-01T00:00:00Z", end: "2026-09-01T00:00:00Z" };

describe("buildMonthlyReport", () => {
  it("marks previous recommendations done when their key disappears and carries open ones", () => {
    const initial = buildInitialAuditReport({ site, profile: profileWithoutOrganization(), generatedAt: "2026-08-01T00:00:00Z" });
    const previousReport = { id: 12, payload: initial.payload };
    const monthly = buildMonthlyReport({
      site,
      profile: profileWithOrganization(),
      period,
      publications: { published: 3, byType: { audience_answer: 2, evergreen_guide: 1 }, rejectedDuplicates: 1, pendingReview: 2 },
      probe: { runKey: "run-2026-08-30", questions: 12, answers: 24, skipped: 0, failed: 0, brandMentioned: 0, siteCited: 0, engines: ["a", "b"], competitorsTop: [{ name: "x.ru", mentions: 7 }] },
      previousReport,
      generatedAt: "2026-09-01T07:00:00Z",
    });
    const done = monthly.payload.recommendations.filter((item) => item.status === "done").map((item) => item.key);
    expect(done).toContain("gap:schema_missing:organization");
    expect(done).toContain("gap:schema_missing:faq");
    expect(done).toContain("gap:question_without_answer:https://law.example/uslugi#1");
    const open = monthly.payload.recommendations.filter((item) => item.status === "open");
    expect(open.every((item) => item.sinceReportId === 12 || item.sinceReportId === null)).toBe(true);
    expect(open.find((item) => item.key === "gap:page_type_missing:contact")?.sinceReportId).toBe(12);
    expect(monthly.payload.recommendationSummary.done).toBeGreaterThanOrEqual(3);
    expect(monthly.payload.previousReportId).toBe(12);
    expect(monthly.payload.kind).toBe("monthly");
  });

  it("writes the human summary from templates including the brand-absent explanation", () => {
    const monthly = buildMonthlyReport({
      site,
      profile: profileWithoutOrganization(),
      period,
      publications: { published: 0, byType: {}, rejectedDuplicates: 0, pendingReview: 0 },
      probe: { runKey: "run-1", questions: 10, answers: 20, skipped: 0, failed: 0, brandMentioned: 0, siteCited: 0, engines: ["a", "b"], competitorsTop: [{ name: "x.ru", mentions: 5 }, { name: "Y", mentions: 2 }] },
      previousReport: { id: 1, payload: { geo: { probe: { status: "answered", brandMentioned: 2, siteCited: 1 } }, recommendations: [] } },
    });
    expect(monthly.summaryRu).toContain("Отчёт по сайту law.example за период 2026-08-01 — 2026-09-01.");
    expect(monthly.summaryRu).toContain("бренд упомянут в 0, сайт процитирован в 0");
    expect(monthly.summaryRu).toContain("По вашему бренду в ответах ИИ пусто: на сайте нет структурированных данных об организации");
    expect(monthly.summaryRu).toContain("Вместо вас движки называют: x.ru (5), Y (2).");
    expect(monthly.summaryRu).toContain("упоминания бренда -2, цитирования сайта -1");
    expect(monthly.payload.geo.probe.deltaVsPrevious).toEqual({ brandMentioned: "-2", siteCited: "-1" });
    expect(monthly.summaryRu).not.toMatch(/рост трафика|гарантируем/iu);
  });

  it("reports a skipped probe and an unverified site honestly", () => {
    const skipped = buildMonthlyReport({
      site, profile: profileWithoutOrganization(), period,
      publications: { published: 0, byType: {} },
      probe: { runKey: "run-2", questions: 0, answers: 0, skipped: 12, failed: 0, brandMentioned: 0, siteCited: 0, engines: [] },
    });
    expect(skipped.payload.geo.probe.status).toBe("skipped_budget");
    expect(skipped.summaryRu).toContain("пропущен: исчерпан дневной лимит ИИ");
    const unverified = buildMonthlyReport({ site: { ...site, verificationState: "unverified" }, profile: profileWithoutOrganization(), period, publications: {} });
    expect(unverified.payload.geo.probe).toEqual({ status: "not_run", reason: "domain_unverified" });
    expect(unverified.summaryRu).toContain("Зонд видимости в ИИ-ответах не запускался");
    expect(() => buildMonthlyReport({ site, profile: profileWithoutOrganization(), publications: {} })).toThrow("site_report_period_required");
  });

  it("exports monthly payload with publications and probe facts in markdown", async () => {
    const monthly = buildMonthlyReport({
      site, profile: profileWithOrganization(), period,
      publications: { published: 2, byType: { audience_answer: 2 }, rejectedDuplicates: 1, pendingReview: 0 },
      probe: { runKey: "run-3", questions: 5, answers: 10, skipped: 0, failed: 0, brandMentioned: 1, siteCited: 0, engines: ["a", "b"], competitorsTop: [] },
    });
    const markdown = (await renderSiteReportExport("markdown", monthly)).bytes.toString("utf8");
    expect(markdown.startsWith("# Ежемесячный отчёт по сайту — law.example")).toBe(true);
    expect(markdown).toContain("## Публикации за период");
    expect(markdown).toContain("- **Опубликовано:** 2");
    expect(markdown).toContain("- **Бренд упомянут:** 1");
    expect(markdown).toContain("audience_answer: 2");
  });

  it("reconcileRecommendations handles a first report without a predecessor", () => {
    const result = reconcileRecommendations([{ key: "a", status: "open" }], null);
    expect(result.items).toEqual([{ key: "a", status: "open", sinceReportId: null }]);
    expect(result.doneCount).toBe(0);
  });
});
