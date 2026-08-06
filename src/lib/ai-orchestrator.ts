import { createHash } from "node:crypto";

import {
  AiProviderError,
  generateText,
  type GenerateParams,
} from "./ai-provider";
import { isEngineId, type EngineId } from "./engines";
import { configuredAiFallbacks } from "./ai-engine-policy.mjs";
import {
  aiProviderCircuitBreaker,
  type ProviderCircuitBreaker,
} from "./ai-provider-health";

export type AiAttemptOutcome = "started" | "first_token" | "succeeded" | "failed" | "skipped";

export type AiOrchestrationEvent =
  | {
      type: "telemetry";
      engine: EngineId;
      primary: boolean;
      attempt: number;
      outcome: AiAttemptOutcome;
      ttftMs?: number;
      totalMs?: number;
      code?: AiPublicFailureCode;
    }
  | {
      type: "fallback";
      fromEngine: EngineId;
      toEngine: EngineId;
      reason: AiPublicFailureCode;
      attempt: number;
    }
  | { type: "delta"; engine: EngineId; text: string };

export type AiPublicFailureCode =
  | "first_token_timeout"
  | "overall_timeout"
  | "rate_limited"
  | "empty_generation"
  | "stream_truncated"
  | "network_error"
  | "circuit_open"
  | "provider_unavailable"
  | "provider_error";

export type AiStreamFactory = (
  params: GenerateParams,
  engine: EngineId,
  signal?: AbortSignal,
) => AsyncGenerator<string>;

export interface AiOrchestratorOptions {
  signal?: AbortSignal;
  fallbackEngines?: EngineId[];
  /** Deadline только до первого непустого пользовательского token/chunk. */
  firstTokenMs?: number;
  /** Deadline всего логического provider attempt chain, включая fallback. */
  overallMs?: number;
  streamFactory?: AiStreamFactory;
  now?: () => number;
  /** null отключает breaker для изолированного caller/test. undefined = общий production breaker. */
  circuitBreaker?: ProviderCircuitBreaker | null;
  /**
   * Вызывается после circuit-breaker, но до открытия provider stream. Caller может
   * атомарно зарезервировать budget; исключение гарантирует, что запрос провайдеру
   * ещё не начался.
   */
  beforeAttempt?: (attempt: {
    engine: EngineId;
    attempt: number;
    primary: boolean;
  }) => void | Promise<void>;
}

const DEFAULT_FIRST_TOKEN_MS = 12_000;
const DEFAULT_OVERALL_MS = 60_000;

function safeMs(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.round(value));
}

function signals(...values: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = values.filter((value): value is AbortSignal => Boolean(value));
  if (!active.length) return undefined;
  return active.length === 1 ? active[0] : AbortSignal.any(active);
}

function abortReason(signal: AbortSignal | undefined, fallback: Error): Error {
  return signal?.reason instanceof Error ? signal.reason : fallback;
}

function timeoutError(engine: EngineId, code: "first_token_timeout" | "overall_timeout"): AiProviderError {
  return new AiProviderError(engine, 504, code);
}

function paramsForEngineAttempt(params: GenerateParams, engine: EngineId): GenerateParams {
  const rawKey = String(params.providerRequestKey ?? "").trim();
  if (!rawKey) return params;
  return {
    ...params,
    // One logical generation may reach several models. Keep retries of each model
    // idempotent without reusing one provider key for two different model payloads.
    providerRequestKey: createHash("sha256")
      .update("aurora-ai-provider-engine-v1\0")
      .update(rawKey)
      .update("\0")
      .update(engine)
      .digest("hex"),
  };
}

