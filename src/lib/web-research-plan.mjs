// Планировщик исследовательских запросов. Превращает тему канала в набор
// поисковых запросов, которые ведут к первоисточникам, а не к пересказам.
//
// Ключевая идея: для нормы права и бенчмарка обычный поиск по теме возвращает
// статьи «что известно о законопроекте». Поэтому планировщик обязан выдавать
// часть запросов с `site:`-ограничением на реестр доверенных доменов.
//
// Модуль чистый: ни сети, ни БД, ни Redis.

import { WEB_SOURCE_REGISTRY, WEB_SOURCE_TIER_TRUST, webSourceDomainsForCategory } from "./web-research-sources.mjs";

export const WEB_RESEARCH_BUDGET = Object.freeze({
  maxQueries: 6,
  maxPages: 12,
  maxCandidates: 60,
  maxResponseBytes: 2 * 1024 * 1024,
  deadlineMs: 45_000,
});

export const WEB_RESEARCH_LIMITS = Object.freeze({
  minQueries: 1,
  maxQueries: 12,
  minPages: 1,
  maxPages: 40,
  minCandidates: 5,
  maxCandidates: 400,
  minDeadlineMs: 5_000,
  maxDeadlineMs: 120_000,
});

/** Какие категории реестра имеют смысл для каждой категории исследования. */
const CATEGORY_SOURCE_MAP = Object.freeze({
  law: ["law"],
  benchmark: ["benchmark", "technology"],
  market: ["market", "statistics"],
  statistics: ["statistics", "market"],
  technology: ["technology", "benchmark"],
  society: ["society", "law"],
});

const STOP_WORDS = new Set([
  "аврора", "будет", "были", "было", "быть", "весь", "все", "всех", "где", "для", "его", "если",
  "есть", "еще", "ещё", "или", "ими", "имеет", "как", "какие", "какой", "когда", "который",
  "между", "менее", "можно", "надо", "наиболее", "нам", "наш", "наша", "наши", "него", "нее",
  "неё", "нет", "них", "они", "оно", "она", "они", "очек", "очень", "под", "после", "при",
  "про", "сам", "свой", "своих", "себя", "так", "такой", "там", "тема", "теме", "темы", "то",
  "того", "тоже", "только", "том", "ты", "уже", "хотя", "чего", "чей", "чем", "что", "чтобы",
  "эта", "эти", "это", "этот", "я", "канал", "канала", "пост", "посты", "контент", "аудитория",
  // Глаголы-задачи: в теме канала это шум, а в поисковом запросе — лишние слова.
  "писать", "сделать", "делать", "рассказать", "показать", "найти", "искать", "взять", "дать",
  "разобрать", "объяснить", "подготовить", "собрать", "выбрать", "понять", "узнать",
]);

const QUERY_STOP_EN = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "are", "was", "were",
  "will", "can", "not", "but", "you", "your", "our", "its", "into", "about", "over", "more",
]);

/** Слова темы длиной от 4 символов, без стоп-слов, в порядке первого появления. */
export function webResearchKeywords(value, limit = 8) {
  const tokens = String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .split(/[^a-zа-я0-9]+/giu)
    .filter(Boolean);
  const seen = new Set();
  const keywords = [];
  for (const token of tokens) {
    if (token.length < 4) continue;
    if (STOP_WORDS.has(token) || QUERY_STOP_EN.has(token)) continue;
    if (/^\d+$/u.test(token)) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
    if (keywords.length >= Math.max(1, Number(limit) || 8)) break;
  }
  return keywords;
}

export function webResearchTopic(value, options = {}) {
  const limit = Number(options.keywordLimit) || 8;
  const keywords = webResearchKeywords(value, limit);
  if (keywords.length) return keywords.slice(0, 5).join(" ");
  const fallback = String(value ?? "").replace(/\s+/gu, " ").trim();
  return fallback.slice(0, 120);
}

