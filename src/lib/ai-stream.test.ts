import { describe, expect, it } from "vitest";
import { encodeAiStreamEvent, finalizeAiClientStream, parseAiStreamBuffer } from "./ai-stream";

describe("AI NDJSON stream", () => {
  it("сохраняет неполную строку между сетевыми chunks", () => {
    const first = parseAiStreamBuffer('{"type":"phase","requestId":"r1","phase":"draft"}\n{"type":"del');
    expect(first.events).toEqual([{ type: "phase", requestId: "r1", phase: "draft" }]);
    expect(first.rest).toBe('{"type":"del');
    const second = parseAiStreamBuffer(`${first.rest}ta","requestId":"r1","text":"Привет"}\n`);
    expect(second.events).toEqual([{ type: "delta", requestId: "r1", text: "Привет" }]);
    expect(second.rest).toBe("");
  });

  it("кодирует одно событие в одну строку", () => {
    expect(new TextDecoder().decode(encodeAiStreamEvent({ type: "done", requestId: "r1", pipeline: "editorial" }))).toBe(
      '{"type":"done","requestId":"r1","pipeline":"editorial"}\n',
    );
  });

  it("preserves the fail-closed semantic review state", () => {
    const provenance = {
      validatorVersion: "fact-ledger-v1" as const,
      ledgerHash: "abc",
      checkedAt: "2026-08-01T12:00:00.000Z",
      coverage: "deterministic" as const,
      semanticEntailment: "not_checked" as const,
      semanticAdapter: "unavailable",
      rulesRun: ["required_facts"],
      sourceIds: ["brief"],
    };
    const line = new TextDecoder().decode(encodeAiStreamEvent({
      type: "validation",
      requestId: "r1",
      status: "not_checked",
      requiresReview: true,
      provenance,
      blockerCodes: [],
    }));
    expect(parseAiStreamBuffer(line).events).toEqual([{
      type: "validation",
      requestId: "r1",
      status: "not_checked",
      requiresReview: true,
      provenance,
      blockerCodes: [],
    }]);
  });

  it("preserves exactly one explicit model suggestion on a terminal error", () => {
    const event = {
      type: "error" as const,
      requestId: "r1",
      error: "provider_timeout",
      engine: "navy-deepseek-pro",
      label: "DeepSeek Pro (NavyAI)",
      retryable: true,
      suggestedEngine: {
        id: "navy-deepseek-flash",
        label: "DeepSeek Flash",
        vendor: "NavyAI",
      },
    };

    expect(parseAiStreamBuffer(new TextDecoder().decode(encodeAiStreamEvent(event))).events).toEqual([event]);
  });

  it("сохраняет причины строгой проверки в терминальной ошибке", () => {
    const event = {
      type: "error" as const,
      requestId: "r-settings",
      error: "post_validation_failed",
      engine: "local",
      label: "Hermes 3 (Локально)",
      retryable: false,
      issues: ["Нужно ровно одно прямое матерное слово", "Нужно ровно два эмодзи"],
    };

    expect(parseAiStreamBuffer(new TextDecoder().decode(encodeAiStreamEvent(event))).events).toEqual([event]);
  });

  it("пропускает только известные структурированные события", () => {
    const parsed = parseAiStreamBuffer([
      '{"type":"delta","requestId":"r1","text":"ok"}',
      '{"type":"delta","requestId":"r1","text":42}',
      '{"type":"unknown","apiKey":"secret"}',
      '{"type":"telemetry","requestId":"r1","engine":"local","primary":true,"attempt":1,"outcome":"started"}',
      "",
    ].join("\n"));
    expect(parsed.events).toEqual([
      { type: "delta", requestId: "r1", text: "ok" },
      { type: "telemetry", requestId: "r1", engine: "local", primary: true, attempt: 1, outcome: "started" },
    ]);
  });
});

describe("Studio terminal contract", () => {
  it("never makes partial text postable when validation or done is missing", () => {
    expect(finalizeAiClientStream({
      text: "частичный текст",
      failed: false,
      validationReceived: true,
      doneReceived: false,
      validationBlocked: false,
      validationRequiresReview: false,
    })).toEqual({ status: "truncated", partialText: "частичный текст" });
  });

  it("makes every complete terminal text ready for a post", () => {
    expect(finalizeAiClientStream({
      text: "готовый черновик",
      failed: false,
      validationReceived: true,
      doneReceived: true,
      validationBlocked: true,
      validationRequiresReview: true,
    })).toEqual({
      status: "complete",
      text: "готовый черновик",
      postable: true,
      reviewable: true,
      requiresReview: false,
    });
  });
});
