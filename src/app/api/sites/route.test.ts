import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  query: vi.fn(),
  hasSiteAnalysisWorker: vi.fn(),
  enqueueSiteAnalysis: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/db", () => ({ getPool: () => ({ query: mocks.query }) }));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/site-analysis-queue", () => ({
  hasSiteAnalysisWorker: mocks.hasSiteAnalysisWorker,
  enqueueSiteAnalysis: mocks.enqueueSiteAnalysis,
}));

import { GET, POST } from "./route";

const siteRow = {
  id: "5",
  project_id: "31",
  user_id: "7",
  confirmed_domain: "example.ru",
  canonical_url: "https://example.ru/",
  verification_state: "unverified",
  verification_method: null,
  verification_token: "abcdefghijklmnopqrstuvwxyz0123456789_-AB",
  verified_at: null,
  latest_analysis_id: null,
  latest_profile_id: null,
  publishing_mode: "confirm",
  auto_unlock_streak: 10,
  approved_streak: 0,
  cadence: {},
  status: "active",
  created_at: new Date("2026-09-01T00:00:00Z"),
  updated_at: new Date("2026-09-01T00:00:00Z"),
};

const analysisRow = {
  id: "41",
  request_id: "11111111-1111-4111-8111-111111111111",
  target_url: "https://example.ru/",
  confirmed_domain: "example.ru",
  status: "queued",
  stage: "queued",
  progress: 0,
  progress_detail: null,
  limits: {},
  error_code: null,
  error_message: null,
  attempts: 0,
  run_revision: 1,
  queue_confirmed_at: null,
  created_at: new Date("2026-09-01T00:00:00Z"),
  updated_at: new Date("2026-09-01T00:00:00Z"),
  completed_at: null,
  site_id: "5",
};

function post(body: Record<string, unknown>, key = "sites-client-key-1234") {
  return new NextRequest("http://localhost/api/sites", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

describe("/api/sites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.hasSiteAnalysisWorker.mockResolvedValue(true);
    mocks.enqueueSiteAnalysis.mockResolvedValue({ jobId: "site-analysis-41-r1", recovered: false });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into sites")) return { rows: [siteRow] };
      if (sql.includes("idempotency_key = $3")) return { rows: [] };
      if (sql.includes("status in ('queued', 'crawling'")) return { rows: [] };
      if (sql.includes("insert into site_analysis_jobs")) return { rows: [analysisRow] };
      if (sql.includes("queue_confirmed_at = now()")) return { rows: [{ ...analysisRow, queue_confirmed_at: new Date() }] };
      if (sql.includes("from site_analysis_jobs") && sql.includes("where site_id = $1")) return { rows: [analysisRow] };
      if (sql.includes("from site_reports")) return { rows: [] };
      return { rows: [] };
    });
  });

  it("requires an authenticated project member to list sites", async () => {
    mocks.getSessionUser.mockResolvedValueOnce(null);
    expect((await GET(new NextRequest("http://localhost/api/sites"))).status).toBe(401);
    mocks.query.mockResolvedValueOnce({ rows: [{ ...siteRow, analysis_status: "ready", analysis_progress: 100, profile_summary: "Сводка", profile_page_count: 12, profile_gap_count: 3, report_count: 1 }] });
    const response = await GET(new NextRequest("http://localhost/api/sites"));
    expect(response.status).toBe(200);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 7, "project.read");
    const body = await response.json();
    expect(body.sites).toHaveLength(1);
    expect(body.sites[0]).toMatchObject({
      id: 5,
      confirmedDomain: "example.ru",
      latestAnalysis: { status: "ready", progress: 100 },
      profile: { summary: "Сводка", pageCount: 12, gapCount: 3 },
      reportCount: 1,
    });
    expect(body.sites[0].verification.instructions.dns.recordName).toBe("_aurora-site.example.ru");
  });

  it("rejects mutations without a trusted origin, consent or idempotency key", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValueOnce(false);
    expect((await POST(post({ url: "https://example.ru", consent: true }))).status).toBe(403);
    const noConsent = await POST(post({ url: "https://example.ru", consent: false }));
    expect(noConsent.status).toBe(422);
    expect((await noConsent.json()).error).toBe("consent_required");
    const badUrl = await POST(post({ url: "example dot ru", consent: true }));
    expect(badUrl.status).toBe(422);
    expect((await badUrl.json()).error).toBe("bad_url");
    const noKey = new NextRequest("http://localhost/api/sites", {
      method: "POST",
      headers: { origin: "http://localhost", "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.ru", consent: true }),
    });
    expect((await POST(noKey)).status).toBe(400);
    expect(mocks.query).not.toHaveBeenCalledWith(expect.stringContaining("insert into sites"), expect.anything());
  });

  it("creates the site, starts a site-bound analysis and returns the card", async () => {
    const response = await POST(post({ url: "https://Example.ru/about?utm_source=x", consent: true }));
    expect(response.status).toBe(201);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 7, "content.create");
    const insertSite = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into sites"));
    expect(insertSite?.[1]?.slice(0, 4)).toEqual([31, 7, "example.ru", "https://example.ru/"]);
    expect(String(insertSite?.[1]?.[4])).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
    const insertAnalysis = mocks.query.mock.calls.find(([sql]) => String(sql).includes("insert into site_analysis_jobs"));
    expect(insertAnalysis?.[1]?.[3]).toBe("site:5:sites-client-key-1234");
    expect(insertAnalysis?.[1]?.at(-1)).toBe(5);
    expect(mocks.enqueueSiteAnalysis).toHaveBeenCalledWith({ analysisId: 41, requestId: analysisRow.request_id, runRevision: 1 });
    const body = await response.json();
    expect(body.created).toBe(true);
    expect(body.site.confirmedDomain).toBe("example.ru");
    expect(body.latestAnalysis).toMatchObject({ id: 41, status: "queued" });
    expect(body.analysisError).toBeNull();
    expect(body.reports).toEqual([]);
  });

  it("keeps the site when the worker is unavailable and reports the analysis error", async () => {
    mocks.hasSiteAnalysisWorker.mockResolvedValueOnce(false);
    const response = await POST(post({ url: "https://example.ru", consent: true }));
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.analysisError).toBe("worker_unavailable");
    expect(body.site.id).toBe(5);
    expect(mocks.enqueueSiteAnalysis).not.toHaveBeenCalled();
  });

  it("returns the existing site for the same domain instead of duplicating it", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("insert into sites")) return { rows: [] };
      if (sql.includes("from sites where project_id = $1 and confirmed_domain = $2")) return { rows: [siteRow] };
      if (sql.includes("status in ('queued', 'crawling'")) return { rows: [{ id: 40 }] };
      if (sql.includes("from site_analysis_jobs") && sql.includes("where site_id = $1")) return { rows: [{ ...analysisRow, status: "crawling" }] };
      return { rows: [] };
    });
    const response = await POST(post({ url: "https://example.ru", consent: true }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.created).toBe(false);
    expect(body.analysisError).toBe("analysis_in_progress");
    expect(body.latestAnalysis.status).toBe("crawling");
  });
});
