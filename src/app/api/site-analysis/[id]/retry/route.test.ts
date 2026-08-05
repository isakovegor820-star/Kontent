import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  hasSiteAnalysisWorker: vi.fn(),
  enqueueSiteAnalysis: vi.fn(),
  poolQuery: vi.fn(),
  txQuery: vi.fn(),
  release: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({ hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin }));
vi.mock("@/lib/site-analysis-queue", () => ({
  hasSiteAnalysisWorker: mocks.hasSiteAnalysisWorker,
  enqueueSiteAnalysis: mocks.enqueueSiteAnalysis,
}));
vi.mock("@/lib/db", () => ({
  getPool: () => ({
    query: mocks.poolQuery,
    connect: vi.fn(async () => ({ query: mocks.txQuery, release: mocks.release })),
  }),
}));

import { POST } from "./route";

const failed = {
  id: "41", request_id: "req-41", target_url: "https://example.com/", confirmed_domain: "example.com",
  status: "failed", stage: "failed", progress: 40, progress_detail: null, limits: {}, result: null,
  error_code: "timeout", error_message: "Сайт не ответил", attempts: 1, run_revision: 1,
  last_retry_key: null, queue_confirmed_at: new Date(), created_at: new Date(), updated_at: new Date(), completed_at: new Date(),
};
const queued = { ...failed, status: "queued", stage: "queued", progress: 0, error_code: null, error_message: null, run_revision: 2, last_retry_key: "site-analysis-retry-1234", completed_at: null };

function request(origin = "http://localhost") {
  return new NextRequest("http://localhost/api/site-analysis/41/retry", {
    method: "POST",
    headers: { origin, "content-type": "application/json", "idempotency-key": "site-analysis-retry-1234" },
    body: JSON.stringify({ clientKey: "site-analysis-retry-1234" }),
  });
}

describe("POST /api/site-analysis/:id/retry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getSessionUser.mockResolvedValue({ id: 7 });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.hasSiteAnalysisWorker.mockResolvedValue(true);
    mocks.enqueueSiteAnalysis.mockResolvedValue({ jobId: "site-analysis-41-r2", recovered: false });
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("for update")) return { rows: [failed] };
      if (sql.includes("run_revision = run_revision + 1")) return { rows: [queued] };
      return { rows: [] };
    });
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...queued, queue_confirmed_at: new Date() }] });
  });

  it("rejects cross-site mutation before auth or queue probing", async () => {
    mocks.hasTrustedMutationOrigin.mockReturnValue(false);
    const response = await POST(request("https://attacker.example"), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(403);
    expect(mocks.getSessionUser).not.toHaveBeenCalled();
    expect(mocks.hasSiteAnalysisWorker).not.toHaveBeenCalled();
  });

  it("increments the durable revision before enqueueing a deterministic retry", async () => {
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(202);
    expect(mocks.txQuery).toHaveBeenCalledWith(expect.stringContaining("run_revision = run_revision + 1"), [41, 7, "site-analysis-retry-1234"]);
    expect(mocks.enqueueSiteAnalysis).toHaveBeenCalledWith({ analysisId: 41, requestId: "req-41", runRevision: 2 });
    expect(await response.json()).toMatchObject({ analysis: { id: 41, runRevision: 2, status: "queued" }, requestId: "req-41" });
    expect(mocks.enqueueSiteAnalysis.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.poolQuery.mock.invocationCallOrder[0]);
  });

  it("replays the same retry key without a second BullMQ add", async () => {
    mocks.hasSiteAnalysisWorker.mockResolvedValue(false);
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("for update")) return { rows: [{ ...failed, last_retry_key: "site-analysis-retry-1234" }] };
      return { rows: [] };
    });
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    expect(mocks.enqueueSiteAnalysis).not.toHaveBeenCalled();
    expect(mocks.hasSiteAnalysisWorker).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ replayed: true, analysis: { status: "failed" } });
  });

  it("replays an already-ready analysis with terminal HTTP status before probing the worker", async () => {
    mocks.hasSiteAnalysisWorker.mockResolvedValue(false);
    mocks.txQuery.mockImplementation(async (sql: string) => {
      if (sql.includes("for update")) {
        return { rows: [{ ...failed, status: "ready", stage: "ready", progress: 100, result: { inventory: [] } }] };
      }
      return { rows: [] };
    });
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(200);
    expect(mocks.hasSiteAnalysisWorker).not.toHaveBeenCalled();
    expect(await response.json()).toMatchObject({ replayed: true, analysis: { status: "ready", result: { inventory: [] } } });
  });

  it("probes the worker only before mutating a new failed revision", async () => {
    mocks.hasSiteAnalysisWorker.mockResolvedValue(false);
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "worker_unavailable" });
    expect(mocks.txQuery).not.toHaveBeenCalledWith(expect.stringContaining("run_revision = run_revision + 1"), expect.anything());
    expect(mocks.enqueueSiteAnalysis).not.toHaveBeenCalled();
  });

  it("terminalizes the exact revision when Redis cannot accept the retry", async () => {
    mocks.enqueueSiteAnalysis.mockRejectedValue(new Error("offline"));
    mocks.poolQuery.mockResolvedValue({ rows: [{ ...queued, status: "failed", stage: "failed", error_code: "queue_unavailable" }] });
    const response = await POST(request(), { params: Promise.resolve({ id: "41" }) });
    expect(response.status).toBe(503);
    expect(mocks.poolQuery).toHaveBeenCalledWith(expect.stringContaining("error_code = 'queue_unavailable'"), [41, 7, 2]);
  });
});
