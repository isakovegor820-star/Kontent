// Подключаемый поисковый провайдер для исследования интернета.
//
// Зачем отдельный модуль. До него единственным источником выдачи были бесплатные
// web-адаптеры Радара — скрапинг Yahoo, Brave, Bing RSS и DuckDuckGo. Замер 05.10.2026:
// Yahoo отвечал 500, Brave — 429, DuckDuckGo срывался на чтении, устойчиво работал
// только Bing RSS и отдавал мусор («Sechs – Wikipedia» по запросу про модель ИИ).
// Качество ответа упиралось в это, а не в чтение страниц.
//
// Модуль даёт одну точку подключения: сервис, который отвечает JSON по HTTP, с ключом
// из переменных окружения. Форма ответа описывается одним из двух стилей, потому что
// у разных сервисов она разная:
//
//   AURORA_SEARCH_API_STYLE=query  → ?q=...&count=...   (Brave, Serper-совместимые)
//   AURORA_SEARCH_API_STYLE=json   → {"query": "...", "count": n}  (Bocha, Zhipu, Tavily-совместимые)
//
// Модуль чистый: сеть приходит через `fetchImpl`, поэтому поведение, приоритет и
// разбор ответа проверяются тестом без сети.
//
// Бесплатные адаптеры не выбрасываются: они остаются резервом, если платный сервис
// недоступен или ключ не задан. Приоритет задаётся явно и читается из одного места.

const DEFAULT_TIMEOUT_MS = 12_000;
const DEFAULT_MAX_RESULTS = 10;

/** Стили запроса, которые понимает адаптер. */
export const WEB_SEARCH_API_STYLES = Object.freeze(["query", "json"]);

/**
 * Достаёт список результатов из ответа сервиса.
 *
 * Порядок ключей — от самого частого к самому редкому. Проверять по одному дешевле,
 * чем требовать строгую форму: сервисы меняют её без предупреждения, и падать из-за
 * переименованного поля нельзя.
 */
export function firstResultArray(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  for (const key of ["results", "data", "items", "search_result", "webPages", "web_pages", "organic", "value", "list"]) {
    const value = payload[key];
    if (Array.isArray(value)) return value;
    // Zhipu и часть китайских сервисов кладут результаты в `search_result`.
    if (value && typeof value === "object" && Array.isArray(value.value)) return value.value;
  }
  if (payload.webPages && typeof payload.webPages === "object" && Array.isArray(payload.webPages.value)) {
    return payload.webPages.value;
  }
  return [];
}

