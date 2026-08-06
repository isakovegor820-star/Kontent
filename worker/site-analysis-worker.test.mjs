import { describe, expect, it, vi } from "vitest";

import { SiteCrawlerError } from "../src/lib/site-crawler.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "../src/lib/site-analysis/questions.data.mjs";
import { processSiteAnalysisJob } from "./site-analysis-worker.mjs";

function analysisRow() {
  return {
    id: 41,
    user_id: 7,
    request_id: "req-41",
    target_url: "https://example.com/",
    confirmed_domain: "example.com",
    limits: { maxPages: 5 },
    run_revision: 2,
    created_at: "2026-08-05T12:00:00Z",
  };
}

const testSnapshot = Object.freeze({
  version: "site-osint-snapshot-v1",
  snapshotHash: `sha256:${"a".repeat(64)}`,
  coverage: { mode: "site_only", confirmedDomain: "example.com" },
  sources: [],
  evidence: [],
  entities: [],
  relations: [],
});

function interviewAnswer(question) {
  return {
    questionId: question.id,
    status: "insufficient_data",
    shortAnswer: "Недостаточно данных.",
    explanation: "Нет подтверждений.",
    facts: [],
    evidenceIds: [],
    confidence: "none",
    contradictions: [],
    gaps: ["Нужен источник."],
    requiredIntegrations: [],
    recommendationHooks: [],
  };
}

function interviewResult(release = vi.fn(async () => true)) {
  return {
    report: {
      reportStatus: "complete",
      answers: SITE_INTERVIEW_QUESTIONS.map(interviewAnswer),
      recommendations: [],
      summary: { insufficientData: SITE_INTERVIEW_QUESTIONS.length, total: SITE_INTERVIEW_QUESTIONS.length },
    },
    reservationId: 91,
    userId: 7,
    quotaState: "acquired",
    release,
  };
}

