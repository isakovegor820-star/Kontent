/**
 * Типы материалов для сайта (раздел 6 спецификации) и правила выбора.
 * Правило «один источник — один материал» и недельные квоты закреплены здесь, а не в промпте:
 * ритм задаёт профиль сайта, а не лента новостей.
 */

export const SITE_ARTICLE_TYPES = Object.freeze({
  company_news: Object.freeze({
    id: "company_news",
    label: "Новость компании",
    minWords: 120,
    maxWords: 450,
    requires: Object.freeze(["date_or_event", "internal_link"]),
  }),
  industry_explainer: Object.freeze({
    id: "industry_explainer",
    label: "Разбор отраслевой новости",
    minWords: 500,
    maxWords: 1400,
    requires: Object.freeze(["source_link", "what_it_means_block", "internal_link", "h2"]),
  }),
  audience_answer: Object.freeze({
    id: "audience_answer",
    label: "Ответ на вопрос аудитории",
    minWords: 300,
    maxWords: 1200,
    requires: Object.freeze(["direct_answer_first", "faq_schema", "internal_link"]),
  }),
  evergreen_guide: Object.freeze({
    id: "evergreen_guide",
    label: "Гид по теме",
    minWords: 900,
    maxWords: 2500,
    requires: Object.freeze(["h2", "two_internal_links"]),
  }),
  case_study: Object.freeze({
    id: "case_study",
    label: "Кейс",
    minWords: 300,
    maxWords: 1200,
    requires: Object.freeze(["before_after", "internal_link"]),
  }),
  machine_readable_page: Object.freeze({
    id: "machine_readable_page",
    label: "Машиночитаемая страница о компании",
    minWords: 80,
    maxWords: 600,
    requires: Object.freeze(["organization_schema"]),
  }),
});

export const SITE_ARTICLE_TYPE_IDS = Object.freeze(Object.keys(SITE_ARTICLE_TYPES));
export const SITE_ARTICLE_ORIGINS = Object.freeze(["rss", "channel_post", "audience_question", "gap", "manual"]);

/**
 * Недельные квоты по умолчанию для малого бизнеса: ответы на вопросы и гиды важнее новостей.
 * `sharedPools` — типы, делящие один лимит (разбор ИЛИ гид, не оба).
 */
export const DEFAULT_SITE_CADENCE = Object.freeze({
  weekly: Object.freeze({
    audience_answer: 1,
    industry_explainer: 1,
    evergreen_guide: 1,
    company_news: 2,
    case_study: 1,
    machine_readable_page: 1,
  }),
  sharedPools: Object.freeze([Object.freeze({ types: ["industry_explainer", "evergreen_guide"], limit: 1 })]),
  maxPendingReview: 4,
});

