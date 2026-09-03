import {
  configuredAiFallbacks,
  configuredServiceEngine,
  resolveAiEngineRuntime,
} from "./ai-engine-policy.mjs";
import { stripAiReasoning } from "./ai-visible-content.mjs";

export class AiCompletionError extends Error {
  constructor(engine, code, status = null) {
    super(`${engine}: ${code}`);
    this.name = "AiCompletionError";
    this.engine = engine;
    this.code = code;
    this.status = status;
  }
}

export const isRetryableAiCompletionError = (error) => error instanceof AiCompletionError && (
  error.status === 408 || error.status === 425 || error.status === 429 ||
  (Number(error.status) >= 500) ||
  ["provider_timeout", "overall_timeout", "network_error", "stream_truncated", "empty_generation", "reasoning_without_content"].includes(error.code)
);

/**
 * Whether a failure is evidence about the engine itself, and may therefore count towards
 * opening its circuit.
 *
 * `overall_timeout` is not. It means the caller spent the budget it granted the whole
 * fallback chain, which says nothing about the route that happened to be in flight when the
 * deadline landed. Autopilot builds several posts concurrently against one process-global
 * circuit map, so a single slow build charged one `overall_timeout` per concurrent post to
 * the same healthy engine, reached the threshold immediately and opened its circuit. Every
 * later post then skipped that engine as `circuit_open`, the fleet ran out of candidates and
 * the plan failed `ai_unavailable` — with nothing actually wrong upstream.
 *
 * `provider_timeout` stays a health signal: that is one attempt's own timeout elapsing while
 * this engine failed to answer.
 */
const isEngineHealthSignal = (error) => (
  isRetryableAiCompletionError(error) && error.code !== "overall_timeout"
);

const canRetryNavyModelRejection = (error, fromEngine) => (
  error instanceof AiCompletionError
  && String(fromEngine).startsWith("navy-")
  && [400, 404, 422].includes(Number(error.status))
);

const bounded = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

// A single local Ollama model cannot reliably generate several long completions at once.
// Keep one FIFO per model for the whole process so background reconnaissance cannot starve
// an Autopilot build (and vice versa). Cloud engines stay fully concurrent.
const localCompletionTails = new Map();
const completionCircuits = new Map();

function circuitState(engine, now) {
  const state = completionCircuits.get(engine);
  if (!state) return null;
  if (state.openUntil > now) return state;
  // Keep sub-threshold failures during the same recovery window so a threshold greater
  // than one can actually be reached across calls. Once an opened/quiet window expires,
  // start from a clean slate.
  if (state.resetAt > now && state.openUntil === 0) return null;
  completionCircuits.delete(engine);
  return null;
}

function recordCircuitSuccess(engine) {
  completionCircuits.delete(engine);
}

/**
 * Circuit state is process-global on purpose so one broken route stops being retried across
 * concurrent calls. Tests share that process, so without an explicit reset a failure staged
 * by one case silently decides which engine a later case reaches.
 */
export function resetAiCompletionCircuits() {
  completionCircuits.clear();
}

function recordCircuitFailure(engine, error, now, threshold, openMs) {
  if (!isEngineHealthSignal(error)) return;
  const previous = completionCircuits.get(engine);
  const failures = (previous?.resetAt > now ? previous.failures : 0) + 1;
  completionCircuits.set(engine, {
    failures,
    openUntil: failures >= threshold ? now + openMs : 0,
    resetAt: now + openMs,
  });
}

