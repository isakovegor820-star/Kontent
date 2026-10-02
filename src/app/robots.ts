import type { MetadataRoute } from "next";

import { DISALLOWED_PATHS, publicOrigin } from "@/lib/seo/public-routes";

/**
 * robots.txt домена продукта.
 *
 * До этого файла на домене не было /robots.txt вообще: краулер получал 404 и не знал ни
 * про карту сайта, ни про служебные разделы.
 *
 * Второе правило — не украшение, а защита от регрессии. Оно фиксирует в репозитории то,
 * что поисковые и AI-краулеры разрешены: 38% цитирований в генеративных ответах приходят
 * из топ-10 обычного поиска, а ответы Алисы строятся поверх органики. Закрыть
 * OAI-SearchBot, PerplexityBot, Claude-SearchBot, Bingbot, YandexBot или Googlebot —
 * это не «защита контента», а выключение собственной видимости. Если однажды кто-то
 * добавит общее `Disallow: /` для `*`, именованные правила ниже сохранят доступ.
 *
 * ChatGPT-User и Perplexity-User сюда не входят осознанно: они ходят по запросу
 * пользователя, и robots.txt для них не является механизмом управления.
 */
const SEARCH_AND_AI_AGENTS: readonly string[] = Object.freeze([
  // Классический поиск — источник топ-10, из которого растут цитирования.
  "Googlebot",
  "Googlebot-Image",
  "Bingbot",
  "YandexBot",
  "DuckDuckBot",
  "Applebot",
  // Поисковые агенты генеративных движков.
  "OAI-SearchBot",
  "ChatGPT-User",
  "PerplexityBot",
  "ClaudeBot",
  "Claude-SearchBot",
  "Claude-User",
  "Google-Extended",
  "Applebot-Extended",
  "Amazonbot",
  "MistralAI-User",
]);

export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: [...DISALLOWED_PATHS] },
      { userAgent: [...SEARCH_AND_AI_AGENTS], allow: "/", disallow: [...DISALLOWED_PATHS] },
    ],
    sitemap: origin ? `${origin}/sitemap.xml` : undefined,
  };
}
