/**
 * Licensed legal-source provider boundary.
 *
 * Provider endpoints are server-owned configuration. A browser can select a configured
 * provider and submit its API token, but it cannot supply an endpoint, a cookie, a
 * password, or instructions to scrape a subscriber cabinet. The adapter never logs or
 * returns credentials and sends one stable idempotency key for every mutating vendor call.
 */

const PROVIDER_KINDS = new Set([
  "official_api",
  "vendor_export",
  "user_file",
  "licensed_integration",
]);
const LEGAL_TYPES = new Set(["law", "case", "commentary", "document"]);
const CURRENTNESS = new Set(["current", "superseded", "unknown"]);
const SUBSCRIPTION_STATUSES = new Set(["active", "trial", "expired", "inactive", "unknown"]);
const OPERATIONS = Object.freeze(["connect", "validate", "sync", "health", "disconnect"]);
const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{1,62}$/;
const IDEMPOTENCY_HEADER = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

export class LegalProviderError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = "LegalProviderError";
    this.code = code;
    this.retryable = options.retryable === true;
    this.status = Number.isInteger(options.status) ? options.status : null;
  }
}

function cleanText(value, max = 300) {
  return String(value ?? "").trim().slice(0, max);
}

function isoDate(value, required = false) {
  if (value == null || value === "") {
    if (required) throw new LegalProviderError("invalid_provenance", "У фрагмента нет даты источника");
    return null;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new LegalProviderError("invalid_provenance", "Некорректная дата источника");
  }
  return date.toISOString();
}

function publicHttpsUrl(value, code = "invalid_provider_config") {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    throw new LegalProviderError(code, "Некорректный URL юридического источника");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !parsed.hostname) {
    throw new LegalProviderError(code, "Юридический источник должен использовать HTTPS без credentials в URL");
  }
  const host = parsed.hostname.toLowerCase();
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(host) ||
    /^172\.(?:1[6-9]|2\d|3[01])\./.test(host) ||
    host === "::1" ||
    host.startsWith("[")
  ) {
    throw new LegalProviderError(code, "Внутренний адрес юридического провайдера запрещён");
  }
  return parsed;
}

function endpointUrl(baseUrl, path) {
  const value = cleanText(path, 500);
  if (!value) return null;
  const parsed = new URL(value, baseUrl);
  if (parsed.origin !== baseUrl.origin || parsed.protocol !== "https:") {
    throw new LegalProviderError("invalid_provider_config", "Endpoint должен оставаться на разрешённом домене провайдера");
  }
  return parsed.toString();
}

export function normalizeLegalProviderConfig(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new LegalProviderError("invalid_provider_config", "Конфигурация провайдера отсутствует");
  }
  const id = cleanText(raw.id, 64).toLowerCase();
  const label = cleanText(raw.label, 120);
  const kind = cleanText(raw.kind, 40);
  if (!PROVIDER_ID.test(id) || !label || !PROVIDER_KINDS.has(kind)) {
    throw new LegalProviderError("invalid_provider_config", "Некорректная конфигурация провайдера");
  }
  if (raw.licenseConfirmed !== true) {
    throw new LegalProviderError("license_not_confirmed", "Лицензия интеграции не подтверждена");
  }
  const baseUrl = publicHttpsUrl(raw.baseUrl);
  const endpoints = {};
  for (const operation of OPERATIONS) {
    const url = endpointUrl(baseUrl, raw.endpoints?.[operation]);
    if (url) endpoints[operation] = url;
  }
  const idempotencyHeader = cleanText(raw.idempotencyHeader || "Idempotency-Key", 64);
  if (!IDEMPOTENCY_HEADER.test(idempotencyHeader)) {
    throw new LegalProviderError("invalid_provider_config", "Некорректный idempotency header");
  }
  for (const operation of OPERATIONS) {
    if (endpoints[operation] && !idempotencyHeader) {
      throw new LegalProviderError("idempotency_not_supported", "Провайдер не поддерживает идемпотентные изменения");
    }
  }
  return Object.freeze({
    id,
    label,
    kind,
    baseUrl: baseUrl.toString(),
    endpoints: Object.freeze(endpoints),
    idempotencyHeader,
    licenseNotice: cleanText(raw.licenseNotice, 500),
    subscriptionRequired: raw.subscriptionRequired !== false,
  });
}