async function waitForLocalCompletionTurn(previous, signal) {
  if (!signal) {
    await previous.catch(() => {});
    return;
  }
  if (signal.aborted) throw signal.reason;
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    await Promise.race([previous.catch(() => {}), aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function serializedLocalCompletion(runtime, task, signal) {
  const key = `${runtime.baseUrl}/${runtime.model}`;
  const previous = localCompletionTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  localCompletionTails.set(key, tail);
  try {
    await waitForLocalCompletionTurn(previous, signal);
    return await task();
  } finally {
    release();
    if (localCompletionTails.get(key) === tail) localCompletionTails.delete(key);
  }
}

// A per-attempt deadline. `AbortSignal.any([caller, AbortSignal.timeout(ms)])` is not
// used on purpose: on Node 22 the composite holds the timeout signal weakly, so it can be
// garbage-collected before firing and the attempt only dies at the overall deadline.
// An explicit controller with a strongly held timer aborts exactly once, with the same
// TimeoutError reason the classifier below expects.
function combinedSignal(caller, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  const onCallerAbort = () => controller.abort(caller.reason);
  if (caller) {
    if (caller.aborted) onCallerAbort();
    else caller.addEventListener("abort", onCallerAbort, { once: true });
  }
  controller.signal.addEventListener("abort", () => {
    clearTimeout(timer);
    caller?.removeEventListener("abort", onCallerAbort);
  }, { once: true });
  return controller.signal;
}

async function providerError(runtime, response) {
  return new AiCompletionError(
    runtime.id,
    response.status === 429 ? "rate_limited" : "provider_error",
    response.status,
  );
}

async function oneCompletion(request, runtime, { fetchImpl, signal, timeoutMs }) {
  if (!runtime.supported || !runtime.protocol) {
    throw new AiCompletionError(runtime.id, "engine_unsupported", 503);
  }
  if (!runtime.configured) throw new AiCompletionError(runtime.id, "engine_not_connected", 503);
  const messages = Array.isArray(request.messages) && request.messages.length
    ? request.messages
    : [
        { role: "system", content: String(request.system || "") },
        { role: "user", content: String(request.user || "") },
      ];
  const temperature = Number.isFinite(Number(request.temperature)) ? Number(request.temperature) : 0.4;
  const maxTokens = bounded(request.maxTokens, 700, 1, 12_000);
  const requestSignal = combinedSignal(signal, timeoutMs);
  const providerRequestKey = String(request.providerRequestKey || "").trim().slice(0, 256);
  const providerRequestId = String(request.providerRequestId || "").trim().slice(0, 128);
  const correlationHeaders = {
    ...(providerRequestKey ? { "idempotency-key": providerRequestKey } : {}),
    ...(providerRequestId ? { "x-request-id": providerRequestId } : {}),
  };
  let response;
  try {
    if (runtime.protocol === "anthropic") {
      response = await fetchImpl(`${runtime.baseUrl}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": runtime.key,
          "anthropic-version": "2023-06-01",
          ...correlationHeaders,
        },
        signal: requestSignal,
        body: JSON.stringify({
          model: runtime.model,
          max_tokens: maxTokens,
          temperature,
          system: messages.find((message) => message.role === "system")?.content || "",
          messages: messages.filter((message) => message.role !== "system"),
        }),
      });
    } else if (runtime.protocol === "openai") {
      // Every Navy model on this endpoint can spend output tokens on hidden reasoning before
      // it emits anything visible, and only DeepSeek accepts `reasoning_effort: "none"`.
      // MiniMax and Qwen therefore used to burn a 1_200-token budget on reasoning and return
      // an empty `content`, which this service reports as `empty_generation`. Autopilot saw
      // that on every draft until each engine's circuit opened and the whole fleet answered
      // `provider_unavailable`. One budget for the whole endpoint keeps room for both phases.
      const providerMaxTokens = runtime.id.startsWith("navy-")
        ? Math.max(3_000, maxTokens)
        : maxTokens;
      response = await fetchImpl(`${runtime.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${runtime.key}`, ...correlationHeaders },
        signal: requestSignal,
        body: JSON.stringify({
          model: runtime.model,
          temperature,
          max_tokens: providerMaxTokens,
          // Reasoning-capable Navy models can spend a small output budget before producing
          // visible content. The larger provider cap above gives them room for both phases;
          // DeepSeek also supports disabling hidden reasoning for this background path.
          ...(runtime.id.startsWith("navy-deepseek") ? { reasoning_effort: "none" } : {}),
          messages,
        }),
      });
    } else {
      response = await fetchImpl(`${runtime.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json", ...correlationHeaders },
        signal: requestSignal,
        body: JSON.stringify({
          model: runtime.model,
          stream: false,
          options: { temperature, num_predict: maxTokens },
          messages,
        }),
      });
    }
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (error?.name === "TimeoutError" || error?.name === "AbortError") {
      throw new AiCompletionError(runtime.id, "provider_timeout", 504);
    }
    throw new AiCompletionError(runtime.id, "network_error", 503);
  }
  if (!response.ok) throw await providerError(runtime, response);
  let body;
  try {
    body = await response.json();
  } catch {
    throw new AiCompletionError(runtime.id, "stream_truncated", 502);
  }

  let text = "";
  let terminal = false;
  let stoppedAtTokenLimit = false;
  if (runtime.protocol === "anthropic") {
    text = (body.content ?? []).filter((part) => part?.type === "text").map((part) => part.text || "").join("").trim();
    terminal = body.stop_reason === "end_turn" || body.stop_reason === "stop_sequence";
    stoppedAtTokenLimit = body.stop_reason === "max_tokens";
  } else if (runtime.protocol === "openai") {
    text = String(body.choices?.[0]?.message?.content || "").trim();
    terminal = body.choices?.[0]?.finish_reason === "stop";
    stoppedAtTokenLimit = body.choices?.[0]?.finish_reason === "length";
  } else {
    text = String(body.message?.content || "").trim();
    terminal = body.done === true && (!body.done_reason || body.done_reason === "stop");
    stoppedAtTokenLimit = body.done === true && body.done_reason === "length";
  }
  const visible = stripAiReasoning(text);
  text = visible.text.trim();
  if (!text) {
    throw new AiCompletionError(
      runtime.id,
      visible.reasoningDetected ? "reasoning_without_content" : "empty_generation",
      502,
    );
  }
  // Content-generation callers may preserve a non-empty answer that reached the explicit
  // provider token limit. Their own quality boundary decides whether it is publishable.
  // Unknown/disconnected EOF remains an error, and structured extraction keeps the strict
  // default so an incomplete JSON object can still fall back to another engine.
  if (!terminal && !(request.acceptLengthLimitedOutput === true && stoppedAtTokenLimit)) {
    throw new AiCompletionError(runtime.id, "stream_truncated", 502);
  }
  return text;
}

/** Shared direct/background AI contract used by brief, profile and worker surfaces. */
export async function completeAiText(request, options = {}) {
  const env = options.env || process.env;
  const primary = configuredServiceEngine(request.engine, env);
  const fallbackCandidates = Array.isArray(options.fallbackEngines)
    ? options.fallbackEngines
        .filter((engine) => typeof engine === "string" && engine !== primary)
        .filter((engine) => {
          const runtime = resolveAiEngineRuntime(engine, env);
          return runtime.supported && runtime.configured;
        })
    : configuredAiFallbacks(primary, env);
  const configuredCandidates = options.allowFallback === false
    ? [primary]
    : [primary, ...new Set(fallbackCandidates)];
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = bounded(options.timeoutMs, 60_000, 100, 300_000);
  const localTimeoutMs = bounded(options.localTimeoutMs, timeoutMs, 100, 300_000);
  const maxAttempts = bounded(
    options.maxAttempts ?? env.AI_MAX_FALLBACK_ATTEMPTS,
    3,
    1,
    10,
  );
  // Open circuits do not issue provider requests, so they must not consume the actual
  // attempt budget or hide a healthy candidate later in the configured fallback list.
  const candidates = configuredCandidates;
  const overallTimeoutMs = bounded(
    options.overallTimeoutMs,
    Math.min(300_000, Math.max(timeoutMs, timeoutMs * maxAttempts)),
    100,
    300_000,
  );
  const circuitFailureThreshold = bounded(
    options.circuitFailureThreshold ?? env.AI_CIRCUIT_FAILURE_THRESHOLD,
    2,
    1,
    20,
  );
  const circuitOpenMs = bounded(
    options.circuitOpenMs ?? env.AI_CIRCUIT_OPEN_MS,
    30_000,
    100,
    10 * 60_000,
  );
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  const now = typeof options.now === "function" ? options.now : Date.now;
  const started = now();
  const deadlineSignal = AbortSignal.timeout(overallTimeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, deadlineSignal])
    : deadlineSignal;
  let lastError;
  let attempts = 0;
  let restrictFallbackToNavy = false;
  for (let index = 0; index < candidates.length; index++) {
    if (attempts >= maxAttempts) break;
    const engine = candidates[index];
    if (restrictFallbackToNavy && !engine.startsWith("navy-")) {
      telemetry({
        type: "attempt",
        engine,
        attempt: attempts + 1,
        outcome: "skipped",
        code: "provider_boundary",
      });
      continue;
    }
    const openCircuit = circuitState(engine, now());
    if (openCircuit) {
      telemetry({
        type: "attempt",
        engine,
        attempt: attempts + 1,
        outcome: "skipped",
        code: "circuit_open",
        retryAfterMs: Math.max(0, openCircuit.openUntil - now()),
      });
      continue;
    }
    const runtime = resolveAiEngineRuntime(engine, env);
    const startedAt = now();
    attempts += 1;
    telemetry({ type: "attempt", engine, attempt: attempts, outcome: "started" });
    try {
      const remainingMs = Math.max(100, overallTimeoutMs - (now() - started));
      const run = () => oneCompletion(request, runtime, {
        fetchImpl,
        signal,
        timeoutMs: Math.min(
          runtime.protocol === "ollama" ? localTimeoutMs : timeoutMs,
          remainingMs,
        ),
      });
      const text = runtime.protocol === "ollama"
        ? await serializedLocalCompletion(runtime, run, signal)
        : await run();
      recordCircuitSuccess(engine);
      telemetry({
        type: "attempt",
        engine,
        attempt: attempts,
        outcome: "succeeded",
        totalMs: now() - startedAt,
      });
      return { text, engine, fallbackUsed: engine !== primary, attempts };
    } catch (error) {
      const normalizedError = deadlineSignal.aborted && !options.signal?.aborted
        ? new AiCompletionError(engine, "overall_timeout", 504)
        : error;
      lastError = normalizedError;
      recordCircuitFailure(
        engine,
        normalizedError,
        now(),
        circuitFailureThreshold,
        circuitOpenMs,
      );
      telemetry({
        type: "attempt",
        engine,
        attempt: attempts,
        outcome: "failed",
        code: normalizedError?.code || "provider_error",
        totalMs: now() - startedAt,
      });
      if (options.signal?.aborted || deadlineSignal.aborted || attempts >= maxAttempts) {
        throw normalizedError;
      }
      if (!isRetryableAiCompletionError(normalizedError)) {
        if (!canRetryNavyModelRejection(normalizedError, engine)) throw normalizedError;
        restrictFallbackToNavy = true;
        const nextNavyIndex = candidates.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate.startsWith("navy-"),
        );
        if (nextNavyIndex < 0) throw normalizedError;
        telemetry({
          type: "fallback",
          fromEngine: engine,
          toEngine: candidates[nextNavyIndex],
          attempt: attempts + 1,
        });
        // A provider-specific model rejection must stay inside Navy. Explicit fallbacks from
        // another vendor can appear before the automatic same-provider fleet, so jump over
        // them without leaking the prompt or spending an attempt.
        index = nextNavyIndex - 1;
        continue;
      }
      const nextEngine = candidates[index + 1];
      if (!nextEngine) throw normalizedError;
      telemetry({ type: "fallback", fromEngine: engine, toEngine: nextEngine, attempt: attempts + 1 });
    }
  }
  throw lastError || new AiCompletionError(primary, "provider_unavailable", 503);
}
