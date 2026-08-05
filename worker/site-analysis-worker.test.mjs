import { describe, expect, it, vi } from "vitest";

import { SiteCrawlerError } from "../src/lib/site-crawler.mjs";
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

    await expect(processSiteAnalysisJob(pool, { analysisId: 41, runRevision: 2 }, { crawl, leaseToken: "lease-1" })).resolves.toMatchObject({ ok: true, pages: 1 });
    expect(crawl).toHaveBeenCalledWith(expect.objectContaining({ confirmedDomain: "example.com", consent: true }), expect.any(Object));
    expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("insert into site_analysis_pages"), expect.arrayContaining([41, "https://example.com/", 200]));
    expect(txQuery.mock.calls.filter(([sql]) => String(sql).includes("insert into site_analysis_pages"))).toHaveLength(1);
    expect(txQuery).toHaveBeenCalledWith(expect.stringContaining("status = 'ready'"), expect.arrayContaining([41, 2]));
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
});
