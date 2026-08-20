import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSessionUser: vi.fn(),
  hasTrustedMutationOrigin: vi.fn(),
  getPool: vi.fn(),
  hasSiteAnalysisWorker: vi.fn(),
  enqueueSiteAnalysis: vi.fn(),
  requireSelectedProjectPermission: vi.fn(),
}));

vi.mock("@/lib/session", () => ({ getSessionUser: mocks.getSessionUser }));
vi.mock("@/lib/request-origin", () => ({
  hasTrustedMutationOrigin: mocks.hasTrustedMutationOrigin,
}));
vi.mock("@/lib/db", () => ({ getPool: mocks.getPool }));
vi.mock("@/lib/project-permissions", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/project-permissions")>(),
  requireSelectedProjectPermission: mocks.requireSelectedProjectPermission,
}));
vi.mock("@/lib/site-analysis-queue", () => ({
  hasSiteAnalysisWorker: mocks.hasSiteAnalysisWorker,
  enqueueSiteAnalysis: mocks.enqueueSiteAnalysis,
}));

import { POST } from "@/app/api/site-analysis/route";
import { SITE_INTERVIEW_QUESTIONS } from "@/lib/site-analysis/questions.data.mjs";
import { processSiteAnalysisJob } from "../../worker/site-analysis-worker.mjs";

type JobStatus = "queued" | "crawling" | "analyzing" | "planning" | "saving" | "ready" | "failed";

type DurableJob = {
  id: number;
  user_id: number;
  project_id: number;
  request_id: string;
  idempotency_key: string;
  request_fingerprint: string;
  target_url: string;
  confirmed_domain: string;
  status: JobStatus;
  stage: string;
  progress: number;
  progress_detail: string | null;
  limits: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  run_revision: number;
  queue_confirmed_at: Date | null;
  worker_lease_token: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
  prompt_version: string | null;
  question_catalog_version: string | null;
  snapshot_hash: string | null;
  coverage_mode: string | null;
  answered_count: number;
  question_count: number;
  ai_usage_reservation_id: number | null;
};

const USER_ID = 7;
const PROJECT_ID = 31;
const ANALYSIS_ID = 41;
const RESERVATION_ID = 91;
const SNAPSHOT_HASH = `sha256:${"a".repeat(64)}`;