function clamp(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

export function normalizeWebResearchBudget(input = {}) {
  return Object.freeze({
    maxQueries: clamp(input.maxQueries, WEB_RESEARCH_LIMITS.minQueries, WEB_RESEARCH_LIMITS.maxQueries, WEB_RESEARCH_BUDGET.maxQueries),
    maxPages: clamp(input.maxPages, WEB_RESEARCH_LIMITS.minPages, WEB_RESEARCH_LIMITS.maxPages, WEB_RESEARCH_BUDGET.maxPages),
    maxCandidates: clamp(input.maxCandidates, WEB_RESEARCH_LIMITS.minCandidates, WEB_RESEARCH_LIMITS.maxCandidates, WEB_RESEARCH_BUDGET.maxCandidates),
    maxResponseBytes: clamp(input.maxResponseBytes, 64 * 1024, 10 * 1024 * 1024, WEB_RESEARCH_BUDGET.maxResponseBytes),
    deadlineMs: clamp(input.deadlineMs, WEB_RESEARCH_LIMITS.minDeadlineMs, WEB_RESEARCH_LIMITS.maxDeadlineMs, WEB_RESEARCH_BUDGET.deadlineMs),
  });
}

/**
 * Домены, которым планировщик доверяет `site:`-запрос: только верхние уровни,
 * иначе запросов станет больше, чем позволяет бюджет.
 */
export function webResearchScopedDomains(category, language) {
  const sourceCategories = CATEGORY_SOURCE_MAP[category] || [category];
  const domains = [];
  for (const sourceCategory of sourceCategories) {
    for (const domain of webSourceDomainsForCategory(sourceCategory, language ? { language } : {})) {
      const entry = WEB_SOURCE_REGISTRY.find((item) => item.domain === domain);
      if (!entry) continue;
      if (WEB_SOURCE_TIER_TRUST[entry.tier] < WEB_SOURCE_TIER_TRUST.professional) continue;
      if (!domains.includes(domain)) domains.push(domain);
    }
  }
  return domains;
}

/**
 * Собирает план исследования.
 *
 * @param {object} input
 * @param {string} input.topic            тема канала или запрос пользователя
 * @param {string[]} [input.categories]   категории фактов, которые ищем
 * @param {"RU"|"EN"|"ANY"} [input.language]
 * @param {string[]} [input.extraQueries] готовые запросы (например, из «Сегодня»)
 * @param {object} [input.budget]
 * @param {boolean} [input.includeScoped]
 */
export function planWebResearch(input = {}, options = {}) {
  const topicValue = String(input.topic ?? "").trim();
  if (!topicValue && !(Array.isArray(input.extraQueries) && input.extraQueries.length)) {
    throw new Error("planWebResearch: нужна тема или готовые запросы");
  }
  const topic = webResearchTopic(topicValue, options);
  const language = input.language === "EN" ? "EN" : input.language === "RU" ? "RU" : "ANY";
  const sourceCategories = Array.isArray(input.categories) && input.categories.length
    ? input.categories.map((value) => String(value))
    : ["law"];
  const budget = normalizeWebResearchBudget(input.budget);
  const includeScoped = input.includeScoped !== false;

  /** @type {Array<{id: string, text: string, category: string, language: string, siteScoped: boolean, priority: number}>} */
  const queries = [];
  const seen = new Set();
  const push = (text, category, queryLanguage, siteScoped, priority) => {
    const cleaned = String(text ?? "").replace(/\s+/gu, " ").trim();
    if (!cleaned) return;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    queries.push({
      id: `q${queries.length + 1}`,
      text: cleaned.slice(0, 240),
      category,
      language: queryLanguage,
      siteScoped,
      priority,
    });
  };

  for (const raw of Array.isArray(input.extraQueries) ? input.extraQueries : []) {
    push(raw, sourceCategories[0], language === "EN" ? "EN" : "RU", false, 100);
  }

  // Сначала — приоритетные `site:`-запросы: они дают первоисточник, а не пересказ.
  if (includeScoped && topic) {
    for (const category of sourceCategories) {
      for (const domain of webResearchScopedDomains(category, language === "ANY" ? null : language).slice(0, 2)) {
        const suffix = category === "law" ? "законопроект" : "";
        push(`site:${domain} ${topic} ${suffix}`, category, language === "EN" ? "EN" : "RU", true, 90);
      }
    }
  }

  // Затем — тематические запросы без ограничения домена: находят то, чего нет в реестре.
  if (topic) {
    for (const category of sourceCategories) {
      const suffix = {
        law: "законопроект изменения",
        benchmark: "benchmark результаты тест",
        market: "рынок объём исследование",
        statistics: "статистика данные исследование",
        technology: "технология исследование",
        society: "исследование данные",
      }[category] || "";
      push(`${topic} ${suffix}`, category, language === "EN" ? "EN" : "RU", false, 80);
    }
    if (language === "ANY") {
      push(`${topic} benchmark research report`, sourceCategories[0], "EN", false, 70);
    }
    push(`${topic} 2026`, sourceCategories[0], language === "EN" ? "EN" : "RU", false, 60);
  }

  const limited = queries
    .sort((left, right) => right.priority - left.priority)
    .slice(0, budget.maxQueries)
    .map((query, index) => ({ ...query, id: `q${index + 1}` }));

  return {
    topic,
    language,
    categories: sourceCategories,
    queries: limited,
    budget,
    siteScopedCount: limited.filter((query) => query.siteScoped).length,
    fingerprint: webResearchPlanFingerprint(topic, sourceCategories, limited.map((query) => query.text)),
  };
}

export function webResearchPlanFingerprint(topic, categories, queryTexts) {
  // Запросы сортируются: одинаковый по смыслу план, собранный из категорий в разном
  // порядке, обязан давать один отпечаток — иначе кэш исследования не сработает и
  // Аврора пойдёт в интернет повторно за тем же самым.
  const input = [
    String(topic ?? ""),
    [...(categories || [])].sort().join(","),
    [...(queryTexts || [])].sort().join("|"),
  ].join("\n");
  let hash = 0;
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return `wrp-${Math.abs(hash).toString(36)}-${input.length.toString(36)}`;
}

/**
 * Насколько результат поиска похож на первоисточник. Используется, чтобы
 * сортировать кандидатов до скачивания страниц и не тратить бюджет впустую.
 */
export function scoreWebResearchCandidate(candidate, plan) {
  const url = String(candidate?.url ?? "");
  const title = String(candidate?.title ?? "");
  const snippet = String(candidate?.snippet ?? "");
  let score = 0;

  // Реестр доверия к домену.
  const entry = WEB_SOURCE_REGISTRY.find((item) => {
    const domain = item.domain;
    return url.includes(`//${domain}`) || url.includes(`.${domain}`) || url.includes(`//www.${domain}`);
  });
  score += entry ? WEB_SOURCE_TIER_TRUST[entry.tier] * 0.4 : 8;

  // Совпадение темы.
  const keywords = webResearchKeywords(plan?.topic, 8);
  const haystack = `${title} ${snippet}`.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
  const matched = keywords.filter((keyword) => haystack.includes(keyword)).length;
  score += keywords.length ? (matched / keywords.length) * 25 : 0;

  // Признаки нормы права усиливают кандидата для юридической категории.
  if ((plan?.categories || []).includes("law")) {
    if (/(законопроект|федеральный закон|вступает в силу|принят в первом чтении|внесен в государственную думу|внесён в государственную думу)/iu.test(`${title} ${snippet}`)) {
      score += 12;
    }
  }
  // Признаки бенчмарка.
  if ((plan?.categories || []).includes("benchmark")) {
    if (/(benchmark|бенчмарк|результаты тестирования|исследование|report|study)/iu.test(`${title} ${snippet}`)) {
      score += 10;
    }
  }
  // Год в заголовке — сигнал свежести.
  const currentYear = new Date().getUTCFullYear();
  if (new RegExp(String(currentYear), "u").test(title)) score += 6;

  return Math.round(Math.min(100, Math.max(0, score)) * 10) / 10;
}