describe("site analysis BullMQ worker core", () => {
  it("claims only the confirmed revision and atomically stores pages before ready", async () => {
    const txQuery = vi.fn(async (sql) => {
      if (String(sql).includes("select status, run_revision")) return { rows: [{ status: "analyzing", run_revision: 2, worker_lease_token: "lease-1" }] };
      if (String(sql).includes("update site_analysis_jobs") && String(sql).includes("returning id")) return { rows: [{ id: 41 }] };
      return { rows: [] };
    });
    const release = vi.fn();
    const pool = {
      query: vi.fn(async (sql) => String(sql).includes("returning id, user_id") ? { rows: [analysisRow()] } : { rows: [] }),
      connect: vi.fn(async () => ({ query: txQuery, release })),
    };
    const crawl = vi.fn(async (_input, deps) => {
      await deps.onProgress({ stage: "crawling", progress: 40, detail: "Страница 1" });
      await deps.onProgress({ stage: "analyzing", progress: 80, detail: "Аудит" });
      const page = {
        url: "https://example.com/", status: 200, title: "Главная", description: "Описание",
        headings: [{ level: 1, text: "Главная" }], mainContent: "Контент", schemaTypes: ["WebPage"],
        links: [], ctas: [], forms: [], publicComments: [], technical: { wordCount: 1 },
      };
      return {
        pages: [page, { ...page }],
        report: { policyVersion: "v1", inventory: [{ url: "https://example.com/" }] },
      };
    });
    const finalizeUsage = vi.fn(async () => ({ changed: true, status: "committed" }));

    const runInterview = vi.fn(async () => interviewResult());
    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      crawl,
      leaseToken: "lease-1",
      engine: "navy-gpt-5-4",
      buildSnapshot: vi.fn(() => testSnapshot),
      runInterview,
      finalizeUsage,
    })).resolves.toMatchObject({ ok: true, pages: 1, questions: SITE_INTERVIEW_QUESTIONS.length });
    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({ confirmedDomain: "example.com", consent: true }), expect.any(Object));
    expect(runInterview).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ engine: "navy-gpt-5-4" }), expect.any(Object));
    expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("insert into site_analysis_pages"), expect.arrayContaining([41, "https://example.com/", 200]));
    expect(txQuery.mock.calls.filter(([sql]) => String(sql).includes("insert into site_analysis_pages"))).toHaveLength(1);
    expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), expect.arrayContaining([41, 2]));
    expect(finalizeUsage).toHaveBeenCalledWith(expect.any(Object), 7, 91, "committed");
    expect(release).toHaveBeenCalled();
  });

  it("makes a stale or terminal BullMQ delivery inert", async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    const crawl = vi.fn();
    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 1 }, { crawl })).resolves.toEqual({
      ok: true,
      skipped: "stale_or_terminal",
    });
    expect(crawl).not.toHaveBeenCalled();
  });

  it("retries a delivery that beats the producer confirmation instead of acknowledging it", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: "queued", run_revision: 2, queue_confirmed_at: null }] }),
    };
    const crawl = vi.fn();

    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      crawl,
      finalAttempt: false,
    })).rejects.toMatchObject({ code: "queue_unconfirmed" });
    expect(crawl).not.toHaveBeenCalled();
    expect(pool.query).toHaveBeenCalledTimes(2);
  });

  it("terminalizes an unconfirmed delivery after BullMQ exhausts its attempts", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: "queued", run_revision: 2, queue_confirmed_at: null }] })
        .mockResolvedValueOnce({ rows: [{ id: 41 }] }),
    };
    const crawl = vi.fn();

    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      crawl,
      finalAttempt: true,
    })).rejects.toMatchObject({ code: "queue_unconfirmed" });
    expect(crawl).not.toHaveBeenCalled();
    expect(pool.query.mock.calls[2]).toEqual([
      expect.stringContaining("error_code = 'queue_unconfirmed'"),
      [41, 2, "Фоновая очередь не подтвердила запуск анализа."],
    ]);
  });

  it("reclaims the same delivery when confirmation lands between claim reads", async () => {
    const txQuery = vi.fn(async (sql) => {
      if (String(sql).includes("select status, run_revision")) {
        return { rows: [{ status: "analyzing", run_revision: 2, worker_lease_token: "lease-race" }] };
      }
      if (String(sql).includes("status = 'ready'")) return { rows: [{ id: 41 }] };
      return { rows: [] };
    });
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [] })
        .mockResolvedValueOnce({ rows: [{ status: "queued", run_revision: 2, queue_confirmed_at: new Date() }] })
        .mockResolvedValueOnce({ rows: [analysisRow()] }),
      connect: vi.fn(async () => ({ query: txQuery, release: vi.fn() })),
    };
    const crawl = vi.fn().mockResolvedValue({ pages: [], report: { inventory: [] } });

    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      crawl,
      leaseToken: "lease-race",
      buildSnapshot: vi.fn(() => testSnapshot),
      runInterview: vi.fn(async () => interviewResult()),
      finalizeUsage: vi.fn(async () => ({ changed: true, status: "committed" })),
    })).resolves.toMatchObject({ ok: true, pages: 0 });
    expect(crawl).toHaveBeenCalledOnce();
  });

  it("returns a retryable job to queued before BullMQ's next attempt", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [analysisRow()] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    const secretProviderMessage = "timeout while requesting https://example.com/?token=secret";
    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      finalAttempt: false,
      crawl: vi.fn().mockRejectedValue(Object.assign(new Error(secretProviderMessage), { code: "timeout" })),
    })).rejects.toMatchObject({ code: "timeout", message: "Сайт не ответил в пределах безопасного времени." });
    const update = pool.query.mock.calls[1];
    expect(update[0]).toContain("status = 'queued'");
    expect(JSON.stringify(update)).not.toContain("token=secret");
  });

  it("rolls back ready and releases quota when atomic quota commit cannot be confirmed", async () => {
    const releaseQuota = vi.fn(async () => true);
    const txQuery = vi.fn(async (sql) => {
      const source = String(sql);
      if (source.includes("select status, run_revision")) {
        return { rows: [{ status: "saving", run_revision: 2, worker_lease_token: "lease-quota" }] };
      }
      if (source.includes("status = 'ready'") && source.includes("returning id")) return { rows: [{ id: 41 }] };
      return { rows: [] };
    });
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [analysisRow()] })
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({ query: txQuery, release: vi.fn() })),
    };
    const error = await processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      finalAttempt: true,
      leaseToken: "lease-quota",
      crawl: vi.fn(async () => ({ pages: [], report: { inventory: [] } })),
      buildSnapshot: vi.fn(() => testSnapshot),
      runInterview: vi.fn(async () => interviewResult(releaseQuota)),
      finalizeUsage: vi.fn(async () => ({ changed: false, status: "expired" })),
    }).catch((value) => value);

    expect(error).toMatchObject({ code: "quota_commit_failed" });
    expect(txQuery).toHaveBeenCalledWith("rollback");
    expect(releaseQuota).toHaveBeenCalledOnce();
    const readyIndex = txQuery.mock.calls.findIndex(([sql]) => String(sql).includes("status = 'ready'"));
    const rollbackIndex = txQuery.mock.calls.findIndex(([sql]) => String(sql) === "rollback");
    expect(readyIndex).toBeGreaterThan(-1);
    expect(rollbackIndex).toBeGreaterThan(readyIndex);
  });

  it("terminalizes a permanent crawler denial with a safe public message", async () => {
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [analysisRow()] })
        .mockResolvedValueOnce({ rows: [] }),
    };
    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      finalAttempt: false,
      crawl: vi.fn().mockRejectedValue(new SiteCrawlerError("robots_denied", "raw")),
    })).rejects.toMatchObject({ code: "robots_denied" });
    expect(pool.query.mock.calls[1][0]).toContain("status = 'failed'");
    expect(pool.query.mock.calls[1][1]).toEqual([
      41,
      2,
      "robots_denied",
      "robots.txt запрещает анализ указанной страницы.",
      expect.any(String),
    ]);
  });

  it("does not recrawl after an unexpected terminal saving failure and exposes only safe diagnostics", async () => {
    const txQuery = vi.fn(async (sql) => {
      if (String(sql).includes("select status, run_revision")) {
        return { rows: [{ status: "saving", run_revision: 2, worker_lease_token: "lease-db" }] };
      }
      if (String(sql).includes("insert into site_analysis_pages")) {
        throw Object.assign(new Error("secret row content"), {
          code: "22021",
          constraint: "site_analysis_pages_content_check",
        });
      }
      return { rows: [] };
    });
    const pool = {
      query: vi.fn()
        .mockResolvedValueOnce({ rows: [analysisRow()] })
        .mockResolvedValue({ rows: [] }),
      connect: vi.fn(async () => ({ query: txQuery, release: vi.fn() })),
    };

    const error = await processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, {
      finalAttempt: false,
      leaseToken: "lease-db",
      crawl: vi.fn(async () => ({
        pages: [{ url: "https://example.com/", status: 200, title: "A" }],
        report: { inventory: [] },
      })),
      buildSnapshot: vi.fn(() => testSnapshot),
      runInterview: vi.fn(async () => interviewResult()),
    }).catch((value) => value);

    expect(error).toMatchObject({
      code: "worker_failed",
      message: "Не удалось завершить анализ сайта.",
      technical: {
        pgCode: "22021",
        constraint: "site_analysis_pages_content_check",
        errorName: "Error",
      },
    });
    expect(JSON.stringify(error)).not.toContain("secret row content");
    expect(pool.query.mock.calls.at(-1)?.[0]).toContain("status = 'failed'");
  });
});
