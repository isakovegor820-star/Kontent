import { classifySitePage, sanitizeEvidenceUrl } from "../site-analysis/evidence.mjs";

export const SITE_PROFILE_VERSION = "site-profile-v1";

/** Типы страниц, отсутствие которых считается пробелом профиля. */
export const SITE_PROFILE_EXPECTED_PAGE_TYPES = Object.freeze([
  ["about", "Страница о компании", "high"],
  ["offer", "Страницы услуг или продуктов", "high"],
  ["contact", "Страница контактов", "medium"],
  ["case", "Кейсы и примеры работ", "medium"],
  ["team", "Команда и эксперты", "low"],
  ["article", "Статьи, новости или блог", "medium"],
]);

export const SITE_PROFILE_LINKABLE_TYPES = Object.freeze(["home", "service", "product", "about", "contact", "case"]);

const LINKABLE_PRIORITY = new Map(SITE_PROFILE_LINKABLE_TYPES.map((type, index) => [type, index]));
const MAX_TOPICS = 12;
const MAX_GAP_QUESTIONS = 10;
const MAX_LINKABLE_PAGES = 30;
const MAX_TOPIC_PAGES = 5;
const STRONG_TOPIC_PAGES = 3;
const STRONG_TOPIC_WORDS = 300;
const THIN_PAGE_WORDS = 120;
const ORGANIZATION_SCHEMAS = new Set(["Organization", "Corporation", "LocalBusiness"]);
const QUESTION_HEADING = /\?|^(?:как|что|когда|где|почему|сколько|можно ли|нужно ли|зачем|какой|какие|how|what|why|when|where)\b/iu;
const STOP_WORDS = new Set([
  "для", "как", "что", "это", "или", "при", "про", "также", "если", "чтобы", "когда", "где", "уже", "ещё", "еще",
  "наш", "наша", "наше", "наши", "ваш", "ваша", "ваше", "ваши", "его", "её", "они", "оно", "она", "мы", "вы",
  "все", "всё", "весь", "вся", "быть", "есть", "был", "была", "были", "будет", "может", "можно", "нужно",
  "главная", "страница", "сайт", "сайта", "компания", "компании", "контакты", "новости", "статьи", "блог",
  "the", "and", "with", "your", "you", "for", "from", "this", "that", "are", "our", "home", "page", "site",
  "about", "contact", "news", "blog", "more", "read", "all", "new",
]);

function cleanText(value, max = 500) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

function isOkPage(page) {
  const status = Number(page?.status ?? page?.http_status ?? 0);
  return status >= 200 && status < 400;
}

function pageWords(page) {
  return Number(page?.technical?.wordCount || 0);
}

function pageHeadings(page) {
  return Array.isArray(page?.headings) ? page.headings.filter((heading) => heading && typeof heading.text === "string") : [];
}

function pageSchemas(page) {
  return new Set(Array.isArray(page?.schemaTypes) ? page.schemaTypes : []);
}

function topicWords(text) {
  const words = String(text || "").toLocaleLowerCase("ru-RU").match(/[a-zа-яё][a-zа-яё-]{3,}/giu) || [];
  return words.filter((word) => !STOP_WORDS.has(word));
}

