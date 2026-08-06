import type { Pool } from "pg";

export type AiAttemptPhase = "draft" | "edit" | "auto-improve" | "topic-repair";

export class AiOperationBudgetError extends Error {
  readonly code = "ai_operation_budget_exhausted";
  constructor(public readonly dimension: "attempts" | "tokens" | "cost" | "deadline") {
    super("ai_operation_budget_exhausted");
    this.name = "AiOperationBudgetError";
  }
}

const positive = (value: string | undefined, fallback: number, max: number) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(max, Math.floor(parsed)) : fallback;
};

export function estimatedAiCostMicrousd(engine: string, inputTokens: number, outputTokens: number) {
  if (engine === "local") return 0;
  // Conservative generic estimate; exact billing stays separate when a provider exposes it.
  return Math.ceil((inputTokens * 1_000_000 + outputTokens * 4_000_000) / 1_000_000);
}

export function createAiOperationBudget(
  env: Record<string, string | undefined> = process.env,
  now = Date.now,
) {
  const limits = {
    attempts: positive(env.AI_OPERATION_MAX_ATTEMPTS, 4, 12),
    tokens: positive(env.AI_OPERATION_MAX_TOKENS, 30_000, 500_000),
    costMicrousd: positive(env.AI_OPERATION_MAX_COST_MICROUSD, 200_000, 10_000_000),
    deadlineMs: positive(env.AI_OPERATION_DEADLINE_MS, 180_000, 600_000),
  };
  const startedAt = now();
  let attempts = 0;
  let tokens = 0;
  let costMicrousd = 0;
  return {
    begin(projected: { inputTokens: number; outputTokens: number; engine: string }) {
      if (now() - startedAt >= limits.deadlineMs) throw new AiOperationBudgetError("deadline");
      if (attempts + 1 > limits.attempts) throw new AiOperationBudgetError("attempts");
      if (tokens + projected.inputTokens + projected.outputTokens > limits.tokens) {
        throw new AiOperationBudgetError("tokens");
      }
      const projectedCost = estimatedAiCostMicrousd(
        projected.engine,
        projected.inputTokens,
        projected.outputTokens,
      );
      if (costMicrousd + projectedCost > limits.costMicrousd) throw new AiOperationBudgetError("cost");
      attempts += 1;
      return attempts;
    },
    complete(actual: { inputTokens: number; outputTokens: number; engine: string }) {
      tokens += actual.inputTokens + actual.outputTokens;
      costMicrousd += estimatedAiCostMicrousd(actual.engine, actual.inputTokens, actual.outputTokens);
    },
    snapshot: () => ({ attempts, tokens, costMicrousd, limits }),
  };
}

export async function recordAiProviderAttempt(input: {
  pool: Pick<Pool, "query">;
  userId: number;
  aiUsageId: number | null;
  logicalOperationId: string;
  phase: AiAttemptPhase;
  attemptIndex: number;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  usageEstimated: boolean;
  latencyMs: number;
  outcome: "succeeded" | "failed" | "cancelled" | "budget_exhausted";
  fallback: boolean;
  safeErrorCode?: string | null;
}) {
  const estimatedCost = estimatedAiCostMicrousd(input.provider, input.inputTokens, input.outputTokens);
  await input.pool.query(
    `insert into ai_provider_attempts
       (user_id, ai_usage_id, logical_operation_id, phase, attempt_index, provider, model,
        input_tokens, output_tokens, usage_estimated, latency_ms, outcome, fallback,
        estimated_cost_microusd, safe_error_code, request_correlation_id)
     values ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$3::uuid)
     on conflict (logical_operation_id, attempt_index) do nothing`,
    [
      input.userId, input.aiUsageId, input.logicalOperationId, input.phase, input.attemptIndex,
      input.provider, input.model, input.inputTokens, input.outputTokens, input.usageEstimated,
      input.latencyMs, input.outcome, input.fallback, estimatedCost, input.safeErrorCode ?? null,
    ],
  );
  return { estimatedCostMicrousd: estimatedCost };
}

type AttemptUsage = {
  engine: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
};

