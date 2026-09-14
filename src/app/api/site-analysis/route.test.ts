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

const row = {
  id: "41",
  request_id: "11111111-1111-4111-8111-111111111111",
  request_fingerprint: "",
  target_url: "https://example.com/",
  confirmed_domain: "example.com",
  status: "queued",
  stage: "queued",
  progress: 0,
  progress_detail: null,
  limits: {},
  result: null,
  error_code: null,
  error_message: null,
  attempts: 0,
  run_revision: 1,
  queue_confirmed_at: null,
  created_at: new Date("2026-08-05T00:00:00Z"),
  updated_at: new Date("2026-08-05T00:00:00Z"),
  completed_at: null,
};

function request(body: Record<string, unknown>, key = "site-analysis-client-1234") {
  return new NextRequest("http://localhost/api/site-analysis", {
    method: "POST",
    headers: { origin: "http://localhost", "content-type": "application/json", "idempotency-key": key },
    body: JSON.stringify(body),
  });
}

describe("POST /api/site-analysis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.hasSiteAnalysisWorker.mockResolvedValue(true);
    mocks.enqueueSiteAnalysis.mockResolvedValue({ jobId: "site-analysis-41-r1", recovered: false });
    mocks.requireSelectedProjectPermission.mockResolvedValue({ projectId: 31, userId: 7, role: "owner", version: 1 });
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("idempotency_key in ($3, $4)")) return { rows: [] };
      if (sql.includes("insert into site_analysis_jobs")) return { rows: [row] };
      if (sql.includes("queue_confirmed_at = now()")) return { rows: [{ ...row, queue_confirmed_at: new Date() }] };
      return { rows: [] };
    });
  });

  it("lists only analyses from the selected project and hides legacy NULL rows", async () => {
    mocks.query.mockResolvedValueOnce({ rows: [{ ...row, project_id: 31 }] });
    const response = await GET(new NextRequest("http://localhost/api/site-analysis"));
    expect(response.status).toBe(200);
    expect(mocks.requireSelectedProjectPermission).toHaveBeenCalledWith(expect.anything(), 7, "project.read");
    expect(mocks.query).toHaveBeenCalledWith(
      expect.stringContaining("where project_id = $1"),
      [31],
    );
  });

  it("rejects missing consent or a mismatched confirmed domain before queueing", async () => {
    const noConsent = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: false }));
    expect(noConsent.status).toBe(422);
    expect(await noConsent.json()).toMatchObject({ error: "consent_required", requestId: expect.any(String) });

    const mismatch = await POST(request({ url: "https://other.example", confirmedDomain: "example.com", consent: true }));
    expect(mismatch.status).toBe(422);
    expect(await mismatch.json()).toMatchObject({ error: "domain_mismatch" });
    expect(mocks.hasSiteAnalysisWorker).not.toHaveBeenCalled();
  });

  it("fails closed when the full BullMQ worker is absent", async () => {
    mocks.hasSiteAnalysisWorker.mockResolvedValue(false);
    const response = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "worker_unavailable", requestId: expect.any(String) });
    expect(mocks.enqueueSiteAnalysis).not.toHaveBeenCalled();
  });

  it("persists an idempotent row before enqueueing the revision-bound job", async () => {
    const response = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true, limits: { maxPages: 12 } }));
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ ok: true, replayed: false, analysis: { id: 41, status: "queued" } });
    expect(mocks.enqueueSiteAnalysis).toHaveBeenCalledWith({ analysisId: 41, requestId: row.request_id, runRevision: 1 });
    expect(mocks.query).toHaveBeenCalledWith(expect.stringContaining("insert into site_analysis_jobs"), expect.arrayContaining([
      31,
      7,
      expect.any(String),
      "project:31:site-analysis-client-1234",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "https://example.com/",
      "example.com",
    ]));
    const enqueueOrder = mocks.enqueueSiteAnalysis.mock.invocationCallOrder[0];
    const confirmationCall = mocks.query.mock.calls.findIndex(([sql]) => String(sql).includes("queue_confirmed_at = now()"));
    expect(confirmationCall).toBeGreaterThanOrEqual(0);
    expect(enqueueOrder).toBeLessThan(mocks.query.mock.invocationCallOrder[confirmationCall]);
  });

  it("replays the durable row without requiring a live worker", async () => {
    mocks.query.mockReset();
    mocks.query.mockImplementationOnce(async (_sql: string, values: unknown[]) => {
      const fingerprint = (await import("@/lib/site-analysis")).siteAnalysisFingerprint({
        targetUrl: "https://example.com/",
        confirmedDomain: "example.com",
        limits: {},
      });
      expect(values).toEqual([31, 7, "project:31:site-analysis-client-1234", "site-analysis-client-1234"]);
      return { rows: [{ ...row, request_fingerprint: fingerprint, status: "ready", stage: "ready", progress: 100, result: { inventory: [] } }] };
    });
    mocks.hasSiteAnalysisWorker.mockResolvedValue(false);
    const response = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-request-id")).toBe(row.request_id);
    expect(await response.json()).toMatchObject({ replayed: true, analysis: { result: { inventory: [] } } });
    expect(mocks.hasSiteAnalysisWorker).not.toHaveBeenCalled();
  });

  it("returns a terminal concurrent-insert replay with its result and HTTP 200", async () => {
    const { siteAnalysisFingerprint } = await import("@/lib/site-analysis");
    const fingerprint = siteAnalysisFingerprint({
      targetUrl: "https://example.com/",
      confirmedDomain: "example.com",
      limits: {},
    });
    mocks.query.mockReset();
    mocks.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{
        ...row,
        request_fingerprint: fingerprint,
        status: "ready",
        stage: "ready",
        progress: 100,
        result: { inventory: [] },
      }] });
    const response = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ replayed: true, analysis: { status: "ready", result: { inventory: [] } } });
  });

  it("terminalizes an unconfirmed row when Redis cannot accept it", async () => {
    mocks.enqueueSiteAnalysis.mockRejectedValue(new Error("redis_offline"));
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("where user_id = $1 and idempotency_key = $2")) return { rows: [] };
      if (sql.includes("insert into site_analysis_jobs")) return { rows: [row] };
      if (sql.includes("error_code = 'queue_unavailable'")) {
        return { rows: [{ ...row, status: "failed", stage: "failed", error_code: "queue_unavailable", error_message: "Фоновый анализ временно недоступен." }] };
      }
      return { rows: [] };
    });
    const response = await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "queue_unavailable", analysis: { status: "failed" } });
  });

  it("scopes the same client idempotency key independently per project", async () => {
    mocks.query.mockImplementation(async (sql: string, values?: unknown[]) => {
      if (sql.includes("idempotency_key in ($3, $4)")) return { rows: [] };
      if (sql.includes("insert into site_analysis_jobs")) return { rows: [{ ...row, request_id: String(values?.[2]) }] };
      if (sql.includes("queue_confirmed_at = now()")) return { rows: [{ ...row, queue_confirmed_at: new Date() }] };
      return { rows: [] };
    });
    await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }, "same-client-key"));
    mocks.requireSelectedProjectPermission.mockResolvedValueOnce({ projectId: 32, userId: 7, role: "owner", version: 1 });
    await POST(request({ url: "https://example.com", confirmedDomain: "example.com", consent: true }, "same-client-key"));
    const insertedKeys = mocks.query.mock.calls
      .filter(([sql]) => String(sql).includes("insert into site_analysis_jobs"))
      .map(([, values]) => values[3]);
    expect(insertedKeys).toEqual(["project:31:same-client-key", "project:32:same-client-key"]);
  });
});
