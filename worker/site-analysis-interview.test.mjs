import { describe, expect, it, vi } from "vitest";

import { extractSitePage } from "../src/lib/site-crawler.mjs";
import { buildSiteEvidenceSnapshot } from "../src/lib/site-analysis/evidence.mjs";
import { SITE_INTERVIEW_EXECUTION_LIMITS, runSiteInterview } from "./site-analysis-interview.mjs";

function snapshot() {
  return buildSiteEvidenceSnapshot({
    confirmedDomain: "example.com",
    checkedAt: "2026-08-05T12:00:00Z",
    pages: [extractSitePage("<html><head><title>Example</title></head><body><main><h1>Example</h1><p>Public evidence.</p></main></body></html>", "https://example.com/")],
  });
}

function answerFor(question) {
  return {
    questionId: question.id,
    status: "insufficient_data",
    shortAnswer: "Недостаточно данных.",
    explanation: "В срезе нет требуемых подтверждений.",
    facts: [],
    evidenceIds: [],
    confidence: "none",
    contradictions: [],
    gaps: ["Нужен дополнительный источник."],
    requiredIntegrations: [],
    recommendationHooks: [],
  };
}

function harness() {
  const rows = new Map();
  const query = vi.fn(async (sql, values) => {
    const normalized = String(sql).replace(/\s+/gu, " ").trim();
    const key = `${values?.[0]}:${values?.[1]}:${values?.[2]}`;
    if (normalized.startsWith("select status, request_fingerprint")) return { rows: rows.has(key) ? [rows.get(key)] : [] };
    if (normalized.startsWith("insert into site_analysis_ai_batches")) {
      rows.set(key, { status: "generating", request_fingerprint: values[5], response_payload: null });
      return { rows: [], rowCount: 1 };
    }
    if (normalized.startsWith("update site_analysis_ai_batches") && normalized.includes("set status = 'ready'")) {
      rows.set(key, { status: "ready", request_fingerprint: values[3], response_payload: JSON.parse(values[5]) });
      return { rows: [{ id: 1 }], rowCount: 1 };
    }
    if (normalized.startsWith("update site_analysis_ai_batches") && normalized.includes("set status = 'failed'")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected query: ${normalized}`);
  });
  return { pool: { query }, rows, query };
}

describe("site analysis AI interview worker", () => {
  it("uses one quota reservation, stable batch keys and returns complete coverage", async () => {
    const h = harness();
    const providerKeys = [];
    const acquireUsage = vi.fn(async () => ({ state: "acquired", reservationId: 91 }));
    const releaseUsage = vi.fn(async () => true);
    const completeAiText = vi.fn(async (request) => {
      providerKeys.push(request.providerRequestKey);
      const body = JSON.parse(request.user);
      return {
        engine: "navy-deepseek-pro",
        text: JSON.stringify({
          batchId: body.outputContract.batchId,
          reportStatus: "complete",
          answers: body.questions.map(answerFor),
        }),
      };
    });
    const result = await runSiteInterview(h.pool, {
      analysisId: 41,
      runRevision: 2,
      userId: 7,
      requestId: "req-41",
      snapshot: snapshot(),
    }, {
      acquireUsage,
      releaseUsage,
      heartbeatUsage: vi.fn(async () => true),
      completeAiText,
    });

    expect(acquireUsage).toHaveBeenCalledTimes(1);
    expect(completeAiText.mock.calls.every(([, options]) => options.allowFallback === false)).toBe(true);
    expect(completeAiText.mock.calls.every(([request, options]) => (
      JSON.parse(request.user).questions.length <= SITE_INTERVIEW_EXECUTION_LIMITS.maxQuestionsPerBatch
      && request.maxTokens === SITE_INTERVIEW_EXECUTION_LIMITS.maxTokens
      && options.timeoutMs === SITE_INTERVIEW_EXECUTION_LIMITS.timeoutMs
    ))).toBe(true);
    expect(new Set(providerKeys).size).toBe(providerKeys.length);
    expect(providerKeys.every((key) => /^[a-f0-9]{64}$/u.test(key))).toBe(true);
    expect(result.report.reportStatus).toBe("complete");
    expect(result.report.answers).toHaveLength(51);
    expect(result.reservationId).toBe(91);
    expect(releaseUsage).not.toHaveBeenCalled();
  });

  it("replays durable ready batches without a second paid provider call", async () => {
    const h = harness();
    const completeAiText = vi.fn(async (request) => {
      const body = JSON.parse(request.user);
      return { engine: "navy-deepseek-pro", text: JSON.stringify({ batchId: body.outputContract.batchId, reportStatus: "complete", answers: body.questions.map(answerFor) }) };
    });
    const deps = {
      acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 91 })),
      releaseUsage: vi.fn(async () => true),
      heartbeatUsage: vi.fn(async () => true),
      completeAiText,
    };
    const input = { analysisId: 41, runRevision: 2, userId: 7, requestId: "req-41", snapshot: snapshot() };
    await runSiteInterview(h.pool, input, deps);
    await runSiteInterview(h.pool, input, deps);
    expect(completeAiText).toHaveBeenCalledTimes(26);
  });

  it.each([
    ["provider timeout", async () => { throw Object.assign(new Error("timeout"), { code: "provider_timeout", status: 504 }); }, "provider_timeout"],
    ["truncated terminal", async () => ({ engine: "navy-deepseek-pro", text: "{\"batchId\":" }), "invalid_json"],
  ])("releases quota on %s and never returns a terminal report", async (_label, completion, expectedCode) => {
    const h = harness();
    const releaseUsage = vi.fn(async () => true);
    const error = await runSiteInterview(h.pool, {
      analysisId: 41,
      runRevision: 2,
      userId: 7,
      requestId: "req-41",
      snapshot: snapshot(),
    }, {
      acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 91 })),
      releaseUsage,
      heartbeatUsage: vi.fn(async () => true),
      completeAiText: completion,
    }).catch((value) => value);
    expect(error.code).toBe(expectedCode === "invalid_json" ? "schema_invalid" : expectedCode);
    expect(releaseUsage).toHaveBeenCalledWith(h.pool, 7, 91);
  });

  it("repairs schema-only omissions without a second provider call", async () => {
    const h = harness();
    const releaseUsage = vi.fn(async () => true);
    const completeAiText = vi.fn(async (request) => {
      const body = JSON.parse(request.user);
      return {
        engine: "navy-gpt-5-4",
        text: JSON.stringify({ batchId: body.outputContract.batchId, reportStatus: "complete", answers: [] }),
      };
    });
    const result = await runSiteInterview(h.pool, {
      analysisId: 41,
      runRevision: 2,
      userId: 7,
      requestId: "req-41",
      snapshot: snapshot(),
      engine: "navy-gpt-5-4",
    }, {
      acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 91 })),
      releaseUsage,
      heartbeatUsage: vi.fn(async () => true),
      completeAiText,
    });
    expect(result.report).toMatchObject({ reportStatus: "complete", summary: { insufficientData: 51 } });
    expect(completeAiText).toHaveBeenCalledTimes(26);
    expect(releaseUsage).not.toHaveBeenCalled();
  });

  it("retries a transient provider failure inside one immutable batch identity", async () => {
    const h = harness();
    const providerKeys = [];
    let calls = 0;
    const completeAiText = vi.fn(async (request) => {
      providerKeys.push(request.providerRequestKey);
      calls += 1;
      if (calls === 1) throw Object.assign(new Error("truncated"), { code: "stream_truncated", status: 502 });
      const body = JSON.parse(request.user);
      return {
        engine: "navy-gpt-5-4",
        text: JSON.stringify({
          batchId: body.outputContract.batchId,
          reportStatus: "complete",
          answers: body.questions.map(answerFor),
        }),
      };
    });
    const result = await runSiteInterview(h.pool, {
      analysisId: 41,
      runRevision: 2,
      userId: 7,
      requestId: "req-41",
      snapshot: snapshot(),
      engine: "navy-gpt-5-4",
    }, {
      acquireUsage: vi.fn(async () => ({ state: "acquired", reservationId: 91 })),
      releaseUsage: vi.fn(async () => true),
      heartbeatUsage: vi.fn(async () => true),
      completeAiText,
    });
    expect(result.report.answers).toHaveLength(51);
    expect(completeAiText).toHaveBeenCalledTimes(27);
    expect(providerKeys[0]).toBe(providerKeys[1]);
  });
});