type AttemptProjection = {
  model: string;
  inputTokens: number;
  outputTokens: number;
};

/**
 * Связывает локальный номер попытки orchestrator с глобальным номером внутри одной
 * user operation. Budget резервируется до provider call, а строка telemetry
 * завершается по terminal event конкретной попытки, а не по итогам всей фазы.
 */
export function createAiAttemptTelemetry(input: {
  pool: Pick<Pool, "query">;
  userId: number;
  aiUsageId: number | null;
  logicalOperationId: string;
  phase: AiAttemptPhase;
  budget: ReturnType<typeof createAiOperationBudget>;
  projectionFor: (engine: string) => AttemptProjection;
  now?: () => number;
  record?: typeof recordAiProviderAttempt;
}) {
  const now = input.now ?? Date.now;
  const record = input.record ?? recordAiProviderAttempt;
  const attempts = new Map<number, {
    globalIndex: number;
    engine: string;
    primary: boolean;
    startedAt: number;
    outputChars: number;
    usage: AttemptUsage | null;
    finalized: boolean;
  }>();
  let activeAttempt: number | null = null;

  const write = (values: Omit<Parameters<typeof recordAiProviderAttempt>[0],
    "pool" | "userId" | "aiUsageId" | "logicalOperationId" | "phase">) => record({
    pool: input.pool,
    userId: input.userId,
    aiUsageId: input.aiUsageId,
    logicalOperationId: input.logicalOperationId,
    phase: input.phase,
    ...values,
  });

  return {
    async beforeAttempt(event: { engine: string; attempt: number; primary: boolean }) {
      const projection = input.projectionFor(event.engine);
      let globalIndex: number;
      try {
        globalIndex = input.budget.begin({
          inputTokens: projection.inputTokens,
          outputTokens: projection.outputTokens,
          engine: event.engine,
        });
      } catch (error) {
        if (error instanceof AiOperationBudgetError) {
          await write({
            attemptIndex: input.budget.snapshot().attempts + 1,
            provider: event.engine,
            model: projection.model,
            inputTokens: 0,
            outputTokens: 0,
            usageEstimated: true,
            latencyMs: 0,
            outcome: "budget_exhausted",
            fallback: !event.primary,
            safeErrorCode: `${error.code}:${error.dimension}`,
          });
        }
        throw error;
      }
      attempts.set(event.attempt, {
        globalIndex,
        engine: event.engine,
        primary: event.primary,
        startedAt: now(),
        outputChars: 0,
        usage: null,
        finalized: false,
      });
      activeAttempt = event.attempt;
    },

    addDelta(engine: string, text: string) {
      const state = activeAttempt === null ? null : attempts.get(activeAttempt);
      if (state && state.engine === engine && !state.finalized) state.outputChars += text.length;
    },

    addUsage(usage: AttemptUsage) {
      const state = activeAttempt === null ? null : attempts.get(activeAttempt);
      if (state && state.engine === usage.engine && !state.finalized) state.usage = usage;
    },

    async finish(event: {
      engine: string;
      attempt: number;
      primary: boolean;
      outcome: "succeeded" | "failed" | "cancelled";
      safeErrorCode?: string | null;
    }) {
      const state = attempts.get(event.attempt);
      if (!state || state.finalized) return null;
      state.finalized = true;
      const projection = input.projectionFor(state.engine);
      const usage = state.usage ?? {
        engine: state.engine,
        model: projection.model,
        inputTokens: projection.inputTokens,
        outputTokens: Math.max(event.outcome === "succeeded" ? 1 : 0, Math.ceil(state.outputChars / 4)),
      };
      input.budget.complete({
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        engine: usage.engine,
      });
      const result = await write({
        attemptIndex: state.globalIndex,
        provider: usage.engine,
        model: usage.model,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        usageEstimated: state.usage === null,
        latencyMs: Math.max(0, Math.round(now() - state.startedAt)),
        outcome: event.outcome,
        fallback: !event.primary,
        safeErrorCode: event.safeErrorCode ?? null,
      });
      return { attemptIndex: state.globalIndex, ...result };
    },
  };
}
