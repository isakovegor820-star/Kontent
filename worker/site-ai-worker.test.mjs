import { describe, expect, it, vi } from "vitest";

import { buildSiteProfile } from "../src/lib/site-profile/profile.mjs";
import { buildInitialAuditReport } from "../src/lib/site-report/initial-audit.mjs";
import { enqueuePendingInterpretations, interpretSiteReport, refineSiteProfile } from "./site-ai-worker.mjs";

const pageRows = [
  { url: "https://clinic.example/", http_status: 200, title: "Стоматология Улыбка — имплантация зубов", description: null, headings: [{ level: 1, text: "Имплантация зубов" }], main_content: "x", schema_types: [], links: [], ctas: [], forms: [], public_comments: [], technical: { wordCount: 400, metadata: {} } },
  { url: "https://clinic.example/uslugi/implantaciya", http_status: 200, title: "Имплантация зубов — цены", description: null, headings: [{ level: 1, text: "Имплантация" }], main_content: "y", schema_types: [], links: [], ctas: [], forms: [], public_comments: [], technical: { wordCount: 600, metadata: {} } },
  { url: "https://clinic.example/blog/implanty", http_status: 200, title: "Импланты после 40", description: null, headings: [{ level: 1, text: "Импланты" }], main_content: "z", schema_types: ["Article"], links: [], ctas: [], forms: [], public_comments: [], technical: { wordCount: 900, metadata: {} } },
];

const profileRow = {
  id: 77, site_id: 5, analysis_job_id: 41, run_revision: 1, topics: [], ai_classification: null, refined_at: null,
  user_id: 9, confirmed_domain: "clinic.example", canonical_url: "https://clinic.example/", verification_state: "verified", brand_name: "Улыбка", site_status: "active",
  analysis_result: { optimization: { seo: { score: 70, status: "needs_work", checks: [] }, geo: { score: 40, status: "needs_work", checks: [] } } },
  analysis_created_at: "2026-09-01T00:00:00Z",
};

function refinePool({ profile = profileRow, reports = [] } = {}) {
  const calls = [];
  const handler = async (sql, params) => {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes("from site_profiles p")) return { rows: [profile] };
    if (text.includes("from site_analysis_pages")) return { rows: pageRows };
    if (text.includes("select id, kind, payload from site_reports")) return { rows: reports };
    return { rows: [] };
  };
  const client = { query: vi.fn(handler), release: vi.fn() };
  return { pool: { query: vi.fn(handler), connect: vi.fn(async () => client) }, client, calls };
}

describe("refineSiteProfile", () => {
  it("asks the classifier, rebuilds the profile with overrides and merged topics, and rebuilds linked audits", async () => {
    const pagesForBaseline = pageRows.map((row) => ({ url: row.url, status: 200, title: row.title, headings: row.headings, schemaTypes: row.schema_types, technical: { wordCount: row.technical.wordCount }, metadata: {} }));
    const baseline = buildSiteProfile({ confirmedDomain: "clinic.example", pages: pagesForBaseline });
    const audit = buildInitialAuditReport({ site: { confirmedDomain: "clinic.example", canonicalUrl: "https://clinic.example/", verificationState: "verified" }, profile: baseline, analysis: { analysisId: 41, runRevision: 1 }, generatedAt: "2026-09-01T01:00:00Z" });
    const { pool, client, calls } = refinePool({ reports: [{ id: 3, kind: "initial_audit", payload: audit.payload }] });
    const completeAiText = vi.fn(async () => ({
      text: JSON.stringify({ pages: [{ url: "https://clinic.example/uslugi/implantaciya", type: "service" }], topicClusters: [{ label: "имплантация зубов", keys: ["имплантация", "зубов"] }, { label: "мимо", keys: ["импланты", "несуществующая"] }] }),
      engine: "navy-deepseek-flash",
    }));
    const result = await refineSiteProfile(pool, { profileId: 77 }, { completeAiText, engine: "navy-deepseek-flash" });
    expect(result).toMatchObject({ ok: true, profileId: 77, engine: "navy-deepseek-flash", pageTypeOverrides: 1, topicClusters: 1, reportsRebuilt: 1 });
    const [request] = completeAiText.mock.calls[0];
    expect(request.system).toContain("классификатор страниц");
    expect(request.temperature).toBe(0);
    const update = calls.find((call) => call.sql.includes("update site_profiles"));
    const topics = JSON.parse(update.params[3]);
    expect(topics.some((topic) => topic.key === "имплантация зубов" && topic.mergedFrom.length === 2)).toBe(true);
    expect(topics.some((topic) => topic.key === "зубов")).toBe(false);
    const classification = JSON.parse(update.params[8]);
    expect(classification.status).toBe("ready");
    expect(classification.pageTypes["https://clinic.example/uslugi/implantaciya"]).toBe("service");
    const reportUpdate = calls.find((call) => call.sql.includes("update site_reports set payload"));
    expect(reportUpdate.params[0]).toBe(3);
    expect(JSON.parse(reportUpdate.params[1]).generatedAt).toBe("2026-09-01T01:00:00.000Z");
    expect(client.query).toHaveBeenCalledWith("commit");
  });

  it("keeps the deterministic profile when the classifier fails and never retries a refined profile", async () => {
    const { pool, calls } = refinePool();
    const result = await refineSiteProfile(pool, { profileId: 77 }, { completeAiText: vi.fn(async () => { throw Object.assign(new Error("boom"), { code: "provider_error" }); }), engine: "navy-deepseek-flash" });
    expect(result).toMatchObject({ ok: false, reason: "classifier_failed" });
    const marker = calls.find((call) => call.sql.includes("set ai_classification = $2::jsonb, refined_at = now()"));
    expect(JSON.parse(marker.params[1])).toMatchObject({ status: "failed", code: "provider_error" });
    const already = refinePool({ profile: { ...profileRow, refined_at: new Date() } });
    const skipped = await refineSiteProfile(already.pool, { profileId: 77 }, { completeAiText: vi.fn() });
    expect(skipped).toMatchObject({ ok: true, skipped: "already_refined" });
  });
});

