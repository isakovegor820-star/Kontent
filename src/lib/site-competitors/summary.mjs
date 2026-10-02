// Сравнение с конкурентами: снимок чужого сайта в тех же измеримых величинах,
// что и свой профиль. Никаких оценок «лучше/хуже» — только числа и темы,
// чтобы человек сам увидел, где у него пробел, а где преимущество.

export const SITE_COMPETITOR_LIMIT = 3;

/** Конкурента читаем меньшим лимитом, чем свой сайт: сравнение, а не полный аудит. */
export const SITE_COMPETITOR_CRAWL_LIMITS = Object.freeze({
  maxPages: 10,
  maxPageBytes: 2_000_000,
  maxTotalBytes: 12_000_000,
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxSitemaps: 2,
  maxSitemapUrlCount: 60,
  maxSitemapUrls: 60,
});

const ORGANIZATION_SCHEMAS = new Set([
  "Organization",
  "LocalBusiness",
  "Corporation",
  "LegalService",
  "NGO",
  "OnlineBusiness",
]);

/**
 * Ключ темы для сравнения. Русские слова меняются в падежах: «банкротство» у нас и
 * «банкротству» у конкурента — одна тема, а не две. Сравниваем по основе слова.
 */
function themeKey(value) {
  const text = String(value || "").toLocaleLowerCase("ru-RU").replace(/[^a-zа-яё0-9]/giu, "");
  return text.length >= 6 ? text.slice(0, 6) : text;
}

function average(values) {
  const numbers = values.filter((value) => Number.isFinite(value) && value > 0);
  if (numbers.length === 0) return 0;
  return Math.round(numbers.reduce((sum, value) => sum + value, 0) / numbers.length);
}

/**
 * Снимок конкурента: сколько открытых страниц прочитано, средняя длина текста,
 * на скольких страницах есть разметка, есть ли Organization и FAQPage, ведущие темы.
 */
export function buildCompetitorSummary({ domain, pages, report = null, checkedAt = null } = {}) {
  const good = (Array.isArray(pages) ? pages : []).filter((page) => page?.status >= 200 && page?.status < 400);
  const schemaTypes = good.map((page) => (Array.isArray(page.schemaTypes) ? page.schemaTypes : []));
  const themes = Array.isArray(report?.themes)
    ? report.themes.slice(0, 8).map((theme) => ({
        theme: String(theme.theme || "").slice(0, 60),
        occurrences: Number(theme.occurrences || 0),
      })).filter((theme) => theme.theme)
    : [];
  return Object.freeze({
    domain: String(domain || "").slice(0, 253),
    pages: good.length,
    avgWords: average(good.map((page) => Number(page?.technical?.wordCount || 0))),
    pagesWithSchema: schemaTypes.filter((types) => types.length > 0).length,
    hasOrganization: schemaTypes.some((types) => types.some((type) => ORGANIZATION_SCHEMAS.has(type))),
    hasFaq: schemaTypes.some((types) => types.includes("FAQPage")),
    clientRenderedPages: good.filter((page) => page?.technical?.clientRendered === true).length,
    themes,
    checkedAt: checkedAt ? new Date(checkedAt).toISOString() : new Date().toISOString(),
  });
}

/** Своя сторона сравнения — из профиля сайта, без повторного обхода. */
export function summarizeSiteProfile(profile) {
  if (!profile) return null;
  const technical = profile.technical || {};
  return {
    pages: Number(profile.pageCount || 0),
    avgWords: Number(technical.avgWords || 0),
    pagesWithSchema: Number(technical.pagesWithSchema || 0),
    hasOrganization: technical.hasOrganization === true,
    hasFaq: technical.hasFaqSchema === true,
    themes: (Array.isArray(profile.topics) ? profile.topics : []).slice(0, 8).map((topic) => String(topic.label || topic.key || "")),
  };
}

/**
 * Что видно при сравнении: темы конкурента, которых нет у нас, и темы, где его
 * страницы длиннее. Формулировки нейтральные — это подсказка, а не приговор.
 */
export function compareWithCompetitors(profile, competitors) {
  const own = summarizeSiteProfile(profile);
  const rows = (Array.isArray(competitors) ? competitors : [])
    .filter((item) => item?.status === "ready" && item.summary)
    .map((item) => ({
      domain: item.domain,
      pages: Number(item.summary.pages || 0),
      avgWords: Number(item.summary.avgWords || 0),
      pagesWithSchema: Number(item.summary.pagesWithSchema || 0),
      hasOrganization: item.summary.hasOrganization === true,
      hasFaq: item.summary.hasFaq === true,
      clientRenderedPages: Number(item.summary.clientRenderedPages || 0),
      themes: (Array.isArray(item.summary.themes) ? item.summary.themes : []).map((theme) => String(theme.theme || "")).filter(Boolean),
      checkedAt: item.summary.checkedAt || null,
    }));
  if (!own) return { own: null, rows, missingThemes: [], deeperCompetitors: [] };

  const ownThemes = new Set(own.themes.map(themeKey).filter(Boolean));
  const missingThemes = [];
  for (const row of rows) {
    for (const theme of row.themes) {
      const key = themeKey(theme);
      if (!key || ownThemes.has(key)) continue;
      if (!missingThemes.some((item) => themeKey(item.theme) === key)) {
        missingThemes.push({ theme, competitor: row.domain });
      }
    }
  }
  const deeperCompetitors = rows
    .filter((row) => own.avgWords > 0 && row.avgWords > own.avgWords * 1.25)
    .map((row) => ({ domain: row.domain, avgWords: row.avgWords }));

  return { own, rows, missingThemes: missingThemes.slice(0, 8), deeperCompetitors };
}