export function loadLegalProviderRegistry(serialized = process.env.LEGAL_PROVIDER_CONFIG_JSON) {
  if (!serialized) return Object.freeze([]);
  let raw;
  try {
    raw = JSON.parse(serialized);
  } catch {
    throw new LegalProviderError("invalid_provider_config", "LEGAL_PROVIDER_CONFIG_JSON содержит некорректный JSON");
  }
  if (!Array.isArray(raw)) {
    throw new LegalProviderError("invalid_provider_config", "Реестр юридических провайдеров должен быть массивом");
  }
  const registry = raw.map(normalizeLegalProviderConfig);
  if (new Set(registry.map((provider) => provider.id)).size !== registry.length) {
    throw new LegalProviderError("invalid_provider_config", "ID юридических провайдеров должны быть уникальны");
  }
  return Object.freeze(registry);
}

export function publicLegalProvider(provider) {
  return {
    id: provider.id,
    label: provider.label,
    kind: provider.kind,
    licenseNotice: provider.licenseNotice || null,
    subscriptionRequired: provider.subscriptionRequired,
    capabilities: OPERATIONS.filter((operation) => Boolean(provider.endpoints[operation])),
  };
}

export function getLegalProvider(providerId, registry = loadLegalProviderRegistry()) {
  const id = cleanText(providerId, 64).toLowerCase();
  const provider = registry.find((candidate) => candidate.id === id);
  if (!provider) {
    throw new LegalProviderError("not_configured", "Официальная интеграция не настроена", { status: 503 });
  }
  return provider;
}

function subscriptionStatus(value) {
  const status = cleanText(value, 20).toLowerCase();
  return SUBSCRIPTION_STATUSES.has(status) ? status : "unknown";
}

function normalizeSourceLink(value) {
  return publicHttpsUrl(value, "invalid_provenance").toString();
}

export function normalizeLegalFragments(records) {
  if (!Array.isArray(records)) {
    throw new LegalProviderError("invalid_provider_response", "Провайдер не вернул массив юридических данных");
  }
  return records.map((record, recordIndex) => {
    if (!record || typeof record !== "object" || Array.isArray(record)) {
      throw new LegalProviderError("invalid_provider_response", "Некорректная запись юридического источника");
    }
    const legalType = cleanText(record.type, 30).toLowerCase();
    if (!LEGAL_TYPES.has(legalType)) {
      throw new LegalProviderError("invalid_legal_type", "Неизвестный тип юридических данных");
    }
    const externalId = cleanText(record.externalId, 300);
    const sourceName = cleanText(record.source, 300);
    const sourceDate = isoDate(record.date, true);
    const currentness = cleanText(record.currentness, 30).toLowerCase();
    const sourceUrl = normalizeSourceLink(record.url);
    if (!externalId || !sourceName || !CURRENTNESS.has(currentness)) {
      throw new LegalProviderError("invalid_provenance", "У юридического фрагмента неполные реквизиты источника");
    }
    const rawFragments = Array.isArray(record.fragments) && record.fragments.length
      ? record.fragments
      : [{ text: record.content }];
    const fragments = rawFragments.map((fragment, fragmentIndex) => {
      const text = cleanText(typeof fragment === "string" ? fragment : fragment?.text, 100_000);
      if (!text) {
        throw new LegalProviderError("invalid_provider_response", "Провайдер вернул пустой юридический фрагмент");
      }
      return {
        fragmentIndex,
        text,
        sourceName,
        sourceDate,
        currentness,
        sourceUrl,
      };
    });
    return {
      externalId,
      legalType,
      title: cleanText(record.title, 1_000) || `Юридический материал ${recordIndex + 1}`,
      sourceName,
      sourceDate,
      currentness,
      sourceUrl,
      relevantAt: isoDate(record.relevantAt, false),
      fragments,
    };
  });
}