describe("interpretSiteReport", () => {
  const baseline = buildSiteProfile({ confirmedDomain: "clinic.example", pages: pageRows.map((row) => ({ url: row.url, status: 200, title: row.title, headings: row.headings, schemaTypes: row.schema_types, technical: { wordCount: row.technical.wordCount }, metadata: {} })) });
  const audit = buildInitialAuditReport({ site: { confirmedDomain: "clinic.example", canonicalUrl: "https://clinic.example/", verificationState: "verified" }, profile: baseline });
  const reportRow = { id: 3, site_id: 5, kind: "initial_audit", payload: audit.payload, interpretation_status: "pending", user_id: 9, brand_name: "Улыбка", confirmed_domain: "clinic.example", site_status: "active", topics: baseline.topics };

  function interpretPool(row = reportRow) {
    const calls = [];
    const pool = { query: vi.fn(async (sql, params) => { calls.push({ sql: String(sql), params }); return String(sql).includes("from site_reports r") ? { rows: [row] } : { rows: [] }; }) };
    return { pool, calls };
  }
  const usage = () => ({
    acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 900 })),
    commitUsage: vi.fn(async () => ({ status: "committed" })),
    releaseUsage: vi.fn(async () => true),
  });

  it("reserves user AI budget, validates the model output and stores a ready interpretation", async () => {
    const { pool, calls } = interpretPool();
    const deps = { ...usage(), engine: "navy-deepseek-flash", completeAiText: vi.fn(async () => ({
      text: JSON.stringify({ summary: "Машинам нечего цитировать о компании: нет структурированных данных об организации, поэтому в ответах ИИ вас нет.", whatItMeans: ["Клиенты, спрашивающие у ИИ, видят конкурентов."], startWith: [{ key: "gap:schema_missing:organization", why: "Дёшево и быстро." }], watchOut: ["Трафик не измерялся."] }),
      engine: "navy-deepseek-flash",
    })) };
    const result = await interpretSiteReport(pool, { reportId: 3 }, deps);
    expect(result).toMatchObject({ ok: true, reportId: 3, startWith: 1 });
    expect(deps.acquireUsage).toHaveBeenCalledWith(pool, expect.objectContaining({ userId: 9, kind: "site_report_interpretation" }));
    const saved = calls.find((call) => call.sql.includes("interpretation_status = 'ready'"));
    const stored = JSON.parse(saved.params[1]);
    expect(stored.startWith[0].title).toContain("Organization");
    expect(deps.commitUsage).toHaveBeenCalledWith(pool, 9, 900);
  });

  it("retries once with feedback and marks failed when the model keeps promising results", async () => {
    const { pool, calls } = interpretPool();
    const completeAiText = vi.fn(async () => ({ text: JSON.stringify({ summary: "Гарантируем рост трафика.", whatItMeans: ["Позиции вырастут."], startWith: [], watchOut: [] }), engine: "e" }));
    const deps = { ...usage(), engine: "navy-deepseek-flash", completeAiText };
    const result = await interpretSiteReport(pool, { reportId: 3 }, deps);
    expect(result).toMatchObject({ ok: false, reason: "interpretation_rejected" });
    expect(completeAiText).toHaveBeenCalledTimes(2);
    expect(completeAiText.mock.calls[1][0].user).toContain("ПРЕДЫДУЩИЙ ОТВЕТ ОТКЛОНЁН");
    expect(calls.some((call) => call.sql.includes("interpretation_status = 'failed'"))).toBe(true);
    expect(deps.commitUsage).toHaveBeenCalled();
  });

  it("stops on the daily limit without touching the report and releases on provider errors", async () => {
    const limited = interpretPool();
    await expect(interpretSiteReport(limited.pool, { reportId: 3 }, { ...usage(), acquireUsage: vi.fn(async () => ({ state: "limit" })), completeAiText: vi.fn() })).rejects.toMatchObject({ code: "ai_usage_limit", retryable: true });
    expect(limited.calls.some((call) => call.sql.includes("update site_reports"))).toBe(false);
    const failing = interpretPool();
    const deps = { ...usage(), engine: "navy-deepseek-flash", completeAiText: vi.fn(async () => { throw Object.assign(new Error("down"), { code: "provider_unavailable" }); }) };
    await expect(interpretSiteReport(failing.pool, { reportId: 3 }, deps)).rejects.toMatchObject({ code: "provider_unavailable" });
    expect(deps.releaseUsage).toHaveBeenCalledWith(failing.pool, 9, 900);
    const ready = interpretPool({ ...reportRow, interpretation_status: "ready" });
    expect(await interpretSiteReport(ready.pool, { reportId: 3 }, usage())).toMatchObject({ skipped: "already_interpreted" });
  });

  it("enqueues pending interpretations with deterministic hourly job ids", async () => {
    const pool = { query: vi.fn(async () => ({ rows: [{ id: 3 }, { id: 4 }] })) };
    const queue = { add: vi.fn(async () => ({})) };
    expect(await enqueuePendingInterpretations(pool, queue)).toEqual({ enqueued: 2 });
    expect(queue.add).toHaveBeenCalledWith("interpret", { reportId: 3 }, expect.objectContaining({ jobId: expect.stringMatching(/^site-articles-interpret-3-retry-/u) }));
    expect(await enqueuePendingInterpretations(pool, null)).toEqual({ enqueued: 0 });
  });
});
