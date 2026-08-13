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

const transient = (error) => error instanceof AiCompletionError && (
  error.status === 408 || error.status === 425 || error.status === 429 ||
  (Number(error.status) >= 500) ||
  ["provider_timeout", "network_error", "stream_truncated", "empty_generation", "reasoning_without_content"].includes(error.code)
);

const canRetryNavyModelRejection = (error, fromEngine, toEngine) => (
  error instanceof AiCompletionError
  && String(fromEngine).startsWith("navy-")
  && String(toEngine || "").startsWith("navy-")
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

async function serializedLocalCompletion(runtime, task) {
  const key = `${runtime.baseUrl}/${runtime.model}`;
  const previous = localCompletionTails.get(key) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.catch(() => {}).then(() => gate);
  localCompletionTails.set(key, tail);
  await previous.catch(() => {});
  try {
    return await task();
  } finally {
    release();
    if (localCompletionTails.get(key) === tail) localCompletionTails.delete(key);
  }
}

function combinedSignal(caller, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return caller ? AbortSignal.any([caller, timeout]) : timeout;
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
  const candidates = options.allowFallback === false
    ? [primary]
    : [primary, ...configuredAiFallbacks(primary, env)];
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = bounded(options.timeoutMs, 60_000, 100, 300_000);
  const localTimeoutMs = bounded(options.localTimeoutMs, timeoutMs, 100, 300_000);
  const telemetry = typeof options.telemetry === "function" ? options.telemetry : () => {};
  let lastError;
  for (let index = 0; index < candidates.length; index++) {
    const engine = candidates[index];
    const runtime = resolveAiEngineRuntime(engine, env);
    const startedAt = Date.now();
    telemetry({ type: "attempt", engine, attempt: index + 1, outcome: "started" });
    try {
      const run = () => oneCompletion(request, runtime, {
        fetchImpl,
        signal: options.signal,
        timeoutMs: runtime.protocol === "ollama" ? localTimeoutMs : timeoutMs,
      });
      const text = runtime.protocol === "ollama"
        ? await serializedLocalCompletion(runtime, run)
        : await run();
      telemetry({
        type: "attempt",
        engine,
        attempt: index + 1,
        outcome: "succeeded",
        totalMs: Date.now() - startedAt,
      });
      return { text, engine, fallbackUsed: index > 0, attempts: index + 1 };
    } catch (error) {
      lastError = error;
      telemetry({
        type: "attempt",
        engine,
        attempt: index + 1,
        outcome: "failed",
        code: error?.code || "provider_error",
        totalMs: Date.now() - startedAt,
      });
      const nextEngine = candidates[index + 1];
      if (
        options.signal?.aborted
        || index === candidates.length - 1
        || (!transient(error) && !canRetryNavyModelRejection(error, engine, nextEngine))
      ) throw error;
      telemetry({ type: "fallback", fromEngine: engine, toEngine: candidates[index + 1], attempt: index + 2 });
    }
  }
  throw lastError || new AiCompletionError(primary, "provider_unavailable", 503);
}