async function parseProviderResponse(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) {
    throw new LegalProviderError("provider_response_too_large", "Ответ провайдера слишком большой");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > MAX_RESPONSE_BYTES) {
    throw new LegalProviderError("provider_response_too_large", "Ответ провайдера слишком большой");
  }
  const data = text ? JSON.parse(text) : {};
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new LegalProviderError("invalid_provider_response", "Провайдер вернул некорректный ответ");
  }
  return data;
}

function providerFailure(status) {
  if (status === 401 || status === 403) {
    return new LegalProviderError("provider_credentials_rejected", "Провайдер отклонил API-токен", { status });
  }
  if (status === 402) {
    return new LegalProviderError("subscription_inactive", "Подписка провайдера неактивна", { status });
  }
  if (status === 429) {
    return new LegalProviderError("provider_rate_limited", "Провайдер ограничил частоту запросов", { status, retryable: true });
  }
  return new LegalProviderError("provider_unavailable", "Провайдер временно недоступен", {
    status,
    retryable: status >= 500,
  });
}

export function createLegalProviderAdapter(provider, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function call(operation, input = {}) {
    const endpoint = provider.endpoints[operation];
    if (!endpoint) {
      throw new LegalProviderError("not_configured", `Операция ${operation} не настроена`, { status: 503 });
    }
    if (!input.idempotencyKey) {
      throw new LegalProviderError("idempotency_key_required", "Для запроса провайдера нужен idempotency key");
    }
    const headers = { accept: "application/json", "content-type": "application/json" };
    if (input.token) headers.authorization = `Bearer ${input.token}`;
    headers[provider.idempotencyHeader] = input.idempotencyKey;
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: operation === "validate" || operation === "health" ? "GET" : "POST",
        headers,
        body: operation === "validate" || operation === "health"
          ? undefined
          : JSON.stringify(operation === "sync" && input.cursor ? { cursor: input.cursor } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const code = error?.name === "TimeoutError" || error?.name === "AbortError"
        ? "provider_timeout"
        : "provider_unavailable";
      throw new LegalProviderError(code, "Провайдер не ответил вовремя", { retryable: true });
    }
    if (!response.ok) throw providerFailure(response.status);
    let data;
    try {
      data = await parseProviderResponse(response);
    } catch (error) {
      if (error instanceof LegalProviderError) throw error;
      throw new LegalProviderError("invalid_provider_response", "Провайдер вернул некорректный JSON");
    }
    return data;
  }

  return Object.freeze({
    async connect(input) {
      const data = await call("connect", input);
      return {
        accountLabel: cleanText(data.accountLabel, 300) || null,
        subscriptionStatus: subscriptionStatus(data.subscriptionStatus),
        tokenExpiresAt: isoDate(data.tokenExpiresAt, false),
      };
    },
    async validate(input) {
      const data = await call("validate", input);
      return {
        valid: data.valid === true,
        subscriptionStatus: subscriptionStatus(data.subscriptionStatus),
        tokenExpiresAt: isoDate(data.tokenExpiresAt, false),
      };
    },
    async sync(input) {
      const data = await call("sync", input);
      return {
        cursor: cleanText(data.cursor, 2_000) || null,
        fragments: normalizeLegalFragments(data.records),
      };
    },
    async health(input) {
      const data = await call("health", input);
      return {
        healthy: data.healthy === true,
        subscriptionStatus: subscriptionStatus(data.subscriptionStatus),
        tokenExpiresAt: isoDate(data.tokenExpiresAt, false),
        message: cleanText(data.message, 500) || null,
      };
    },
    async disconnect(input) {
      await call("disconnect", input);
      return { disconnected: true };
    },
  });
}

export const LEGAL_PROVIDER_KINDS = Object.freeze([...PROVIDER_KINDS]);
export const LEGAL_DATA_TYPES = Object.freeze([...LEGAL_TYPES]);
