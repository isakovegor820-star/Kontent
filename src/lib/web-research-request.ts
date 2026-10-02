// Строгая проверка входа POST /api/web-research.
//
// Вынесена из маршрута по двум причинам: Next.js запрещает экспортировать из
// route.ts что-либо, кроме HTTP-методов, а проверка «не доверяем числам клиента»
// должна быть покрыта тестом без поднятия базы и очереди.

/** Категории исследования совпадают с категориями реестра источников. */
export const WEB_RESEARCH_REQUEST_CATEGORIES = ["law", "benchmark", "market", "technology", "statistics", "society"] as const;
export const WEB_RESEARCH_REQUEST_LANGUAGES = ["RU", "EN", "ANY"] as const;
export const WEB_RESEARCH_TOPIC_LIMIT = 300;
export const WEB_RESEARCH_MAX_CATEGORIES = 6;
export const WEB_RESEARCH_MAX_FINGERPRINTS = 200;
export const WEB_RESEARCH_MAX_FINGERPRINT_LENGTH = 80;

export type WebResearchRequestLanguage = (typeof WEB_RESEARCH_REQUEST_LANGUAGES)[number];

/**
 * Номер канала из адреса. Возвращает `null`, если канал не выбран,
 * и `NaN` — если значение прислали неверным: это разные ответы (422 против 404).
 */
export function requestedChannelId(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : Number.NaN;
}

export function cleanTopic(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const topic = value.replace(/\s+/gu, " ").trim().slice(0, WEB_RESEARCH_TOPIC_LIMIT);
  return topic || null;
}

export function cleanCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(WEB_RESEARCH_REQUEST_CATEGORIES);
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const category = item.trim().toLowerCase();
    if (!allowed.has(category) || result.includes(category)) continue;
    result.push(category);
    if (result.length >= WEB_RESEARCH_MAX_CATEGORIES) break;
  }
  return result;
}

export function cleanLanguage(value: unknown): WebResearchRequestLanguage | null {
  if (typeof value !== "string") return null;
  const language = value.trim().toUpperCase();
  return (WEB_RESEARCH_REQUEST_LANGUAGES as readonly string[]).includes(language)
    ? (language as WebResearchRequestLanguage)
    : null;
}

export function cleanFingerprints(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const fingerprint = item.trim();
    if (!fingerprint || fingerprint.length > WEB_RESEARCH_MAX_FINGERPRINT_LENGTH || result.includes(fingerprint)) continue;
    result.push(fingerprint);
    if (result.length >= WEB_RESEARCH_MAX_FINGERPRINTS) break;
  }
  return result;
}

/**
 * Тема исследования. Явная тема пользователя важнее профиля, но если её нет —
 * берём нишу, рубрики и цель канала: «Исследовать интернет» обязано работать
 * без ввода, одной кнопкой.
 */
export function topicFromBrief(brief: { niche?: string | null; rubrics?: string[] | null; goal?: string | null } | undefined): string | null {
  if (!brief) return null;
  const niche = cleanTopic(brief.niche);
  const rubrics = Array.isArray(brief.rubrics)
    ? brief.rubrics.map((item) => cleanTopic(item)).filter((item): item is string => Boolean(item)).slice(0, 3)
    : [];
  const goal = cleanTopic(brief.goal);
  return cleanTopic([niche, ...rubrics].filter(Boolean).join(", ")) || goal;
}

export function languageFromBrief(brief: { language?: string | null } | undefined): WebResearchRequestLanguage {
  const language = String(brief?.language ?? "").trim().toLowerCase();
  return language.startsWith("en") ? "EN" : "RU";
}