function normalizedError(
  raw: unknown,
  engine: EngineId,
  callerSignal: AbortSignal | undefined,
  overallSignal: AbortSignal,
  firstTokenSignal: AbortSignal,
): Error {
  // Отмена пользователя важнее внутренних timers: её нельзя превращать в fallback.
  if (callerSignal?.aborted) {
    return abortReason(callerSignal, new DOMException("The operation was aborted", "AbortError"));
  }
  if (overallSignal.aborted) return abortReason(overallSignal, timeoutError(engine, "overall_timeout"));
  if (firstTokenSignal.aborted) return abortReason(firstTokenSignal, timeoutError(engine, "first_token_timeout"));
  if (raw instanceof AiProviderError) return raw;
  if (raw instanceof Error && raw.name === "TimeoutError") {
    return new AiProviderError(engine, 504, "overall_timeout");
  }
  if (raw instanceof TypeError) return new AiProviderError(engine, 503, "network_error");
  if (raw instanceof Error && raw.name === "AbortError") {
    return new AiProviderError(engine, 503, "provider_unavailable");
  }
  return new AiProviderError(engine, 502, "provider_error");
}

export function publicAiFailureCode(error: unknown): AiPublicFailureCode {
  if (!(error instanceof AiProviderError)) {
    if (error instanceof Error && error.name === "TimeoutError") return "overall_timeout";
    return error instanceof TypeError ? "network_error" : "provider_error";
  }
  if (error.code === "first_token_timeout") return "first_token_timeout";
  if (error.code === "overall_timeout" || error.code === "provider_timeout") return "overall_timeout";
  if (error.status === 429 || error.code === "rate_limited" || error.code === "quota_exceeded") {
    return "rate_limited";
  }
  if (error.code === "empty_generation" || error.code === "reasoning_without_content") {
    return "empty_generation";
  }
  if (error.code === "stream_truncated") return "stream_truncated";
  if (error.code === "network_error") return "network_error";
  if (error.code === "circuit_open") return "circuit_open";
  if (error.status !== null && error.status >= 500) return "provider_unavailable";
  return "provider_error";
}

export function isTransientAiFailure(error: unknown): boolean {
  if (error instanceof AiProviderError) {
    if (error.status === 408 || error.status === 409 || error.status === 425 || error.status === 429) return true;
    if (error.status !== null && error.status >= 500) return true;
    return [
      "first_token_timeout",
      "overall_timeout",
      "provider_timeout",
      "network_error",
      "rate_limited",
      "quota_exceeded",
      "empty_generation",
      "reasoning_without_content",
      "stream_error",
      "stream_truncated",
      "circuit_open",
    ].includes(error.code);
  }
  return error instanceof TypeError || (error instanceof Error && error.name === "TimeoutError");
}

/**
 * Резервные движки — операторская policy, а не скрытая эвристика. Без явной env-policy
 * автоматически переключаемся только между моделями одного NavyAI endpoint/key.
 * Локальный primary никогда не отправляет пользовательский текст в облако.
 */
export function configuredFallbackEngines(
  primary: EngineId,
  env: Record<string, string | undefined> = process.env,
): EngineId[] {
  return configuredAiFallbacks(primary, env).filter(isEngineId);
}

/**
 * Стримит primary и делает fallback только при transient failure ДО первого delta.
 * После первого видимого текста ошибка остаётся ошибкой: склейка двух моделей могла бы
 * незаметно продублировать или исказить пост.
 */
