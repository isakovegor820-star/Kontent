import { MEDIA_MODELS, mediaModelAccess } from "./media-generation.mjs";

let cached = null;
let cachedUntil = 0;

const cleanBaseUrl = (value) => String(value || "https://api.navy/v1").replace(/\/+$/, "");
const RETRYABLE_PROVIDER_STATUSES = new Set([429, 500, 502, 503]);

export class NavyMediaError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "NavyMediaError";
    this.code = code;
    this.httpStatus = Number(options.httpStatus || 0) || null;
    this.retryable = options.retryable === true;
  }
}

export function isRetryableNavyMediaStatus(status) {
  return RETRYABLE_PROVIDER_STATUSES.has(Number(status));
}

function requestSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function providerHttpError(status) {
  if (status === 429) {
    return new NavyMediaError(
      "provider_rate_limited",
      "NavyAI временно ограничил генерации. Попробуй позже.",
      { httpStatus: status, retryable: true },
    );
  }
  if (status === 500 || status === 502 || status === 503) {
    return new NavyMediaError(
      "provider_unavailable",
      "NavyAI временно недоступен. Аврора повторит запрос автоматически.",
      { httpStatus: status, retryable: true },
    );
  }
  return new NavyMediaError(
    "provider_rejected",
    "NavyAI отклонил запрос. Проверь описание и попробуй ещё раз.",
    { httpStatus: status, retryable: false },
  );
}

async function navyJson(fetchImpl, url, options, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: requestSignal(options?.signal, timeoutMs),
    });
  } catch (error) {
    if (options?.signal?.aborted && options.signal.reason instanceof Error) {
      throw options.signal.reason;
    }
    const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
    throw new NavyMediaError(
      timedOut ? "provider_timeout" : "provider_network_error",
      timedOut
        ? "NavyAI не успел ответить. Запусти генерацию ещё раз."
        : "Не удалось связаться с NavyAI. Запусти генерацию ещё раз.",
      { retryable: false },
    );
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) throw providerHttpError(response.status);
  return data;
}

function outputUrl(data) {
  return data?.data?.[0]?.url
    || data?.result?.data?.[0]?.url
    || data?.output?.[0]?.url
    || null;
}

/** Injectable Navy client. It never logs a payload, prompt, URL, or API key. */
export function createNavyMediaClient({
  apiKey = "",
  baseUrl = "",
  fetchImpl = globalThis.fetch,
  createTimeoutMs = 180_000,
  pollTimeoutMs = 30_000,
} = {}) {
  const root = cleanBaseUrl(baseUrl);
  const headers = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  return {
    async create({ payload, requestKey, requestId, signal }) {
      if (!apiKey) {
        throw new NavyMediaError(
          "not_configured",
          "NavyAI не подключён на сервере.",
          { retryable: false },
        );
      }
      const data = await navyJson(fetchImpl, `${root}/images/generations`, {
        method: "POST",
        headers: {
          ...headers,
          "idempotency-key": String(requestKey || ""),
          "x-request-id": String(requestId || ""),
        },
        body: JSON.stringify(payload),
        signal,
      }, createTimeoutMs);
      const inlineUrl = outputUrl(data);
      if (inlineUrl) return { state: "completed", outputUrl: inlineUrl, providerJobId: null };
      const providerJobId = String(data?.id || data?.job_id || "").trim();
      if (!providerJobId) {
        throw new NavyMediaError(
          "bad_provider_response",
          "NavyAI не вернул идентификатор генерации.",
          { retryable: false },
        );
      }
      return { state: "pending", outputUrl: null, providerJobId };
    },

    async poll({ providerJobId, requestId, signal }) {
      if (!apiKey) {
        throw new NavyMediaError(
          "not_configured",
          "NavyAI не подключён на сервере.",
          { retryable: false },
        );
      }
      const data = await navyJson(
        fetchImpl,
        `${root}/images/generations/${encodeURIComponent(providerJobId)}`,
        {
          method: "GET",
          headers: { ...headers, "x-request-id": String(requestId || "") },
          signal,
        },
        pollTimeoutMs,
      );
      const status = String(data?.status || "").trim().toLowerCase();
      if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        throw new NavyMediaError(
          "provider_failed",
          "Модель не смогла создать файл. Измени описание и попробуй ещё раз.",
          { retryable: false },
        );
      }
      if (["completed", "succeeded", "success"].includes(status)) {
        const completedUrl = outputUrl(data);
        if (!completedUrl) {
          throw new NavyMediaError(
            "empty_result",
            "Генерация завершилась без файла. Запусти её ещё раз.",
            { retryable: false },
          );
        }
        return { state: "completed", outputUrl: completedUrl };
      }
      return { state: "pending", outputUrl: null };
    },
  };
}

/**
 * Коротко кэшируем каталог и тариф: NavyAI сам рекомендует не опрашивать /usage на
 * каждый рендер, а доступ к модели меняется намного реже, чем пользователь нажимает кнопку.
 */
export async function navyMediaCapabilities({ apiKey = "", baseUrl = "", force = false } = {}) {
  if (!apiKey) return { configured: false, checked: true, plan: null, models: [] };
  if (!force && cached && Date.now() < cachedUntil) return cached;

  const root = cleanBaseUrl(baseUrl);
  try {
    const [modelsResponse, usageResponse] = await Promise.all([
      fetch(`${root}/models`, { signal: AbortSignal.timeout(8_000) }),
      fetch(`${root}/usage`, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(8_000),
      }),
    ]);
    if (!modelsResponse.ok || !usageResponse.ok) throw new Error("navy_capabilities_unavailable");
    const [catalogPayload, usagePayload] = await Promise.all([
      modelsResponse.json(),
      usageResponse.json(),
    ]);
    const catalog = Array.isArray(catalogPayload?.data) ? catalogPayload.data : [];
    const byId = new Map(catalog.map((model) => [model?.id, model]));
    const plan = String(usagePayload?.plan || "free");
    const models = Object.entries(MEDIA_MODELS).flatMap(([kind, entries]) =>
      Object.values(entries).map((preset) => {
        const live = byId.get(preset.id) || null;
        const access = live
          ? mediaModelAccess(kind, preset.id, plan, live)
          : { available: false, reason: "provider_unavailable", requiredPlan: preset.requiredPlan || null };
        return {
          kind,
          id: preset.id,
          label: preset.label,
          available: access.available,
          reason: access.reason,
          requiredPlan: access.requiredPlan,
        };
      }),
    );
    cached = { configured: true, checked: true, plan, models };
    cachedUntil = Date.now() + 60_000;
    return cached;
  } catch {
    // Недоступность служебных endpoint'ов не должна выключать уже рабочую генерацию.
    // POST пропустит запрос дальше, а NavyAI вернёт точную ошибку модели при создании job.
    return {
      configured: true,
      checked: false,
      plan: null,
      models: Object.entries(MEDIA_MODELS).flatMap(([kind, entries]) =>
        Object.values(entries).map((preset) => ({
          kind,
          id: preset.id,
          label: preset.label,
          available: true,
          reason: null,
          requiredPlan: preset.requiredPlan || null,
        })),
      ),
    };
  }
}

export function clearNavyMediaCapabilitiesCache() {
  cached = null;
  cachedUntil = 0;
}
