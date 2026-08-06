import { describe, expect, it, vi } from "vitest";

import {
  AiOperationBudgetError,
  createAiAttemptTelemetry,
  createAiOperationBudget,
  recordAiProviderAttempt,
} from "./ai-attempt-budget";

describe("AI operation attempt budget", () => {
  it("aggregates draft/edit/repair and blocks the next paid call", () => {
    const budget = createAiOperationBudget({
      AI_OPERATION_MAX_ATTEMPTS: "3",
      AI_OPERATION_MAX_TOKENS: "1000",
      AI_OPERATION_MAX_COST_MICROUSD: "100000",
    });
    for (let index = 1; index <= 3; index += 1) {
      expect(budget.begin({ inputTokens: 100, outputTokens: 100, engine: "openai" })).toBe(index);
      budget.complete({ inputTokens: 100, outputTokens: 50, engine: "openai" });
    }
    expect(() => budget.begin({ inputTokens: 1, outputTokens: 1, engine: "openai" }))
      .toThrowError(expect.objectContaining({ dimension: "attempts" } satisfies Partial<AiOperationBudgetError>));
  });

  it("records only safe aggregate metadata and replays idempotently", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    await recordAiProviderAttempt({
      pool: { query } as never,
      userId: 7,
      aiUsageId: 9,
      logicalOperationId: "11111111-1111-4111-8111-111111111111",
      phase: "draft",
      attemptIndex: 1,
      provider: "openai",
      model: "model",
      inputTokens: 100,
      outputTokens: 50,
      usageEstimated: true,
      latencyMs: 20,
      outcome: "succeeded",
      fallback: false,
    });
    expect(query.mock.calls[0][0]).toContain("on conflict (logical_operation_id, attempt_index) do nothing");
    expect(JSON.stringify(query.mock.calls[0])).not.toContain("prompt");
  });

  it("records primary failure and fallback success as two provider attempts", async () => {
    let clock = 100;
    const record = vi.fn(async (value: Parameters<typeof recordAiProviderAttempt>[0]) => {
      void value;
      return { estimatedCostMicrousd: 1 };
    });
    const telemetry = createAiAttemptTelemetry({
      pool: { query: vi.fn() } as never,
      userId: 7,
      aiUsageId: 9,
      logicalOperationId: "11111111-1111-4111-8111-111111111111",
      phase: "draft",
      budget: createAiOperationBudget({ AI_OPERATION_MAX_ATTEMPTS: "3" }, () => clock),
      projectionFor: (engine) => ({ model: `${engine}-model`, inputTokens: 100, outputTokens: 50 }),
      now: () => clock,
      record,
    });

    await telemetry.beforeAttempt({ engine: "primary", attempt: 1, primary: true });
    clock += 20;
    await telemetry.finish({
      engine: "primary",
      attempt: 1,
      primary: true,
      outcome: "failed",
      safeErrorCode: "overall_timeout",
    });
    await telemetry.beforeAttempt({ engine: "fallback", attempt: 2, primary: false });
    telemetry.addDelta("fallback", "готово");
    telemetry.addUsage({
      engine: "fallback",
      model: "fallback-exact-model",
      inputTokens: 90,
      outputTokens: 12,
    });
    clock += 30;
    await telemetry.finish({ engine: "fallback", attempt: 2, primary: false, outcome: "succeeded" });

    expect(record).toHaveBeenCalledTimes(2);
    expect(record.mock.calls[0][0]).toMatchObject({
      attemptIndex: 1,
      provider: "primary",
      outcome: "failed",
      fallback: false,
      safeErrorCode: "overall_timeout",
      usageEstimated: true,
    });
    expect(record.mock.calls[1][0]).toMatchObject({
      attemptIndex: 2,
      provider: "fallback",
      model: "fallback-exact-model",
      outcome: "succeeded",
      fallback: true,
      usageEstimated: false,
      inputTokens: 90,
      outputTokens: 12,
    });
  });

  it("rejects an exhausted attempt before provider work and records a zero-cost denial", async () => {
    const record = vi.fn(async (value: Parameters<typeof recordAiProviderAttempt>[0]) => {
      void value;
      return { estimatedCostMicrousd: 0 };
    });
    const telemetry = createAiAttemptTelemetry({
      pool: { query: vi.fn() } as never,
      userId: 7,
      aiUsageId: 9,
      logicalOperationId: "11111111-1111-4111-8111-111111111111",
      phase: "draft",
      budget: createAiOperationBudget({ AI_OPERATION_MAX_ATTEMPTS: "1" }),
      projectionFor: () => ({ model: "model", inputTokens: 10, outputTokens: 10 }),
      record,
    });
    await telemetry.beforeAttempt({ engine: "primary", attempt: 1, primary: true });
    await telemetry.finish({ engine: "primary", attempt: 1, primary: true, outcome: "succeeded" });

    await expect(telemetry.beforeAttempt({ engine: "fallback", attempt: 2, primary: false }))
      .rejects.toMatchObject({ code: "ai_operation_budget_exhausted", dimension: "attempts" });
    expect(record.mock.calls[1][0]).toMatchObject({
      attemptIndex: 2,
      provider: "fallback",
      outcome: "budget_exhausted",
      inputTokens: 0,
      outputTokens: 0,
      fallback: true,
    });
  });
});