function normalizeDate(value) {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export const SITE_PROFILE_PAGE_TYPES = Object.freeze([
  "home", "team", "case", "partner", "event", "product", "service", "contact", "about", "article", "other",
]);

/**
 * Нормализует кэшированную классификацию модели: типы страниц только из известного списка,
 * кластеры тем — только с двумя и более ключами. Всё остальное отбрасывается молча —
 * профиль остаётся детерминированным при любом ответе классификатора.
 */
export function normalizeSiteClassification(raw) {
  const pageTypes = {};
  for (const [url, type] of Object.entries(raw?.pageTypes || {})) {
    const clean = sanitizeEvidenceUrl(url);
    if (clean && SITE_PROFILE_PAGE_TYPES.includes(String(type))) pageTypes[clean] = String(type);
  }
  const topicClusters = [];
  const usedKeys = new Set();
  for (const cluster of Array.isArray(raw?.topicClusters) ? raw.topicClusters : []) {
    const label = cleanText(cluster?.label, 80).toLocaleLowerCase("ru-RU");
    const keys = [...new Set((Array.isArray(cluster?.keys) ? cluster.keys : [])
      .map((key) => cleanText(key, 80).toLocaleLowerCase("ru-RU"))
      .filter((key) => key && !usedKeys.has(key)))];
    if (!label || keys.length < 2) continue;
    for (const key of keys) usedKeys.add(key);
    topicClusters.push(Object.freeze({ label, keys: Object.freeze(keys) }));
  }
  return Object.freeze({ pageTypes: Object.freeze(pageTypes), topicClusters: Object.freeze(topicClusters) });
}

/** Классифицированный инвентарь: один элемент на URL, без служебных страниц. */
export function classifySitePages(pages, classification = null) {
  const overrides = classification ? normalizeSiteClassification(classification).pageTypes : {};
  const seen = new Set();
  const result = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const url = sanitizeEvidenceUrl(page?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push(Object.freeze({
      url,
      pageType: isOkPage(page) ? (overrides[url] || classifySitePage({ ...page, url })) : "unavailable",
      title: cleanText(page?.title, 300) || null,
      words: pageWords(page),
      ok: isOkPage(page),
      schemaTypes: [...pageSchemas(page)],
      publishedAt: normalizeDate(page?.metadata?.publishedAt),
      headings: pageHeadings(page).map((heading) => ({ level: Number(heading.level || 0), text: cleanText(heading.text, 300) })),
    }));
  }
  return result;
}

function mergeTopicClusters(topics, clusters) {
  if (!clusters?.length) return topics;
  const byKey = new Map(topics.map((topic) => [topic.key, topic]));
  const consumed = new Set();
  const merged = [];
  for (const cluster of clusters) {
    const members = cluster.keys.map((key) => byKey.get(key)).filter(Boolean);
    if (!members.length) continue;
    const pageUrls = [...new Set(members.flatMap((topic) => topic.pageUrls))];
    const pageCount = pageUrls.length;
    const deep = members.some((topic) => topic.coverage === "strong");
    for (const topic of members) consumed.add(topic.key);
    merged.push(Object.freeze({
      key: cluster.label,
      label: cluster.label,
      pageCount,
      occurrences: members.reduce((sum, topic) => sum + topic.occurrences, 0),
      coverage: pageCount >= STRONG_TOPIC_PAGES && deep ? "strong" : "thin",
      pageUrls: pageUrls.slice(0, MAX_TOPIC_PAGES),
      mergedFrom: Object.freeze(members.map((topic) => topic.key)),
    }));
  }
  return [...merged, ...topics.filter((topic) => !consumed.has(topic.key))]
    .sort((a, b) => b.pageCount - a.pageCount || b.occurrences - a.occurrences || a.key.localeCompare(b.key, "ru"))
    .slice(0, MAX_TOPICS);
}

function buildTopics(inventory, clusters = null) {
  const pagesByWord = new Map();
  const occurrences = new Map();
  for (const page of inventory) {
    if (!page.ok) continue;
    const corpus = [page.title, ...page.headings.filter((heading) => heading.level <= 2).map((heading) => heading.text)].filter(Boolean).join(" ");
    const perPage = new Set();
    for (const word of topicWords(corpus)) {
      occurrences.set(word, (occurrences.get(word) || 0) + 1);
      perPage.add(word);
    }
    for (const word of perPage) {
      const list = pagesByWord.get(word) || [];
      list.push(page);
      pagesByWord.set(word, list);
    }
  }
  const topics = [...pagesByWord.entries()]
    .filter(([, pages]) => pages.length >= 2)
    .sort((a, b) => b[1].length - a[1].length || (occurrences.get(b[0]) || 0) - (occurrences.get(a[0]) || 0) || a[0].localeCompare(b[0], "ru"))
    .slice(0, MAX_TOPICS)
    .map(([word, pages]) => {
      const deepPage = pages.some((page) => page.words >= STRONG_TOPIC_WORDS);
      const coverage = pages.length >= STRONG_TOPIC_PAGES && deepPage ? "strong" : "thin";
      return Object.freeze({
        key: word,
        label: word,
        pageCount: pages.length,
        occurrences: occurrences.get(word) || pages.length,
        coverage,
        pageUrls: pages.slice(0, MAX_TOPIC_PAGES).map((page) => page.url),
      });
    });
  return mergeTopicClusters(topics, clusters);
}

function gap(key, kind, severity, label, detail, evidenceUrls = []) {
  return Object.freeze({ key, kind, severity, label, detail, evidenceUrls: evidenceUrls.slice(0, 3) });
}

function buildGaps(inventory, topics, pageTypeCounts) {
  const okPages = inventory.filter((page) => page.ok);
  const gaps = [];

  for (const [type, label, severity] of SITE_PROFILE_EXPECTED_PAGE_TYPES) {
    const present = type === "offer"
      ? (pageTypeCounts.service || 0) + (pageTypeCounts.product || 0) > 0
      : (pageTypeCounts[type] || 0) > 0;
    if (present) continue;
    gaps.push(gap(
      `page_type_missing:${type}`,
      "page_type_missing",
      severity,
      label,
      `В проверенном срезе не найдено страниц типа «${label.toLocaleLowerCase("ru-RU")}».`,
    ));
  }

  const hasOrganization = okPages.some((page) => page.schemaTypes.some((type) => ORGANIZATION_SCHEMAS.has(type)));
  if (!hasOrganization) {
    gaps.push(gap(
      "schema_missing:organization",
      "schema_missing",
      "high",
      "Нет структурированных данных об организации",
      "На проверенных страницах не найдена разметка Organization или LocalBusiness — генеративным движкам нечего цитировать о компании.",
    ));
  }
  const hasFaqSchema = okPages.some((page) => page.schemaTypes.includes("FAQPage"));
  const questionPages = okPages.filter((page) => page.headings.some((heading) => QUESTION_HEADING.test(heading.text)));
  if (!hasFaqSchema) {
    gaps.push(gap(
      "schema_missing:faq",
      "schema_missing",
      "medium",
      "Нет разметки FAQPage",
      questionPages.length
        ? "Вопросные заголовки есть, но без FAQPage-разметки их не подхватят блоки быстрых ответов."
        : "На сайте нет ни вопросных заголовков, ни FAQPage-разметки.",
      questionPages.map((page) => page.url),
    ));
  }

  let questionGaps = 0;
  for (const page of okPages) {
    if (questionGaps >= MAX_GAP_QUESTIONS) break;
    if (page.words >= THIN_PAGE_WORDS) continue;
    for (const heading of page.headings) {
      if (questionGaps >= MAX_GAP_QUESTIONS) break;
      if (!QUESTION_HEADING.test(heading.text)) continue;
      questionGaps += 1;
      gaps.push(gap(
        `question_without_answer:${page.url}#${questionGaps}`,
        "question_without_answer",
        "medium",
        heading.text,
        `Вопрос задан в заголовке, но на странице меньше ${THIN_PAGE_WORDS} слов — прямого ответа нет.`,
        [page.url],
      ));
    }
  }

  for (const topic of topics) {
    if (topic.coverage !== "thin" || topic.pageCount < 2) continue;
    gaps.push(gap(
      `thin_topic:${topic.key}`,
      "thin_topic",
      "low",
      `Тема «${topic.label}» раскрыта поверхностно`,
      `Тема встречается на ${topic.pageCount} страницах, но ни одна не содержит ${STRONG_TOPIC_WORDS}+ слов.`,
      topic.pageUrls,
    ));
  }

  return gaps;
}

function sectionIssues(section) {
  const checks = Array.isArray(section?.checks) ? section.checks : [];
  return checks
    .filter((check) => check.status === "critical" || check.status === "warning")
    .map((check) => Object.freeze({
      id: String(check.id),
      label: cleanText(check.label, 200),
      status: check.status,
      detail: cleanText(check.detail, 500),
      recommendation: cleanText(check.recommendation, 300),
    }));
}

function buildTechnical(report, inventory) {
  const seo = report?.optimization?.seo || null;
  const geo = report?.optimization?.geo || null;
  const failed = inventory.filter((page) => !page.ok).length;
  return Object.freeze({
    pagesChecked: inventory.length - failed,
    failedPages: failed,
    seoScore: Number.isFinite(Number(seo?.score)) ? Number(seo.score) : null,
    seoStatus: seo?.status || null,
    geoScore: Number.isFinite(Number(geo?.score)) ? Number(geo.score) : null,
    geoStatus: geo?.status || null,
    seoIssues: sectionIssues(seo),
    geoIssues: sectionIssues(geo),
    notChecked: [...(seo?.checks || []), ...(geo?.checks || [])]
      .filter((check) => check.status === "not_checked")
      .map((check) => String(check.id)),
    orphanCandidates: Array.isArray(report?.internalLinking?.orphanCandidates) ? report.internalLinking.orphanCandidates.length : null,
  });
}

function buildQuestionCoverage(inventory, gaps) {
  const okPages = inventory.filter((page) => page.ok);
  const withQuestions = okPages.filter((page) => page.headings.some((heading) => QUESTION_HEADING.test(heading.text)));
  return Object.freeze({
    pagesWithQuestions: withQuestions.length,
    answeredPages: withQuestions.filter((page) => page.words >= THIN_PAGE_WORDS).length,
    faqSchemaPages: okPages.filter((page) => page.schemaTypes.includes("FAQPage")).length,
    unansweredQuestions: gaps.filter((item) => item.kind === "question_without_answer").length,
  });
}

function buildLinkablePages(inventory) {
  return inventory
    .filter((page) => page.ok && page.title && LINKABLE_PRIORITY.has(page.pageType))
    .sort((a, b) => LINKABLE_PRIORITY.get(a.pageType) - LINKABLE_PRIORITY.get(b.pageType) || b.words - a.words || a.url.localeCompare(b.url))
    .slice(0, MAX_LINKABLE_PAGES)
    .map((page) => Object.freeze({ url: page.url, title: page.title, pageType: page.pageType }));
}

function plural(count, one, few, many) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

export function formatPagesCount(count) {
  return `${count} ${plural(count, "страница", "страницы", "страниц")}`;
}

function buildSummary({ confirmedDomain, inventory, publicationCount, topics, gaps, technical, lastPublishedAt }) {
  const okCount = inventory.filter((page) => page.ok).length;
  const strong = topics.filter((topic) => topic.coverage === "strong").length;
  const highGaps = gaps.filter((item) => item.severity === "high").length;
  const parts = [
    `Сайт ${confirmedDomain}: проверено ${formatPagesCount(okCount)}, из них публикаций — ${publicationCount}.`,
  ];
  if (publicationCount === 0) parts.push("Раздела статей или новостей не найдено.");
  else if (lastPublishedAt) parts.push(`Последняя публикация с датой: ${lastPublishedAt.slice(0, 10)}.`);
  parts.push(topics.length
    ? `Устойчивых тем: ${topics.length}, из них раскрыты глубоко: ${strong}.`
    : "Устойчивых тем между страницами не найдено.");
  parts.push(`Пробелов профиля: ${gaps.length}${highGaps ? `, критичных: ${highGaps}` : ""}.`);
  if (technical.seoScore !== null || technical.geoScore !== null) {
    parts.push(`Оценка on-page SEO: ${technical.seoScore ?? "—"}/100, готовность к генеративному поиску: ${technical.geoScore ?? "—"}/100.`);
  }
  return parts.join(" ");
}

/**
 * Детерминированный профиль сайта поверх результатов одного прогона анализа.
 * Не обращается к сети и к моделям: те же страницы всегда дают тот же профиль.
 */
export function buildSiteProfile({ confirmedDomain, pages, report = null, checkedAt = null, classification = null } = {}) {
  const domain = cleanText(confirmedDomain, 253).toLocaleLowerCase("ru-RU");
  if (!domain) throw new TypeError("site_profile_domain_required");
  const normalizedClassification = classification ? normalizeSiteClassification(classification) : null;
  const inventory = classifySitePages(pages, normalizedClassification);
  const pageTypeCounts = {};
  for (const page of inventory) {
    if (!page.ok) continue;
    pageTypeCounts[page.pageType] = (pageTypeCounts[page.pageType] || 0) + 1;
  }
  const publications = inventory.filter((page) => page.ok && page.pageType === "article");
  const lastPublishedAt = publications
    .map((page) => page.publishedAt)
    .filter(Boolean)
    .sort()
    .at(-1) || null;
  const topics = buildTopics(inventory, normalizedClassification?.topicClusters || null);
  const gaps = buildGaps(inventory, topics, pageTypeCounts);
  const technical = buildTechnical(report, inventory);
  const linkablePages = buildLinkablePages(inventory);
  const questions = buildQuestionCoverage(inventory, gaps);

  return Object.freeze({
    profileVersion: SITE_PROFILE_VERSION,
    confirmedDomain: domain,
    checkedAt: normalizeDate(checkedAt) || new Date().toISOString(),
    refined: Boolean(normalizedClassification && (Object.keys(normalizedClassification.pageTypes).length || normalizedClassification.topicClusters.length)),
    pageCount: inventory.length,
    publicationCount: publications.length,
    lastPublishedAt,
    pageTypeCounts: Object.freeze(pageTypeCounts),
    topics: Object.freeze(topics),
    gaps: Object.freeze(gaps),
    technical,
    questions,
    linkablePages: Object.freeze(linkablePages),
    summary: buildSummary({ confirmedDomain: domain, inventory, publicationCount: publications.length, topics, gaps, technical, lastPublishedAt }),
  });
}
