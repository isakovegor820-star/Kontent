import { describe, expect, it, vi } from "vitest";

import { persistSiteProfileForAnalysis } from "./site-profile-persistence.mjs";

function page(url, overrides = {}) {
  return {
    url, status: 200, title: "Страница", description: "", headings: [], mainContent: "",
    schemaTypes: [], links: [], ctas: [], forms: [], publicComments: [], metadata: {},
    technical: { wordCount: 50 }, ...overrides,
  };
}

function siteRow(overrides = {}) {
  return {
    id: 5, project_id: 3, user_id: 9, confirmed_domain: "example.ru", canonical_url: "https://example.ru/",
    verification_state: "unverified", status: "active", ...overrides,
  };
}

function clientWith({ site = siteRow(), previousReport = null } = {}) {
  const calls = [];
  const query = vi.fn(async (sql, params) => {
    calls.push({ sql: String(sql), params });
    if (String(sql).includes("from sites")) return { rows: site ? [site] : [] };
    if (String(sql).includes("insert into site_profiles")) return { rows: [{ id: 77 }] };
    if (String(sql).includes("from site_reports")) return { rows: previousReport ? [{ id: previousReport }] : [] };
    if (String(sql).includes("insert into site_reports")) return { rows: [{ id: 91 }] };
    return { rows: [] };
  });
  return { query, calls };
}

const input = {
  analysisId: 41,
  runRevision: 2,
  siteId: 5,
  pages: [page("https://example.ru/", { title: "Главная компании", technical: { wordCount: 300 } })],
  report: { optimization: { seo: { score: 80, status: "needs_work", checks: [] }, geo: { score: 50, status: "needs_work", checks: [] } } },
  snapshotHash: `sha256:${"c".repeat(64)}`,
  checkedAt: "2026-09-01T00:00:00Z",
  now: new Date("2026-09-02T12:00:00Z"),
};

describe("persistSiteProfileForAnalysis", () => {
  it("skips analyses that are not bound to a site", async () => {
    const client = clientWith();
    await expect(persistSiteProfileForAnalysis(client, { ...input, siteId: null })).resolves.toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  it("skips disconnected or missing sites without writing anything", async () => {
    const disconnected = clientWith({ site: siteRow({ status: "disconnected" }) });
    await expect(persistSiteProfileForAnalysis(disconnected, input)).resolves.toBeNull();
    expect(disconnected.query).toHaveBeenCalledTimes(1);
    const missing = clientWith({ site: null });
    await expect(persistSiteProfileForAnalysis(missing, input)).resolves.toBeNull();
    expect(missing.query).toHaveBeenCalledTimes(1);
  });

  it("locks the site, stores profile and initial audit, then points the site at them", async () => {
    const client = clientWith();
    const result = await persistSiteProfileForAnalysis(client, input);
    expect(result).toEqual({ siteId: 5, profileId: 77, reportId: 91, reportKind: "initial_audit", pageCount: 1, gaps: result.gaps, indexedPages: 0 });
    expect(result.gaps).toBeGreaterThan(0);

    const [lock, profile, previous, report, site, knowledgeReset] = client.calls;
    expect(lock.sql).toContain("for update");
    expect(lock.params).toEqual([5]);

    expect(profile.sql).toContain("insert into site_profiles");
    expect(profile.params.slice(0, 4)).toEqual([5, 41, 2, "site-profile-v1"]);
    expect(profile.params[4]).toBe(1);
    const technical = JSON.parse(profile.params[8]);
    expect(technical.seoScore).toBe(80);
    expect(technical.questions).toBeDefined();
    expect(technical.pageTypeCounts.home).toBe(1);

    expect(previous.sql).toContain("from site_reports");
    expect(report.sql).toContain("insert into site_reports");
    expect(report.params[1]).toBe("initial_audit");
    expect(report.params[2]).toBe(77);
    expect(report.params[3]).toBeNull();
    const payload = JSON.parse(report.params[4]);
    expect(payload.kind).toBe("initial_audit");
    expect(payload.analysis).toMatchObject({ analysisId: 41, runRevision: 2, snapshotHash: input.snapshotHash });
    expect(payload.generatedAt).toBe("2026-09-02T12:00:00.000Z");
    expect(report.params[5]).toContain("Стартовый аудит сайта example.ru");

    expect(site.sql).toContain("update sites");
    expect(site.params).toEqual([5, 41, 77]);
    expect(knowledgeReset.sql).toContain("delete from knowledge_sources");
    expect(knowledgeReset.params).toEqual([5]);
  });

  it("indexes long pages into the site knowledge base as pending site_page sources", async () => {
    const client = clientWith();
    const longPage = page("https://example.ru/uslugi", { title: "Услуги", technical: { wordCount: 300 }, mainContent: "слово ".repeat(120) });
    const result = await persistSiteProfileForAnalysis(client, { ...input, pages: [...input.pages, longPage] });
    expect(result.indexedPages).toBe(1);
    const insert = client.calls.find((call) => call.sql.includes("insert into knowledge_sources"));
    expect(insert.params[0]).toBe(9);
    expect(insert.params[1]).toBe(5);
    expect(insert.params[2]).toBe("https://example.ru/uslugi");
    expect(insert.params[3].startsWith("Услуги\n\n")).toBe(true);
  });

  it("marks a re-run as on_demand and links it to the previous report", async () => {
    const client = clientWith({ previousReport: 60 });
    const result = await persistSiteProfileForAnalysis(client, input);
    expect(result.reportKind).toBe("on_demand");
    const report = client.calls.find((call) => call.sql.includes("insert into site_reports"));
    expect(report.params[1]).toBe("on_demand");
    expect(report.params[3]).toBe(60);
    expect(JSON.parse(report.params[4]).kind).toBe("on_demand");
  });
});
