import { describe, expect, it } from "vitest";

import { extractSitePage } from "../site-crawler.mjs";
import { buildSiteEvidenceSnapshot } from "./evidence.mjs";
import {
  aggregateSiteInterviewReport,
  buildSiteInterviewPrompt,
  createSiteInterviewBatches,
  parseAndValidateSiteInterviewBatch,
  siteInterviewProviderKey,
  siteInterviewSemanticKey,
} from "./interview.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "./questions.data.mjs";

function snapshot() {
  const page = extractSitePage(`<html><head><title>Аврора</title></head><body><main>
    <h1>Анализ сайтов</h1><p>Доказательные обзоры организаций.</p>
  </main></body></html>`, "https://example.com/");
  return buildSiteEvidenceSnapshot({ confirmedDomain: "example.com", pages: [page], checkedAt: "2026-08-05T12:00:00Z" });
}

function insufficient(questionId) {
  return {
    questionId,
    status: "insufficient_data",
    shortAnswer: "Проверяемых данных недостаточно.",
    explanation: "В переданном срезе нет необходимых подтверждений.",
    facts: [],
    evidenceIds: [],
    confidence: "none",
    contradictions: [],
    gaps: ["Нужен дополнительный содержательный источник."],
    requiredIntegrations: [],
    recommendationHooks: [],
  };
}

describe("site OSINT interview contract", () => {
  it("builds bounded batches and a stable provider identity", () => {
    const batches = createSiteInterviewBatches();
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.flatMap((batch) => batch.questions)).toHaveLength(SITE_INTERVIEW_QUESTIONS.length);
    const input = { analysisId: 41, runRevision: 2, batchId: batches[0].id, snapshotHash: snapshot().snapshotHash };
    expect(siteInterviewSemanticKey(input)).toContain("site-analysis:41:r2:site-osint-interview-v1:site-osint-questions-v1:batch_01:sha256:");
    expect(siteInterviewProviderKey(input)).toMatch(/^[a-f0-9]{64}$/u);
    expect(siteInterviewProviderKey(input)).toBe(siteInterviewProviderKey(input));
  });

  it("serializes only structured untrusted evidence and never full HTML or secrets", () => {
    const current = snapshot();
    const batch = createSiteInterviewBatches()[0];
    const prompt = buildSiteInterviewPrompt({ snapshot: current, questions: batch.questions, batchId: batch.id });
    expect(prompt.system).toMatch(/недоверенные данные/u);
    expect(prompt.user).not.toContain("<html");
    expect(prompt.user).not.toContain("cookie");
    const body = JSON.parse(prompt.user);
    expect(body.evidence.every((item) => item.untrustedContent === true)).toBe(true);
    expect(body.questions).toHaveLength(batch.questions.length);
  });

  it("accepts a complete strict batch and rejects invented evidence", () => {
    const current = snapshot();
    const batch = createSiteInterviewBatches()[0];
    const prompt = buildSiteInterviewPrompt({ snapshot: current, questions: batch.questions, batchId: batch.id });
    const valid = JSON.stringify({
      batchId: batch.id,
      reportStatus: "complete",
      answers: batch.questions.map((question) => insufficient(question.id)),
    });
    expect(parseAndValidateSiteInterviewBatch(valid, {
      batchId: batch.id,
      questions: batch.questions,
      evidenceIds: prompt.evidenceIds,
      entityIds: prompt.entityIds,
    })).toMatchObject({ ok: true });

    const invented = JSON.parse(valid);
    invented.answers[0] = {
      ...invented.answers[0],
      status: "answered",
      confidence: "high",
      evidenceIds: ["ev_invented"],
      facts: [{ statement: "Выдуманный факт", evidenceIds: ["ev_invented"] }],
      gaps: [],
    };
    expect(parseAndValidateSiteInterviewBatch(JSON.stringify(invented), {
      batchId: batch.id,
      questions: batch.questions,
      evidenceIds: prompt.evidenceIds,
      entityIds: prompt.entityIds,
    })).toMatchObject({ ok: false, error: "schema_invalid" });
  });

  it("requires exact coverage and calculates matching summary", () => {
    const batches = createSiteInterviewBatches();
    const completed = batches.map((batch) => ({
      answers: batch.questions.map((question) => insufficient(question.id)),
    }));
    const report = aggregateSiteInterviewReport({
      questions: SITE_INTERVIEW_QUESTIONS,
      batches: completed,
      snapshotHash: snapshot().snapshotHash,
      coverage: { mode: "site_only" },
    });
    expect(report.answers).toHaveLength(SITE_INTERVIEW_QUESTIONS.length);
    expect(report.summary).toEqual({ answered: 0, hypothesis: 0, conflicting: 0, insufficientData: SITE_INTERVIEW_QUESTIONS.length, total: SITE_INTERVIEW_QUESTIONS.length });
    expect(report.reportStatus).toBe("complete");
    expect(report.marketingPlan.measurement).toEqual(expect.arrayContaining([
      expect.objectContaining({ requiredIntegration: "CRM", confidence: "requires_integration" }),
    ]));
  });
});