function request(key = "site-analysis-authenticated-contract") {
  return new NextRequest("http://localhost/api/site-analysis", {
    method: "POST",
    headers: {
      origin: "http://localhost",
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({
      url: "https://example.com",
      confirmedDomain: "example.com",
      consent: true,
      limits: { maxPages: 5 },
    }),
  });
}

function insufficientAnswer(question: (typeof SITE_INTERVIEW_QUESTIONS)[number]) {
  return {
    questionId: question.id,
    status: "insufficient_data",
    shortAnswer: "Недостаточно публичных данных.",
    explanation: "Snapshot не содержит проверяемого ответа.",
    facts: [],
    evidenceIds: [],
    confidence: "none",
    contradictions: [],
    gaps: ["Нужен дополнительный публичный источник."],
    requiredIntegrations: [],
    recommendationHooks: [],
  };
}

describe("authenticated site-analysis terminal contract", () => {
  let durable: DurableJob | null;
  let queuedJob: { analysisId: number; requestId: string; runRevision: number } | null;
  let quota: "none" | "reserved" | "committed" | "released";
  let storedAnswers: number;

  beforeEach(() => {
    vi.clearAllMocks();
    durable = null;
    queuedJob = null;
    quota = "none";
    storedAnswers = 0;

    mocks.getSessionUser.mockResolvedValue({ id: USER_ID });
    mocks.hasTrustedMutationOrigin.mockReturnValue(true);
    mocks.hasSiteAnalysisWorker.mockResolvedValue(true);
    mocks.requireSelectedProjectPermission.mockResolvedValue({
      projectId: PROJECT_ID, userId: USER_ID, role: "owner", version: 1,
    });
    mocks.enqueueSiteAnalysis.mockImplementation(async (job) => {
      queuedJob = structuredClone(job);
      return { jobId: `site-analysis-${job.analysisId}-r${job.runRevision}`, recovered: false };
    });

    const txQuery = vi.fn(async (sqlValue: string, values: unknown[] = []) => {
      const sql = String(sqlValue);
      if (sql === "begin" || sql === "rollback") return { rows: [], rowCount: 0 };
      if (sql === "commit") return { rows: [], rowCount: 0 };
      if (sql.includes("select status, run_revision, worker_lease_token")) {
        return { rows: durable ? [{
          status: durable.status,
          run_revision: durable.run_revision,
          worker_lease_token: durable.worker_lease_token,
        }] : [] };
      }
      if (sql.includes("insert into site_analysis_answers")) {
        storedAnswers += 1;
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes("insert into site_analysis_")) return { rows: [], rowCount: 1 };
      if (sql.includes("delete from site_analysis_pages")) return { rows: [], rowCount: 0 };
      if (sql.includes("insert into site_analysis_pages")) return { rows: [], rowCount: 1 };
      if (sql.includes("set status = 'ready'")) {
        if (!durable || durable.worker_lease_token !== values[3]) return { rows: [] };
        durable.status = "ready";
        durable.stage = "ready";
        durable.progress = 100;
        durable.progress_detail = "OSINT-интервью и маркетинговый план готовы";
        durable.result = JSON.parse(String(values[2]));
        durable.prompt_version = String(values[4]);
        durable.question_catalog_version = String(values[5]);
        durable.snapshot_hash = String(values[6]);
        durable.coverage_mode = "site_only";
        durable.answered_count = Number(values[7]);
        durable.question_count = Number(values[8]);
        durable.ai_usage_reservation_id = Number(values[9]);
        durable.completed_at = new Date("2026-08-05T12:01:00.000Z");
        return { rows: [{ id: durable.id }], rowCount: 1 };
      }
      throw new Error(`Unexpected transaction query: ${sql.slice(0, 120)}`);
    });

    const pool = {
      query: vi.fn(async (sqlValue: string, values: unknown[] = []) => {
        const sql = String(sqlValue);
        if (sql.includes("where project_id = $1 and user_id = $2 and idempotency_key in")) {
          const matches = durable
            && durable.project_id === Number(values[0])
            && durable.user_id === Number(values[1])
            && [String(values[2]), String(values[3])].includes(durable.idempotency_key);
          return { rows: matches ? [durable] : [], rowCount: matches ? 1 : 0 };
        }
        if (sql.includes("insert into site_analysis_jobs")) {
          const now = new Date("2026-08-05T12:00:00.000Z");
          durable = {
            id: ANALYSIS_ID,
            project_id: Number(values[0]),
            user_id: Number(values[1]),
            request_id: String(values[2]),
            idempotency_key: String(values[3]),
            request_fingerprint: String(values[4]),
            target_url: String(values[5]),
            confirmed_domain: String(values[6]),
            status: "queued",
            stage: "queued",
            progress: 0,
            progress_detail: null,
            limits: JSON.parse(String(values[7])),
            result: null,
            error_code: null,
            error_message: null,
            attempts: 0,
            run_revision: 1,
            queue_confirmed_at: null,
            worker_lease_token: null,
            created_at: now,
            updated_at: now,
            completed_at: null,
            prompt_version: null,
            question_catalog_version: null,
            snapshot_hash: null,
            coverage_mode: null,
            answered_count: 0,
            question_count: 0,
            ai_usage_reservation_id: null,
          };
          return { rows: [durable], rowCount: 1 };
        }
        if (sql.includes("queue_confirmed_at = now()")) {
          if (durable) durable.queue_confirmed_at = new Date("2026-08-05T12:00:01.000Z");
          return { rows: durable ? [durable] : [], rowCount: durable ? 1 : 0 };
        }
        if (sql.includes("set status = 'crawling'") && sql.includes("returning id, user_id")) {
          if (!durable || !durable.queue_confirmed_at || durable.status !== "queued") return { rows: [] };
          durable.status = "crawling";
          durable.stage = "robots";
          durable.worker_lease_token = String(values[2]);
          durable.attempts += 1;
          return { rows: [durable], rowCount: 1 };
        }
        if (sql.includes("update site_analysis_jobs") && durable) {
          if (sql.includes("stage = 'extracting'")) durable.stage = "extracting";
          else if (sql.includes("stage = 'resolving_entities'")) durable.stage = "resolving_entities";
          else if (sql.includes("stage = 'validating'")) durable.stage = "validating";
          else if (sql.includes("stage = 'planning'")) durable.stage = "planning";
          else if (sql.includes("stage = 'saving'")) durable.stage = "saving";
          durable.status = durable.stage === "planning" ? "planning" : durable.stage === "saving" ? "saving" : "analyzing";
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`Unexpected pool query: ${sql.slice(0, 120)}`);
      }),
      connect: vi.fn(async () => ({ query: txQuery, release: vi.fn() })),
    };
    mocks.getPool.mockReturnValue(pool);
  });

  it("keeps one idempotent authenticated request through BullMQ processing, terminal save and quota commit", async () => {
    const created = await POST(request());
    expect(created.status).toBe(202);
    expect(await created.json()).toMatchObject({
      ok: true,
      replayed: false,
      analysis: { id: ANALYSIS_ID, status: "queued" },
    });
    expect(queuedJob).toMatchObject({ analysisId: ANALYSIS_ID, runRevision: 1 });

    const answers = SITE_INTERVIEW_QUESTIONS.map(insufficientAnswer);
    const release = vi.fn(async () => {
      quota = "released";
      return true;
    });
    const workerResult = await processSiteAnalysisJob(
      mocks.getPool(),
      queuedJob,
      {
        leaseToken: "lease-terminal-contract",
        crawl: vi.fn(async () => ({
          pages: [{
            url: "https://example.com/",
            status: 200,
            title: "Example",
            description: "Public site",
            headings: [{ level: 1, text: "Example" }],
            mainContent: "Public content",
            schemaTypes: ["WebPage"],
            links: [],
            ctas: [],
            forms: [],
            publicComments: [],
            technical: { wordCount: 2 },
          }],
          report: { policyVersion: "site-crawler-v1", inventory: [] },
        })),
        buildSnapshot: vi.fn(() => ({
          version: "site-osint-snapshot-v1",
          snapshotHash: SNAPSHOT_HASH,
          coverage: { mode: "site_only", confirmedDomain: "example.com" },
          sources: [],
          evidence: [],
          entities: [],
          relations: [],
        })),
        runInterview: vi.fn(async () => {
          quota = "reserved";
          return {
            report: {
              reportStatus: "complete",
              answers,
              recommendations: [],
              summary: { total: answers.length, insufficientData: answers.length },
            },
            reservationId: RESERVATION_ID,
            userId: USER_ID,
            quotaState: "acquired",
            release,
          };
        }),
        finalizeUsage: vi.fn(async (_client, userId, reservationId, state) => {
          expect([userId, reservationId, state]).toEqual([USER_ID, RESERVATION_ID, "committed"]);
          expect(quota).toBe("reserved");
          quota = "committed";
          return { changed: true, status: "committed" };
        }),
      },
    );

    expect(workerResult).toMatchObject({
      ok: true,
      analysisId: ANALYSIS_ID,
      questions: SITE_INTERVIEW_QUESTIONS.length,
      snapshotHash: SNAPSHOT_HASH,
    });
    expect(durable).toMatchObject({
      status: "ready",
      stage: "ready",
      answered_count: SITE_INTERVIEW_QUESTIONS.length,
      question_count: SITE_INTERVIEW_QUESTIONS.length,
      snapshot_hash: SNAPSHOT_HASH,
    });
    expect(storedAnswers).toBe(SITE_INTERVIEW_QUESTIONS.length);
    expect(quota).toBe("committed");
    expect(release).not.toHaveBeenCalled();

    const replay = await POST(request());
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,
      replayed: true,
      analysis: {
        id: ANALYSIS_ID,
        status: "ready",
        result: { osint: { reportStatus: "complete" } },
      },
    });
    expect(mocks.enqueueSiteAnalysis).toHaveBeenCalledTimes(1);
  });
});