export async function* orchestrateText(
  params: GenerateParams,
  primary: EngineId,
  options: AiOrchestratorOptions = {},
): AsyncGenerator<AiOrchestrationEvent> {
  const now = options.now ?? Date.now;
  const circuitBreaker = options.circuitBreaker === undefined ? aiProviderCircuitBreaker : options.circuitBreaker;
  const streamFactory = options.streamFactory
    ?? ((input, engine, signal) => generateText(input, engine, signal, { requestTimeoutMs: null }));
  const firstTokenMs = safeMs(options.firstTokenMs, DEFAULT_FIRST_TOKEN_MS);
  const overallMs = safeMs(options.overallMs, DEFAULT_OVERALL_MS);
  const candidates = [primary, ...new Set(options.fallbackEngines ?? [])].filter(
    (engine, index, all) => all.indexOf(engine) === index,
  );
  const chainStartedAt = now();
  let activeEngine = primary;
  const overallController = new AbortController();
  const overallTimer = overallMs > 0
    ? setTimeout(() => overallController.abort(timeoutError(activeEngine, "overall_timeout")), overallMs)
    : null;
  const chainSignal = signals(options.signal, overallController.signal);

  try {
    for (let index = 0; index < candidates.length; index++) {
      const engine = candidates[index];
      activeEngine = engine;
      if (options.signal?.aborted) {
        throw abortReason(options.signal, new DOMException("The operation was aborted", "AbortError"));
      }
      if (overallController.signal.aborted) {
        throw abortReason(overallController.signal, timeoutError(engine, "overall_timeout"));
      }

      const attempt = index + 1;
      const attemptStartedAt = now();
      const primaryAttempt = index === 0;
      const permit = circuitBreaker?.beforeRequest(engine, attemptStartedAt);
      if (permit && !permit.allowed) {
        const error = new AiProviderError(engine, 503, "circuit_open");
        yield {
          type: "telemetry",
          engine,
          primary: primaryAttempt,
          attempt,
          outcome: "skipped",
          totalMs: Math.max(0, now() - chainStartedAt),
          code: "circuit_open",
        };
        const next = candidates[index + 1];
        if (next && !options.signal?.aborted && !overallController.signal.aborted) {
          yield {
            type: "fallback",
            fromEngine: engine,
            toEngine: next,
            reason: "circuit_open",
            attempt: attempt + 1,
          };
          continue;
        }
        throw error;
      }
      await options.beforeAttempt?.({ engine, attempt, primary: primaryAttempt });
      yield { type: "telemetry", engine, primary: primaryAttempt, attempt, outcome: "started" };

      const firstTokenController = new AbortController();
      const attemptSignal = signals(chainSignal, firstTokenController.signal);
      const firstTimer = firstTokenMs > 0
        ? setTimeout(() => firstTokenController.abort(timeoutError(engine, "first_token_timeout")), firstTokenMs)
        : null;
      let stream: AsyncGenerator<string> | null = null;
      let emitted = false;
      let ttftMs: number | undefined;

      try {
        stream = streamFactory(paramsForEngineAttempt(params, engine), engine, attemptSignal);
        let first = await stream.next();
        while (!first.done && !first.value) first = await stream.next();
        if (firstTimer) clearTimeout(firstTimer);
        if (first.done) throw new AiProviderError(engine, 502, "empty_generation");

        emitted = true;
        ttftMs = Math.max(0, now() - attemptStartedAt);
        yield { type: "telemetry", engine, primary: primaryAttempt, attempt, outcome: "first_token", ttftMs };
        yield { type: "delta", engine, text: first.value };
        for await (const text of stream) {
          if (text) yield { type: "delta", engine, text };
        }
        circuitBreaker?.recordSuccess(engine, Math.max(0, now() - attemptStartedAt), now());
        yield {
          type: "telemetry",
          engine,
          primary: primaryAttempt,
          attempt,
          outcome: "succeeded",
          ttftMs,
          totalMs: Math.max(0, now() - chainStartedAt),
        };
        return;
      } catch (raw) {
        const error = normalizedError(
          raw,
          engine,
          options.signal,
          overallController.signal,
          firstTokenController.signal,
        );
        const code = publicAiFailureCode(error);
        if (options.signal?.aborted) {
          circuitBreaker?.recordCancellation(engine, now());
        } else {
          circuitBreaker?.recordFailure(engine, {
            code,
            transient: isTransientAiFailure(error),
            latencyMs: Math.max(0, now() - attemptStartedAt),
          }, now());
        }
        yield {
          type: "telemetry",
          engine,
          primary: primaryAttempt,
          attempt,
          outcome: "failed",
          ttftMs,
          totalMs: Math.max(0, now() - chainStartedAt),
          code,
        };

        const next = candidates[index + 1];
        if (!emitted && next && isTransientAiFailure(error) && !options.signal?.aborted && !overallController.signal.aborted) {
          yield { type: "fallback", fromEngine: engine, toEngine: next, reason: code, attempt: attempt + 1 };
          continue;
        }
        throw error;
      } finally {
        if (firstTimer) clearTimeout(firstTimer);
        // Закрываем reader и при отмене потребителем outer generator: иначе fetch body
        // может продолжить скачиваться после ухода пользователя со страницы.
        if (stream) await stream.return(undefined).catch(() => {});
      }
    }
  } finally {
    if (overallTimer) clearTimeout(overallTimer);
  }
}
