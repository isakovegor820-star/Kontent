// Проверка поискового сервиса: отвечает ли он и что отдаёт.
//
// Запуск:
//   node --env-file-if-exists=.env.local scripts/search-provider-check.mjs "6 astra"
//
// Показывает три вещи, которые нельзя увидеть из интерфейса: настроен ли ключ, сколько
// миллисекунд отвечает сервис и какие ссылки он возвращает. Без ключа скрипт проверяет
// бесплатные адаптеры Радара — это позволяет сравнить качество до и после подключения.

import { discoverRadarWebCandidates } from "../src/lib/radar-search.mjs";
import { createWebSearchApiProvider, webSearchApiConfigured } from "../src/lib/web-search-provider.mjs";

const query = process.argv.slice(2).join(" ").trim() || "6 astra";
const env = process.env;

const api = createWebSearchApiProvider({
  endpoint: env.AURORA_SEARCH_API_URL,
  apiKey: env.AURORA_SEARCH_API_KEY,
  apiKeyHeader: env.AURORA_SEARCH_API_KEY_HEADER,
  style: env.AURORA_SEARCH_API_STYLE,
  maxResults: env.AURORA_SEARCH_MAX_RESULTS,
  timeoutMs: env.AURORA_SEARCH_TIMEOUT_MS,
});

console.log(`запрос: ${JSON.stringify(query)}`);
console.log(`поисковый API: ${webSearchApiConfigured(env) ? env.AURORA_SEARCH_API_URL : "не настроен (AURORA_SEARCH_API_URL пуст)"}`);
console.log(`ключ: ${env.AURORA_SEARCH_API_KEY ? "задан" : "не задан"}`);
console.log(`стиль запроса: ${env.AURORA_SEARCH_API_STYLE || "query"}`);
console.log("");

if (api) {
  const startedAt = Date.now();
  try {
    const results = await api.search(query, { fetchImpl: fetch });
    console.log(`API ответил: ${results.length} результатов за ${Date.now() - startedAt} мс`);
    for (const item of results.slice(0, 8)) {
      console.log(`  • ${item.title || "(без заголовка)"}`);
      console.log(`    ${item.url}`);
      if (item.snippet) console.log(`    ${item.snippet.slice(0, 130)}`);
      console.log(`    дата: ${item.publishedAt ?? "не указана"}`);
    }
    if (!results.length) {
      console.log("  Сервис ответил успешно, но результатов нет: проверьте стиль запроса");
      console.log("  (AURORA_SEARCH_API_STYLE=json для POST-сервисов) и имя параметра запроса.");
    }
  } catch (error) {
    console.log(`API не ответил: ${error?.code || error?.name} — ${error?.message}`);
    console.log("  Проверьте адрес эндпоинта, ключ, стиль запроса и заголовок авторизации.");
  }
  console.log("");
}

const radarStartedAt = Date.now();
try {
  const candidates = await discoverRadarWebCandidates(query, { fetchImpl: fetch, searxngUrl: env.RADAR_SEARXNG_URL });
  console.log(`бесплатные адаптеры: ${candidates.length} кандидатов за ${Date.now() - radarStartedAt} мс`);
  for (const candidate of candidates.slice(0, 8)) {
    console.log(`  • ${candidate.title || "(без заголовка)"} [${(candidate.providers || []).join(",") || "—"}]`);
    console.log(`    ${candidate.canonicalUrl}`);
  }
} catch (error) {
  console.log(`бесплатные адаптеры недоступны: ${error?.code || error?.name} — ${error?.message}`);
}