function boundedInt(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function normalizeSiteCadence(raw = {}) {
  const weekly = {};
  for (const type of SITE_ARTICLE_TYPE_IDS) {
    weekly[type] = boundedInt(raw?.weekly?.[type], DEFAULT_SITE_CADENCE.weekly[type], 0, 14);
  }
  const sharedPools = Array.isArray(raw?.sharedPools)
    ? raw.sharedPools
      .map((pool) => ({
        types: (Array.isArray(pool?.types) ? pool.types : []).filter((type) => SITE_ARTICLE_TYPE_IDS.includes(type)),
        limit: boundedInt(pool?.limit, 1, 0, 14),
      }))
      .filter((pool) => pool.types.length >= 2)
    : [...DEFAULT_SITE_CADENCE.sharedPools];
  return Object.freeze({
    weekly: Object.freeze(weekly),
    sharedPools: Object.freeze(sharedPools),
    maxPendingReview: boundedInt(raw?.maxPendingReview, DEFAULT_SITE_CADENCE.maxPendingReview, 1, 20),
  });
}

/** Остаток квоты на неделю по типам с учётом общих пулов. */
export function remainingQuota(cadence, createdThisWeekByType = {}) {
  const normalized = normalizeSiteCadence(cadence);
  const remaining = {};
  for (const type of SITE_ARTICLE_TYPE_IDS) {
    remaining[type] = Math.max(0, normalized.weekly[type] - Number(createdThisWeekByType[type] || 0));
  }
  for (const pool of normalized.sharedPools) {
    const used = pool.types.reduce((sum, type) => sum + Number(createdThisWeekByType[type] || 0), 0);
    const left = Math.max(0, pool.limit - used);
    for (const type of pool.types) remaining[type] = Math.min(remaining[type], left);
  }
  return remaining;
}

const EVENT_MARKERS = /(?:открыл|открыва|запустил|запуска|провел|провёл|провели|состоял|переехал|получил[аи]? (?:лицензи|награ|сертиф)|новый (?:филиал|офис|кабинет)|скидк|акци[яи]|с \d{1,2}\s+[а-я]+\s+\d{4}|\b\d{1,2}\.\d{2}\.\d{4}\b)/iu;
const CASE_MARKERS = /(?:до и после|результат|кейс|сделали|выполнили|заказчик|клиент обратился|проект)/iu;

function words(text) {
  return new Set(String(text || "").toLocaleLowerCase("ru-RU").match(/[a-zа-яё][a-zа-яё-]{3,}/giu) || []);
}

function topicMatch(profile, text) {
  const tokens = words(text);
  const topics = Array.isArray(profile?.topics) ? profile.topics : [];
  return topics.find((topic) => tokens.has(String(topic.key)) || [...tokens].some((token) => token.startsWith(String(topic.key).slice(0, 6)) && String(topic.key).length >= 6));
}

/**
 * Возвращает тип материала для источника или null, если материал делать не нужно.
 * Правило детерминировано и покрыто тестами; промпт его не переопределяет.
 */
export function selectArticleType({ origin, source = {}, profile = {} }) {
  switch (origin) {
    case "audience_question":
      return "audience_answer";
    case "rss": {
      const matched = topicMatch(profile, `${source.title || ""} ${source.summary || ""}`);
      return matched ? "industry_explainer" : null;
    }
    case "channel_post": {
      const text = String(source.text || "");
      const mediaCount = Array.isArray(source.media) ? source.media.length : Number(source.mediaCount || 0);
      if (mediaCount >= 2 && CASE_MARKERS.test(text)) return "case_study";
      if (EVENT_MARKERS.test(text)) return "company_news";
      return null;
    }
    case "gap": {
      const kind = String(source.kind || "");
      if (kind === "question_without_answer") return "audience_answer";
      if (kind === "schema_missing") return "machine_readable_page";
      if (kind === "thin_topic") return "evergreen_guide";
      if (kind === "page_type_missing") {
        const type = String(source.key || "").split(":")[1];
        if (type === "about") return "machine_readable_page";
        return null;
      }
      return null;
    }
    case "manual":
      return SITE_ARTICLE_TYPE_IDS.includes(source.articleType) ? source.articleType : null;
    default:
      return null;
  }
}

const TYPE_PRIORITY = Object.freeze({
  machine_readable_page: 0,
  audience_answer: 1,
  evergreen_guide: 2,
  industry_explainer: 3,
  company_news: 4,
  case_study: 5,
});

export function sourceKeyFor(origin, source) {
  switch (origin) {
    case "rss": return `rss:${source.id}`;
    case "channel_post": return `post:${source.id}`;
    case "audience_question": return `question:${source.id}`;
    case "gap": return `gap:${source.key}`;
    default: return null;
  }
}

/**
 * Планирует материалы на неделю: применяет правило выбора типа, отбрасывает уже использованные
 * источники и режет по квотам. Возвращает отсортированный список кандидатов.
 */
export function planArticleCandidates({
  profile,
  cadence,
  sources = {},
  createdThisWeekByType = {},
  existingSourceKeys = new Set(),
  pendingReview = 0,
}) {
  const normalized = normalizeSiteCadence(cadence);
  const remaining = remainingQuota(normalized, createdThisWeekByType);
  let slots = Math.max(0, normalized.maxPendingReview - Number(pendingReview || 0));
  const candidates = [];
  const consider = (origin, list) => {
    for (const source of list || []) {
      const type = selectArticleType({ origin, source, profile });
      if (!type) continue;
      const sourceKey = sourceKeyFor(origin, source);
      if (sourceKey && existingSourceKeys.has(sourceKey)) continue;
      candidates.push({ origin, type, source, sourceKey, priority: TYPE_PRIORITY[type] ?? 9 });
    }
  };
  consider("gap", (profile?.gaps || []).filter((gap) => gap.severity !== "low" || gap.kind === "thin_topic"));
  consider("audience_question", sources.audienceQuestions);
  consider("rss", sources.rssItems);
  consider("channel_post", sources.channelPosts);

  candidates.sort((a, b) => a.priority - b.priority || String(a.sourceKey).localeCompare(String(b.sourceKey)));
  const planned = [];
  const used = {};
  const seenKeys = new Set();
  for (const candidate of candidates) {
    if (slots <= 0) break;
    if (candidate.sourceKey && seenKeys.has(candidate.sourceKey)) continue;
    const left = remaining[candidate.type] - Number(used[candidate.type] || 0);
    if (left <= 0) continue;
    const pool = normalized.sharedPools.find((item) => item.types.includes(candidate.type));
    if (pool) {
      const poolUsed = pool.types.reduce((sum, type) => sum + Number(used[type] || 0) + Number(createdThisWeekByType[type] || 0), 0);
      if (poolUsed >= pool.limit) continue;
    }
    used[candidate.type] = Number(used[candidate.type] || 0) + 1;
    if (candidate.sourceKey) seenKeys.add(candidate.sourceKey);
    slots -= 1;
    planned.push(candidate);
  }
  return planned;
}