function pickString(item, keys) {
  for (const key of keys) {
    const value = item?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/**
 * Нормализует один результат к форме, которую ждёт конвейер исследования:
 * `{ url, title, snippet, publishedAt }`.
 *
 * Дата берётся из `publishedAt`, иначе из `date`/`published_date`/`page_age`: часть
 * сервисов отдаёт её как «3 days ago» или как ISO. Непонятное значение остаётся null —
 * ворота достоверности лучше переживут отсутствие даты, чем выдуманную свежесть.
 */
export function normalizeProviderResult(item) {
  if (!item || typeof item !== "object") return null;
  const url = pickString(item, ["url", "link", "href", "sourceUrl", "source_url"]);
  if (!url) return null;
  const title = pickString(item, ["title", "name", "headline"]);
  const snippet = pickString(item, ["snippet", "content", "description", "summary", "text", "abstract"]);
  const rawDate = pickString(item, ["publishedAt", "published_at", "date", "published", "publishedDate", "page_age", "time"]);
  let publishedAt = null;
  if (rawDate) {
    const parsed = Date.parse(rawDate);
    publishedAt = Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  return { url, title, snippet, publishedAt };
}

/** Приводит любую форму ответа к массиву нормализованных результатов. */
export function parseProviderPayload(payload) {
  const results = [];
  const seen = new Set();
  for (const item of firstResultArray(payload)) {
    const normalized = normalizeProviderResult(item);
    if (!normalized || seen.has(normalized.url)) continue;
    seen.add(normalized.url);
    results.push(normalized);
  }
  return results;
}

function resolveStyle(value) {
  const style = String(value ?? "").trim().toLowerCase();
  return WEB_SEARCH_API_STYLES.includes(style) ? style : "query";
}

/**
 * Собирает адаптер поискового API. Возвращает null, если сервис не настроен: пустая
 * конфигурация не должна ломать исследование, она должна просто не участвовать.
 *
 * @param {object} config
 * @param {string} config.endpoint   полный адрес поискового эндпоинта
 * @param {string} [config.apiKey]   ключ сервиса; уходит в Authorization: Bearer
 * @param {string} [config.apiKeyHeader] переопределение заголовка авторизации
 * @param {"query"|"json"} [config.style]
 * @param {number} [config.maxResults]
 * @param {number} [config.timeoutMs]
 * @param {typeof fetch} [config.fetchImpl]
 */
export function createWebSearchApiProvider(config = {}) {
  const endpoint = String(config.endpoint ?? "").trim();
  if (!endpoint) return null;
  const style = resolveStyle(config.style);
  const apiKey = String(config.apiKey ?? "").trim();
  const apiKeyHeader = String(config.apiKeyHeader ?? "").trim() || "authorization";
  const maxResults = Math.max(1, Math.min(50, Number(config.maxResults) || DEFAULT_MAX_RESULTS));
  const timeoutMs = Math.max(1_000, Number(config.timeoutMs) || DEFAULT_TIMEOUT_MS);

  return {
    name: "search-api",
    async search(query, context = {}) {
      const fetchImpl = config.fetchImpl || context.fetchImpl || fetch;
      const url = new URL(endpoint);
      let init;
      if (style === "json") {
        url.searchParams.set("q", query);
        init = {
          method: "POST",
          headers: { "content-type": "application/json", accept: "application/json" },
          body: JSON.stringify({ query, q: query, count: maxResults, limit: maxResults }),
        };
      } else {
        url.searchParams.set("q", query);
        url.searchParams.set("count", String(maxResults));
        init = { method: "GET", headers: { accept: "application/json" } };
      }
      if (apiKey) init.headers[apiKeyHeader] = `Bearer ${apiKey}`;
      const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!response?.ok) {
        const error = new Error(`search_api_http_${response?.status ?? "unknown"}`);
        error.code = `search_api_http_${response?.status ?? "unknown"}`;
        throw error;
      }
      const payload = await response.json();
      return parseProviderPayload(payload);
    },
  };
}

/**
 * Все поисковые провайдеры в порядке приоритета.
 *
 * Платный сервис первым: он отвечает за качество, когда настроен. Дальше идут
 * бесплатные адаптеры Радара — они остаются резервом и единственным путём, пока
 * ключа нет. SearXNG стоит перед ними, потому что локальный агрегатор стабильнее
 * скрапинга чужой выдачи.
 */
export function resolveWebSearchProviders(env = {}, options = {}) {
  const api = createWebSearchApiProvider({
    endpoint: env.AURORA_SEARCH_API_URL,
    apiKey: env.AURORA_SEARCH_API_KEY,
    apiKeyHeader: env.AURORA_SEARCH_API_KEY_HEADER,
    style: env.AURORA_SEARCH_API_STYLE,
    maxResults: env.AURORA_SEARCH_MAX_RESULTS,
    timeoutMs: env.AURORA_SEARCH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });
  return {
    api,
    searxngUrl: options.searxngUrl ?? (env.RADAR_SEARXNG_URL || undefined),
    fetchImpl: options.fetchImpl || fetch,
  };
}

/** Настроен ли платный поисковый сервис: нужно для честного сообщения в интерфейсе. */
export function webSearchApiConfigured(env = {}) {
  return Boolean(String(env.AURORA_SEARCH_API_URL ?? "").trim());
}

/**
 * Поиск с приоритетом: сначала настроенный сервис, потом бесплатные адаптеры.
 *
 * Живёт здесь, а не в диалоговом конвейере, потому что тем же порядком пользуется
 * фоновое исследование: качество выдачи решает качество ответа в обоих контурах, и
 * держать два разных порядка — значит чинить одно и забывать другое.
 *
 * @param {string} query
 * @param {object} options
 * @param {(query: string) => Promise<Array<object>>} options.fallback бесплатные адаптеры
 * @param {object} [options.env]
 */
export async function searchWithProviderPriority(query, options = {}) {
  const env = options.env || process.env;
  const api = options.api !== undefined
    ? options.api
    : createWebSearchApiProvider({
      endpoint: env.AURORA_SEARCH_API_URL,
      apiKey: env.AURORA_SEARCH_API_KEY,
      apiKeyHeader: env.AURORA_SEARCH_API_KEY_HEADER,
      style: env.AURORA_SEARCH_API_STYLE,
      maxResults: env.AURORA_SEARCH_MAX_RESULTS,
      timeoutMs: env.AURORA_SEARCH_TIMEOUT_MS,
      fetchImpl: options.fetchImpl,
    });
  if (api) {
    try {
      const results = await api.search(query, { fetchImpl: options.fetchImpl });
      if (Array.isArray(results) && results.length) return results;
    } catch {
      // Ключ истёк, лимит исчерпан, сервис лежит — это не повод оставить пользователя
      // без ответа: ниже идут бесплатные адаптеры.
    }
  }
  if (typeof options.fallback !== "function") {
    throw new Error("search_provider_fallback_missing");
  }
  return options.fallback(query);
}
