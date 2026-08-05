import { fetchPublicText, parsePublicHttpUrl } from "./safe-http.mjs";

export const SITE_ANALYSIS_POLICY_VERSION = "aurora-site-analysis-v1";
export const SITE_CRAWLER_USER_AGENT = "AuroraSiteAnalyzer";
export const DEFAULT_SITE_CRAWL_LIMITS = Object.freeze({
  maxPages: 20,
  maxPageBytes: 1_000_000,
  maxTotalBytes: 6_000_000,
  maxRedirects: 3,
  timeoutMs: 10_000,
  maxSitemaps: 5,
  maxSitemapUrls: 100,
});

export class SiteCrawlerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SiteCrawlerError";
    this.code = code;
  }
}

function boundedInteger(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
}

export function normalizeSiteLimits(value = {}) {
  return Object.freeze({
    maxPages: boundedInteger(value.maxPages, DEFAULT_SITE_CRAWL_LIMITS.maxPages, 1, 50),
    maxPageBytes: boundedInteger(
      value.maxPageBytes,
      DEFAULT_SITE_CRAWL_LIMITS.maxPageBytes,
      64_000,
      2_000_000,
    ),
    maxTotalBytes: boundedInteger(
      value.maxTotalBytes,
      DEFAULT_SITE_CRAWL_LIMITS.maxTotalBytes,
      64_000,
      20_000_000,
    ),
    maxRedirects: boundedInteger(value.maxRedirects, DEFAULT_SITE_CRAWL_LIMITS.maxRedirects, 0, 5),
    timeoutMs: boundedInteger(value.timeoutMs, DEFAULT_SITE_CRAWL_LIMITS.timeoutMs, 1_000, 20_000),
    maxSitemaps: boundedInteger(value.maxSitemaps, DEFAULT_SITE_CRAWL_LIMITS.maxSitemaps, 1, 20),
    maxSitemapUrls: boundedInteger(
      value.maxSitemapUrls,
      DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls,
      1,
      500,
    ),
  });
}

function normalizedDomain(value) {
  const raw = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!raw || /[\/@?#]/.test(raw)) throw new SiteCrawlerError("domain_mismatch", "Подтверди точный домен сайта");
  try {
    return new URL(`https://${raw}`).hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    throw new SiteCrawlerError("domain_mismatch", "Подтверди точный домен сайта");
  }
}

const SENSITIVE_QUERY_PARAM = /^(?:access[_-]?token|auth(?:orization)?|api[_-]?key|client[_-]?secret|code|cookie|credential|jwt|password|passwd|refresh[_-]?token|session(?:id)?|sid|signature|token)$/iu;
const TRACKING_QUERY_PARAM = /^(?:utm_.+|fbclid|gclid)$/iu;

function sanitizeStoredUrl(value, { dropCredentials = true } = {}) {
  const url = value instanceof URL ? new URL(value) : new URL(String(value));
  if (dropCredentials && (url.username || url.password)) return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAM.test(key) || TRACKING_QUERY_PARAM.test(key)) {
      url.searchParams.delete(key);
    }
  }
  return url;
}

function assertStandardPort(url) {
  if (!url.port) return;
  const standard = (url.protocol === "https:" && url.port === "443")
    || (url.protocol === "http:" && url.port === "80");
  if (!standard) throw new SiteCrawlerError("port_forbidden", "Для анализа разрешены только стандартные веб-порты");
}

export function normalizeSiteTarget(value, confirmedDomain, consent) {
  if (consent !== true) {
    throw new SiteCrawlerError("consent_required", "Подтверди право анализировать этот публичный сайт");
  }
  const url = parsePublicHttpUrl(value);
  assertStandardPort(url);
  const expected = normalizedDomain(confirmedDomain);
  const actual = url.hostname.toLowerCase().replace(/\.$/, "");
  if (actual !== expected) {
    throw new SiteCrawlerError("domain_mismatch", "Адрес сайта и подтверждённый домен не совпадают");
  }
  const sanitized = sanitizeStoredUrl(url, { dropCredentials: false });
  if (!sanitized) throw new SiteCrawlerError("bad_url", "Некорректный адрес сайта");
  if (!sanitized.pathname) sanitized.pathname = "/";
  return sanitized;
}

function normalizeRobotsOctets(value) {
  const percentNormalized = String(value || "").replace(/%([0-9a-f]{2})/giu, (encoded, hex) => {
    const byte = Number.parseInt(hex, 16);
    const character = String.fromCharCode(byte);
    return /^[A-Za-z0-9._~-]$/u.test(character) ? character : `%${hex.toUpperCase()}`;
  });
  let result = "";
  for (const character of percentNormalized) {
    result += character.codePointAt(0) > 0x7f
      ? encodeURIComponent(character).toUpperCase()
      : character;
  }
  return result;
}

/** RFC 9309 subset: product-token groups, Allow/Disallow longest match and Sitemap. */
export function parseRobotsTxt(text, userAgent = SITE_CRAWLER_USER_AGENT) {
  const groups = [];
  const sitemaps = [];
  let agents = [];
  let rules = [];
  let sawRule = false;

  const flush = () => {
    if (agents.length) groups.push({ agents, rules });
    agents = [];
    rules = [];
    sawRule = false;
  };

  for (const rawLine of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (field === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }
    if (field === "user-agent") {
      if (sawRule) flush();
      if (value) agents.push(value.toLowerCase());
      continue;
    }
    if ((field === "allow" || field === "disallow") && agents.length) {
      sawRule = true;
      if (value || field === "allow") rules.push({ type: field, pattern: normalizeRobotsOctets(value) });
    }
  }
  flush();

  const product = String(userAgent || "").toLowerCase();
  const matching = groups
    .map((group) => {
      const specificity = Math.max(
        ...group.agents.map((agent) => agent === "*" ? 0 : product.includes(agent) ? agent.length : -1),
      );
      return { ...group, specificity };
    })
    .filter((group) => group.specificity >= 0);
  const best = matching.length ? Math.max(...matching.map((group) => group.specificity)) : -1;
  return Object.freeze({
    userAgent: product,
    rules: matching.filter((group) => group.specificity === best).flatMap((group) => group.rules),
    sitemaps: [...new Set(sitemaps)],
  });
}

function robotRuleRegex(pattern) {
  const anchored = pattern.endsWith("$");
  const source = (anchored ? pattern.slice(0, -1) : pattern)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  return new RegExp(`^${source}${anchored ? "$" : ""}`);
}

export function robotsAllows(policy, value) {
  const url = value instanceof URL ? value : new URL(String(value));
  const path = normalizeRobotsOctets(`${url.pathname}${url.search}`);
  const matched = (policy?.rules || [])
    .filter((rule) => rule.pattern && robotRuleRegex(rule.pattern).test(path))
    .sort((left, right) => {
      const length = right.pattern.replace(/\*|\$$/g, "").length - left.pattern.replace(/\*|\$$/g, "").length;
      if (length) return length;
      return left.type === "allow" ? -1 : 1;
    });
  return matched[0]?.type !== "disallow";
}

const HTML_ENTITIES = Object.freeze({
  amp: "&",
  apos: "'",
  gt: ">",
  lt: "<",
  nbsp: " ",
  quot: '"',
});

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&([a-z]+);/gi, (entity, name) => HTML_ENTITIES[name.toLowerCase()] ?? entity);
}

function stripMarkup(value) {
  return decodeHtml(String(value || "")
    .replace(/<(?:script|style|svg|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|template|noscript)>/gi, " ")
    .replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function attributes(value) {
  const result = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of String(value || "").matchAll(pattern)) {
    result[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function firstTag(html, tag) {
  const match = String(html).match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return stripMarkup(match?.[1] || "");
}

function metaContent(html, matcher) {
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    if (matcher(attrs)) return String(attrs.content || "").trim();
  }
  return "";
}

function metaContents(html, matcher) {
  const values = [];
  for (const match of String(html).matchAll(/<meta\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    if (!matcher(attrs)) continue;
    const content = String(attrs.content || "").trim();
    if (content && !values.includes(content)) values.push(content);
  }
  return values;
}

function allTagText(html, tag) {
  return [...String(html).matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))]
    .map((match) => stripMarkup(match[1]))
    .filter(Boolean);
}

function canonicalUrl(html, baseUrl) {
  for (const match of String(html).matchAll(/<link\b([^>]*)>/gi)) {
    const attrs = attributes(match[1]);
    if (String(attrs.rel || "").toLowerCase().split(/\s+/).includes("canonical") && attrs.href) {
      try {
        return sanitizeStoredUrl(new URL(attrs.href, baseUrl))?.toString() || null;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function jsonLdSignals(html) {
  const types = new Set();
  const publicComments = [];
  const entities = [];
  const seenEntities = new Set();
  let publishedAt = null;
  let modifiedAt = null;
  const authors = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const rawTypes = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
    for (const type of rawTypes) if (typeof type === "string") types.add(type);
    const normalizedTypes = rawTypes.filter((type) => typeof type === "string").slice(0, 10);
    const name = stripMarkup(value.name || value.headline || "").slice(0, 300);
    if (name && normalizedTypes.some((type) => ["Organization", "Corporation", "LocalBusiness", "Person", "Product", "Service", "Event", "Article", "NewsArticle"].includes(type))) {
      const key = `${normalizedTypes.join(",")}\0${name.toLocaleLowerCase("ru-RU")}`;
      if (!seenEntities.has(key)) {
        seenEntities.add(key);
        entities.push({
          name,
          types: normalizedTypes,
          url: typeof value.url === "string" ? value.url : null,
          sameAs: (Array.isArray(value.sameAs) ? value.sameAs : [value.sameAs]).filter((item) => typeof item === "string").slice(0, 20),
          jobTitle: stripMarkup(value.jobTitle || "").slice(0, 240) || null,
        });
      }
    }
    const datePublished = String(value.datePublished || "").trim();
    const dateModified = String(value.dateModified || "").trim();
    if (!publishedAt && datePublished) publishedAt = datePublished.slice(0, 100);
    if (!modifiedAt && dateModified) modifiedAt = dateModified.slice(0, 100);
    for (const author of Array.isArray(value.author) ? value.author : [value.author]) {
      const authorName = stripMarkup(typeof author === "string" ? author : author?.name || "").slice(0, 240);
      if (authorName) authors.add(authorName);
    }
    if (rawTypes.some((type) => type === "Comment" || type === "Review")) {
      const body = stripMarkup(value.text || value.reviewBody || value.description || "");
      if (body) publicComments.push(body.slice(0, 500));
    }
    for (const nested of Object.values(value)) visit(nested);
  };
  for (const match of String(html).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = attributes(match[1]);
    if (String(attrs.type || "").toLowerCase() !== "application/ld+json") continue;
    try {
      visit(JSON.parse(match[2]));
    } catch {
      // Invalid structured data becomes an audit signal through an empty schema list.
    }
  }
  return {
    schemaTypes: [...types].slice(0, 50),
    publicComments,
    entities: entities.slice(0, 100),
    publishedAt,
    modifiedAt,
    authors: [...authors].slice(0, 30),
  };
}

function visibleHtml(html) {
  return String(html || "")
    .replace(/<(\w+)\b[^>]*(?:\bhidden\b|aria-hidden\s*=\s*["']?true|style\s*=\s*["'][^"']*display\s*:\s*none)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(?:script|style|svg|template|noscript)\b[^>]*>[\s\S]*?<\/(?:script|style|svg|template|noscript)>/gi, " ");
}

function mainMarkup(html) {
  const visible = visibleHtml(html);
  for (const tag of ["main", "article"]) {
    const match = visible.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (match) return match[1];
  }
  const roleMain = visible.match(/<([a-z0-9]+)\b[^>]*role\s*=\s*["']main["'][^>]*>([\s\S]*?)<\/\1>/i);
  if (roleMain) return roleMain[2];
  return visible.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] || visible;
}

function pageLinks(html, baseUrl) {
  const result = [];
  for (const match of String(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = attributes(match[1]);
    if (!attrs.href) continue;
    let url;
    try {
      url = new URL(attrs.href, baseUrl);
    } catch {
      continue;
    }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    url = sanitizeStoredUrl(url);
    if (!url) continue;
    const text = stripMarkup(match[2]).slice(0, 240);
    result.push({
      url: url.toString(),
      text,
      kind: url.origin === baseUrl.origin ? "internal" : "external",
    });
    if (result.length >= 500) break;
  }
  return result;
}

const CTA_PATTERN = /(?:купить|заказать|оставить|получить|связаться|записаться|начать|попробовать|скачать|подписаться|консультац|демо|buy|book|contact|request|get started|subscribe|download|try)/iu;

function pageCtas(html) {
  const result = [];
  for (const match of String(html).matchAll(/<(a|button)\b[^>]*>([\s\S]*?)<\/\1>|<input\b([^>]*)>/gi)) {
    const text = match[1]
      ? stripMarkup(match[2])
      : String(attributes(match[3]).value || "").trim();
    if (text && CTA_PATTERN.test(text)) result.push(text.slice(0, 240));
    if (result.length >= 50) break;
  }
  return [...new Set(result)];
}

function pageForms(html, baseUrl) {
  const result = [];
  for (const match of String(html).matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = attributes(match[1]);
    const inputs = [];
    for (const input of match[2].matchAll(/<(?:input|textarea|select)\b([^>]*)>/gi)) {
      const inputAttrs = attributes(input[1]);
      const name = inputAttrs.name || inputAttrs.type || inputAttrs.id;
      if (name) inputs.push(String(name).slice(0, 100));
    }
    let action = baseUrl.toString();
    try {
      if (attrs.action) action = sanitizeStoredUrl(new URL(attrs.action, baseUrl))?.toString() || baseUrl.toString();
    } catch {
      action = baseUrl.toString();
    }
    result.push({ action, method: String(attrs.method || "get").toUpperCase(), fields: [...new Set(inputs)].slice(0, 30) });
    if (result.length >= 25) break;
  }
  return result;
}

function markupComments(html) {
  const result = [];
  const pattern = /<(article|div|section|blockquote)\b([^>]*(?:class|id)\s*=\s*["'][^"']*(?:comment|review|testimonial|отзыв)[^"']*["'][^>]*)>([\s\S]*?)<\/\1>/giu;
  for (const match of visibleHtml(html).matchAll(pattern)) {
    const text = stripMarkup(match[3]);
    if (text.length >= 10) result.push(text.slice(0, 500));
    if (result.length >= 30) break;
  }
  return result;
}

function meaningfulWords(text) {
  const stop = new Set(["для", "как", "что", "это", "или", "при", "про", "the", "and", "with", "your", "you", "наш", "ваш", "его", "её", "они", "мы", "вы"]);
  const counts = new Map();
  for (const word of String(text || "").toLocaleLowerCase("ru-RU").match(/[a-zа-яё][a-zа-яё-]{3,}/giu) || []) {
    if (stop.has(word)) continue;
    counts.set(word, (counts.get(word) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 12);
}

export function extractSitePage(html, value, status = 200) {
  const parsedUrl = value instanceof URL ? value : new URL(String(value));
  const url = sanitizeStoredUrl(parsedUrl);
  if (!url) throw new SiteCrawlerError("credentials", "Адрес с логином или паролем запрещён");
  const source = String(html || "");
  const title = firstTag(source, "title");
  const description = metaContent(source, (attrs) => String(attrs.name || "").toLowerCase() === "description");
  const robots = metaContent(source, (attrs) => String(attrs.name || "").toLowerCase() === "robots").toLowerCase();
  const headings = [];
  for (let level = 1; level <= 6; level++) {
    for (const text of allTagText(source, `h${level}`)) headings.push({ level, text: text.slice(0, 400) });
  }
  const mainContent = stripMarkup(mainMarkup(source)).slice(0, 20_000);
  const links = pageLinks(source, url);
  const structured = jsonLdSignals(source);
  const comments = [...new Set([...structured.publicComments, ...markupComments(source)])].slice(0, 30);
  const language = attributes(source.match(/<html\b([^>]*)>/i)?.[1] || "").lang || null;
  const canonical = canonicalUrl(source, url);
  const viewport = Boolean(metaContent(source, (attrs) => String(attrs.name || "").toLowerCase() === "viewport"));
  const wordCount = mainContent ? mainContent.split(/\s+/).length : 0;
  const metaAuthors = metaContents(source, (attrs) => String(attrs.name || "").toLowerCase() === "author");
  const publishedAt = metaContent(source, (attrs) => ["article:published_time", "og:published_time"].includes(String(attrs.property || "").toLowerCase())) || structured.publishedAt;
  const modifiedAt = metaContent(source, (attrs) => ["article:modified_time", "og:updated_time"].includes(String(attrs.property || "").toLowerCase())) || structured.modifiedAt;
  const openGraph = {
    title: metaContent(source, (attrs) => String(attrs.property || "").toLowerCase() === "og:title").slice(0, 400) || null,
    description: metaContent(source, (attrs) => String(attrs.property || "").toLowerCase() === "og:description").slice(0, 800) || null,
    type: metaContent(source, (attrs) => String(attrs.property || "").toLowerCase() === "og:type").slice(0, 100) || null,
    image: (() => {
      const raw = metaContent(source, (attrs) => String(attrs.property || "").toLowerCase() === "og:image");
      if (!raw) return null;
      try {
        return sanitizeStoredUrl(new URL(raw, url))?.toString() || null;
      } catch {
        return null;
      }
    })(),
  };

  return Object.freeze({
    url: url.toString(),
    status,
    title,
    description,
    headings,
    mainContent,
    schemaTypes: structured.schemaTypes,
    links,
    ctas: pageCtas(source),
    forms: pageForms(source, url),
    publicComments: comments,
    metadata: Object.freeze({
      authors: [...new Set([...structured.authors, ...metaAuthors])].slice(0, 30),
      publishedAt: publishedAt || null,
      modifiedAt: modifiedAt || null,
      openGraph: Object.freeze(openGraph),
      structuredEntities: structured.entities,
    }),
    technical: Object.freeze({
      https: url.protocol === "https:",
      canonical,
      indexable: !/(?:^|\s|,)noindex(?:\s|,|$)/.test(robots),
      language,
      viewport,
      titleLength: title.length,
      descriptionLength: description.length,
      h1Count: headings.filter((heading) => heading.level === 1).length,
      wordCount,
    }),
  });
}

export function extractSitemapUrls(xml, baseUrl, maxUrls = DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls) {
  const base = baseUrl instanceof URL ? baseUrl : new URL(String(baseUrl));
  const result = [];
  for (const match of String(xml || "").matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    try {
      let url = new URL(decodeHtml(stripMarkup(match[1])), base);
      if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== base.hostname) continue;
      assertStandardPort(url);
      url = sanitizeStoredUrl(url);
      if (!url) continue;
      if (!result.includes(url.toString())) result.push(url.toString());
    } catch {
      continue;
    }
    if (result.length >= maxUrls) break;
  }
  return result;
}

export function extractSitemapDocument(xml, baseUrl, maxUrls = DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls) {
  return Object.freeze({
    kind: /<sitemapindex\b/iu.test(String(xml || "")) ? "index" : "urlset",
    urls: extractSitemapUrls(xml, baseUrl, maxUrls),
  });
}

const SITEMAP_BUCKETS = Object.freeze([
  ["about", /(?:^|\/)(?:about|company|o-nas|o-kompanii|ob-organizac)/iu],
  ["offer", /(?:^|\/)(?:product|products|service|services|practice|pricing|tarif|uslug|resheni)/iu],
  ["team", /(?:^|\/)(?:team|people|experts|authors|leadership|komand|ekspert|specialist)/iu],
  ["case", /(?:^|\/)(?:case|cases|portfolio|projects|kejs|istorii-uspeha)/iu],
  ["partner", /(?:^|\/)(?:partner|partners|clients|klient|partn)/iu],
  ["event", /(?:^|\/)(?:event|events|webinar|conference|meropriyati|sobyt)/iu],
  ["contact", /(?:^|\/)(?:contact|contacts|kontact|kontakty)/iu],
  ["document", /(?:^|\/)(?:document|documents|legal|licenses|policy|rekvizit|licenz)/iu],
  ["content", /(?:^|\/)(?:blog|news|article|articles|press|publication|novost|stati)/iu],
]);

/** Keeps a small crawl from being filled exclusively by chronological news URLs. */
export function stratifySitemapUrls(values, maxUrls = DEFAULT_SITE_CRAWL_LIMITS.maxSitemapUrls) {
  const buckets = new Map(SITEMAP_BUCKETS.map(([name]) => [name, []]));
  buckets.set("other", []);
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    let url;
    try {
      url = new URL(String(value));
    } catch {
      continue;
    }
    const key = url.toString();
    if (seen.has(key)) continue;
    seen.add(key);
    const bucket = SITEMAP_BUCKETS.find(([, pattern]) => pattern.test(url.pathname))?.[0] || "other";
    buckets.get(bucket).push(key);
  }
  const result = [];
  const order = [...SITEMAP_BUCKETS.map(([name]) => name), "other"];
  while (result.length < maxUrls && order.some((name) => buckets.get(name).length)) {
    for (const name of order) {
      const next = buckets.get(name).shift();
      if (next) result.push(next);
      if (result.length >= maxUrls) break;
    }
  }
  return result;
}

function evidence(url, label) {
  return [{ url, label }];
}

function finding(code, severity, title, description, url, confidence = "high") {
  return { code, severity, title, description, evidence: evidence(url, title), confidence };
}

export function buildSiteAnalysisReport(targetUrl, pages, limits = DEFAULT_SITE_CRAWL_LIMITS) {
  const target = targetUrl instanceof URL ? targetUrl : new URL(String(targetUrl));
  const goodPages = pages.filter((page) => page.status >= 200 && page.status < 400);
  const seo = [];
  const geo = [];
  for (const page of goodPages) {
    if (!page.title) seo.push(finding("missing_title", "high", "Нет заголовка страницы", "Добавь уникальный заголовок страницы.", page.url));
    if (!page.description) seo.push(finding("missing_description", "medium", "Нет описания страницы", "Добавь краткое описание содержания страницы.", page.url));
    if (page.technical.h1Count !== 1) seo.push(finding("h1_count", "medium", "Нарушена структура главного заголовка", `Найдено главных заголовков: ${page.technical.h1Count}.`, page.url));
    if (!page.technical.https) seo.push(finding("http_page", "high", "Страница открыта без защищённого соединения", "Включи защищённое соединение для страницы и внутренних ссылок.", page.url));
    if (!page.technical.viewport) seo.push(finding("missing_viewport", "medium", "Не настроено отображение на телефонах", "Проверь адаптивное отображение страницы.", page.url));
    if (!page.technical.canonical) seo.push(finding("missing_canonical", "low", "Не указан основной адрес страницы", "Укажи основной адрес, если у страницы есть дубли.", page.url, "medium"));
    if (!page.schemaTypes.length) geo.push(finding("missing_schema", "medium", "Нет структурированных данных", "Добавь подходящую структурированную разметку и проверяемые сущности.", page.url));
    if (page.technical.wordCount < 120) geo.push(finding("thin_content", "medium", "Мало объясняющего контента", "Добавь самостоятельное объяснение темы, определения и ответы на вопросы.", page.url, "medium"));
    if (!page.headings.some((heading) => heading.level === 2)) geo.push(finding("weak_answer_structure", "low", "Нет подзаголовков ответа", "Разбей материал на ясные вопросы и смысловые блоки.", page.url, "medium"));
  }

  const titles = new Map();
  for (const page of goodPages) {
    if (!page.title) continue;
    const key = page.title.toLocaleLowerCase("ru-RU");
    const same = titles.get(key) || [];
    same.push(page.url);
    titles.set(key, same);
  }
  for (const [title, urls] of titles) {
    if (urls.length > 1) {
      seo.push({
        code: "duplicate_title",
        severity: "medium",
        title: "Повторяется заголовок страницы",
        description: `Одинаковый заголовок найден на ${urls.length} страницах: ${title.slice(0, 120)}.`,
        evidence: urls.map((url) => ({ url, label: "Страница с повторяющимся заголовком" })),
        confidence: "high",
      });
    }
  }

  const combined = goodPages.map((page) => `${page.title} ${page.description} ${page.headings.map((h) => h.text).join(" ")} ${page.mainContent}`).join(" ");
  const themes = meaningfulWords(combined).map(([theme, occurrences]) => ({
    theme,
    occurrences,
    evidence: goodPages
      .filter((page) => `${page.title} ${page.description} ${page.headings.map((heading) => heading.text).join(" ")} ${page.mainContent}`.toLocaleLowerCase("ru-RU").includes(theme))
      .slice(0, 3)
      .map((page) => ({ url: page.url, label: `Упоминание «${theme}»` })),
    confidence: occurrences >= 3 ? "high" : "medium",
  }));
  const intents = [
    { id: "learn", label: "Изучить тему", pattern: /(?:как|что такое|guide|how|вопрос|ответ)/iu },
    { id: "compare", label: "Сравнить варианты", pattern: /(?:сравн|versus|\bvs\b|выбрать|лучше)/iu },
    { id: "convert", label: "Связаться или купить", pattern: CTA_PATTERN },
  ].map((intent) => {
    const matches = goodPages.filter((page) => intent.pattern.test(`${page.title} ${page.headings.map((h) => h.text).join(" ")} ${page.ctas.join(" ")}`));
    return {
      id: intent.id,
      label: intent.label,
      pages: matches.length,
      evidence: matches.slice(0, 3).map((page) => ({ url: page.url, label: intent.label })),
      confidence: matches.length ? "medium" : "low",
    };
  });

  const internalLinks = goodPages.flatMap((page) => page.links.filter((link) => link.kind === "internal"));
  const inbound = new Map();
  for (const link of internalLinks) inbound.set(link.url, (inbound.get(link.url) || 0) + 1);
  const orphanCandidates = goodPages.filter((page) => page.url !== target.toString() && !inbound.get(page.url));
  const source = goodPages[0]?.url || target.toString();
  const primaryTheme = themes[0]?.theme || target.hostname;
  const contentGaps = [
    {
      title: `Полный ответ по теме «${primaryTheme}»`,
      rationale: "Собрать определение, критерии выбора, процесс и проверяемые источники на одной странице.",
      sources: evidence(source, "Текущий основной контент"),
      confidence: themes.length ? "medium" : "low",
    },
    {
      title: "Ответы на частые вопросы и возражения",
      rationale: "Закрыть информационные вопросы и сделать ответы пригодными для обычного поиска и поиска с ИИ.",
      sources: evidence(source, "Структура текущей страницы"),
      confidence: "medium",
    },
  ];
  const seoTasks = seo.slice(0, 12).map((item, index) => ({
    title: item.title,
    priority: item.severity === "high" ? "P0" : item.severity === "medium" ? "P1" : "P2",
    dueDays: 7 + index * 2,
    sources: item.evidence,
    confidence: item.confidence,
  }));
  const geoTasks = geo.slice(0, 12).map((item, index) => ({
    title: item.title,
    priority: item.severity === "high" ? "P0" : "P1",
    dueDays: 10 + index * 2,
    sources: item.evidence,
    confidence: item.confidence,
  }));

  return Object.freeze({
    policyVersion: SITE_ANALYSIS_POLICY_VERSION,
    target: target.toString(),
    crawledAt: new Date().toISOString(),
    limits,
    inventory: pages.map((page) => ({
      url: page.url,
      status: page.status,
      title: page.title,
      description: page.description,
      format: "html",
      words: page.technical.wordCount,
      schemaTypes: page.schemaTypes,
      ctaCount: page.ctas.length,
      formCount: page.forms.length,
      publicCommentCount: page.publicComments.length,
    })),
    seoAudit: seo,
    geoAudit: geo,
    themes,
    intents,
    internalLinking: {
      totalLinks: internalLinks.length,
      orphanCandidates: orphanCandidates.map((page) => ({
        url: page.url,
        evidence: evidence(page.url, "Нет входящей ссылки в пределах проверенного среза"),
        confidence: "medium",
      })),
    },
    marketingPlan: {
      goals: [
        { title: "Повысить полноту и проверяемость контента", kpi: "Доля индексируемых страниц без критичных поисковых ошибок", target: "Базовая линия + динамика после внедрения", sources: evidence(source, "Текущий срез анализа"), confidence: "medium" },
      ],
      icp: { description: `Аудитория, которая ищет материалы по теме «${primaryTheme}»`, sources: evidence(source, "Темы основного контента"), confidence: "low" },
      funnel: [
        { stage: "Узнавание", action: "Публиковать доказательные обзоры и ответы на вопросы", sources: contentGaps[0].sources, confidence: "medium" },
        { stage: "Рассмотрение", action: "Добавить сравнения, примеры и критерии выбора", sources: evidence(source, "Текущие намерения посетителей и призывы"), confidence: "low" },
        { stage: "Действие", action: "Связать призыв с измеримым событием без обещаний результата", sources: evidence(source, "Открытые призывы и формы"), confidence: "medium" },
      ],
      positioning: { statement: `Практичный и проверяемый источник по теме «${primaryTheme}»`, sources: evidence(source, "Повторяющиеся темы сайта"), confidence: "low" },
      contentGaps,
      seoTasks,
      geoTasks,
      promotionChannels: [
        { channel: "Органический поиск", reason: "Есть собственные индексируемые страницы и технический список задач.", sources: evidence(source, "Перечень контента"), confidence: "medium" },
        { channel: "Экспертные соцсети", reason: "Материалы можно раскладывать на короткие ответы и вести к первоисточнику.", sources: evidence(source, "Темы и заголовки сайта"), confidence: "low" },
      ],
      publicationBacklog: contentGaps.map((gap, index) => ({ ...gap, priority: index === 0 ? "P1" : "P2", dueDays: 14 + index * 7 })),
      measurement: [
        { kpi: "Показы, клики и позиции", sourceNeeded: "Google Search Console / Яндекс Вебмастер", confidence: "requires_integration" },
        { kpi: "Сессии и конверсии", sourceNeeded: "GA4 / Яндекс.Метрика", confidence: "requires_integration" },
        { kpi: "Лиды и выручка", sourceNeeded: "CRM", confidence: "requires_integration" },
      ],
    },
    limitations: [
      "Анализ открытых страниц не показывает посещаемость, позиции, конверсии или выручку.",
      "Комментарии учитываются только тогда, когда они публично присутствуют в коде страницы или структурированных данных.",
      "Динамический контент, закрытые кабинеты и данные за авторизацией не открываются.",
      "Текущая версия читает страницы в современной кодировке; сайты в старых кодировках могут потребовать повторного анализа.",
      "Выводы о целевой аудитории и позиционировании являются гипотезами до проверки аналитикой и интервью.",
    ],
  });
}

function normalizedCrawlUrl(value, origin) {
  try {
    let url = value instanceof URL ? new URL(value) : new URL(String(value), origin);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== origin.hostname) return null;
    assertStandardPort(url);
    if (origin.protocol === "https:" && url.protocol !== "https:") return null;
    url = sanitizeStoredUrl(url);
    if (!url) return null;
    return url;
  } catch {
    return null;
  }
}

function sameSiteRedirect(next, current, hostname) {
  if (next.hostname !== hostname) return false;
  try {
    assertStandardPort(next);
  } catch {
    return false;
  }
  return !(current.protocol === "https:" && next.protocol !== "https:");
}

async function fetchCrawlerResource(fetchText, url, limits, maxBytes, robotsPolicy = null) {
  return fetchText(url.toString(), {
    timeoutMs: limits.timeoutMs,
    maxBytes,
    maxRedirects: limits.maxRedirects,
    headers: {
      accept: "text/html,application/xhtml+xml,application/xml,text/plain;q=0.8",
      "user-agent": `${SITE_CRAWLER_USER_AGENT}/1.0`,
    },
    validateRedirect: (next, current) => {
      if (!sameSiteRedirect(next, current, url.hostname)) return false;
      if (robotsPolicy && !robotsAllows(robotsPolicy, next)) {
        throw new SiteCrawlerError("robots_denied", "Правила сайта запрещают перенаправление на эту страницу");
      }
      return true;
    },
  });
}

export async function crawlSite(input, dependencies = {}) {
  const target = normalizeSiteTarget(input.targetUrl, input.confirmedDomain, input.consent);
  const limits = normalizeSiteLimits(input.limits);
  const fetchText = dependencies.fetchText || fetchPublicText;
  const onProgress = dependencies.onProgress || (() => undefined);
  const emit = async (stage, progress, detail) => onProgress({ stage, progress, detail });
  let totalBytes = 0;
  const remainingBytes = () => {
    const remaining = limits.maxTotalBytes - totalBytes;
    if (remaining <= 0) {
      throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
    }
    return remaining;
  };
  const boundedResourceBytes = (perResourceLimit) => Math.min(perResourceLimit, remainingBytes());
  const consumeResponse = async (response, readText) => {
    const text = readText ? await response.text() : "";
    const reported = Number(response.byteLength);
    const bytes = Number.isFinite(reported) && reported >= 0
      ? reported
      : Buffer.byteLength(text, "utf8");
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
    }
    return text;
  };
  const consumeFailure = (error) => {
    const bytes = Number(error?.byteLength);
    if (!Number.isFinite(bytes) || bytes <= 0) return;
    totalBytes += bytes;
    if (totalBytes > limits.maxTotalBytes) {
      throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
    }
  };

  await emit("robots", 5, "Проверяем правила доступа сайта");
  const robotsUrl = new URL("/robots.txt", target);
  let robots = parseRobotsTxt("");
  let robotsResponse;
  try {
    robotsResponse = await fetchCrawlerResource(
      fetchText,
      robotsUrl,
      limits,
      boundedResourceBytes(Math.min(limits.maxPageBytes, 512_000)),
    );
    const robotsText = await consumeResponse(robotsResponse, robotsResponse.ok);
    if (robotsResponse.status === 429 || robotsResponse.status >= 500) {
      throw new SiteCrawlerError("robots_unavailable", "robots.txt временно недоступен — анализ остановлен безопасно");
    }
    if (robotsResponse.status === 401 || robotsResponse.status === 403) {
      throw new SiteCrawlerError("robots_denied", "Сайт запретил автоматический доступ");
    }
    if (robotsResponse.ok) robots = parseRobotsTxt(robotsText);
  } catch (error) {
    consumeFailure(error);
    if (error instanceof SiteCrawlerError) throw error;
    if (error?.code === "too_large") {
      throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
    }
    const code = error?.code || "robots_unavailable";
    throw new SiteCrawlerError(code, "Не удалось безопасно проверить robots.txt");
  }
  if (!robotsAllows(robots, target)) {
    throw new SiteCrawlerError("robots_denied", "robots.txt запрещает анализ указанной страницы");
  }

  await emit("sitemap", 12, "Читаем карту сайта");
  const defaultSitemap = new URL("/sitemap.xml", target).toString();
  const sitemapPending = [...new Set([
    ...robots.sitemaps.slice(0, Math.max(0, limits.maxSitemaps - 1)),
    defaultSitemap,
  ])].slice(0, limits.maxSitemaps);
  const seenSitemaps = new Set();
  const sitemapUrls = [];
  const seenSitemapPages = new Set();
  while (
    sitemapPending.length
    && seenSitemaps.size < limits.maxSitemaps
    && sitemapUrls.length < limits.maxSitemapUrls
  ) {
    const candidate = sitemapPending.shift();
    const sitemapUrl = normalizedCrawlUrl(candidate, target);
    if (!sitemapUrl || !robotsAllows(robots, sitemapUrl)) continue;
    const sitemapKey = sitemapUrl.toString();
    if (seenSitemaps.has(sitemapKey)) continue;
    seenSitemaps.add(sitemapKey);
    try {
      const response = await fetchCrawlerResource(
        fetchText,
        sitemapUrl,
        limits,
        boundedResourceBytes(limits.maxPageBytes),
        robots,
      );
      const sitemapText = await consumeResponse(response, response.ok);
      if (!response.ok) continue;
      const document = extractSitemapDocument(
        sitemapText,
        target,
        limits.maxSitemapUrls - sitemapUrls.length,
      );
      if (document.kind === "index") {
        const children = document.urls
          .filter((child) => !seenSitemaps.has(child) && !sitemapPending.includes(child))
          .slice(0, Math.max(0, limits.maxSitemaps - seenSitemaps.size));
        // Child sitemap files are more informative than another root candidate and stay
        // inside the same total fetch bound enforced by seenSitemaps.
        sitemapPending.unshift(...children);
      } else {
        for (const pageUrl of document.urls) {
          if (seenSitemapPages.has(pageUrl)) continue;
          seenSitemapPages.add(pageUrl);
          sitemapUrls.push(pageUrl);
          if (sitemapUrls.length >= limits.maxSitemapUrls) break;
        }
      }
    } catch (error) {
      consumeFailure(error);
      if (error instanceof SiteCrawlerError && error.code === "crawl_too_large") throw error;
      if (error?.code === "too_large") {
        throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
      }
      // Sitemap is an optimization; the confirmed start page remains crawlable.
    }
  }

  const pending = [];
  const queued = new Set();
  const enqueue = (value) => {
    const url = normalizedCrawlUrl(value, target);
    if (!url || !robotsAllows(robots, url)) return;
    const key = url.toString();
    if (queued.has(key)) return;
    queued.add(key);
    pending.push(url);
  };
  enqueue(target);
  stratifySitemapUrls(sitemapUrls, limits.maxSitemapUrls).forEach(enqueue);

  const pages = [];
  const finalUrls = new Set();
  while (pending.length && pages.length < limits.maxPages) {
    const url = pending.shift();
    await emit(
      "crawling",
      15 + Math.round((pages.length / limits.maxPages) * 55),
      `Страница ${pages.length + 1} из ${limits.maxPages}`,
    );
    let response;
    try {
      response = await fetchCrawlerResource(
        fetchText,
        url,
        limits,
        boundedResourceBytes(limits.maxPageBytes),
        robots,
      );
    } catch (error) {
      consumeFailure(error);
      if (error?.code === "too_large") {
        throw new SiteCrawlerError("crawl_too_large", "Сайт превысил безопасный лимит размера анализа");
      }
      if (error instanceof SiteCrawlerError && error.code === "robots_denied") {
        if (url.toString() === target.toString()) throw error;
        continue;
      }
      pages.push({
        ...extractSitePage("", url, 0),
        fetchError: "unavailable",
      });
      continue;
    }
    const finalUrl = normalizedCrawlUrl(response.url || url, target);
    if (!finalUrl) throw new SiteCrawlerError("redirect_forbidden", "Страница перенаправила анализ на другой домен");
    if (!robotsAllows(robots, finalUrl)) {
      if (url.toString() === target.toString()) {
        throw new SiteCrawlerError("robots_denied", "Правила сайта запрещают перенаправление на эту страницу");
      }
      continue;
    }
    const finalKey = finalUrl.toString();
    if (finalUrls.has(finalKey)) {
      await consumeResponse(response, false);
      continue;
    }
    finalUrls.add(finalKey);
    const contentType = String(response.headers?.["content-type"] || response.headers?.get?.("content-type") || "").toLowerCase();
    const supportedHtml = !contentType || contentType.includes("html") || contentType.includes("xhtml");
    const html = await consumeResponse(response, response.ok && supportedHtml);
    if (!response.ok || (contentType && !contentType.includes("html") && !contentType.includes("xhtml"))) {
      pages.push({ ...extractSitePage("", finalUrl, response.status), fetchError: response.ok ? "unsupported_content" : "http_error" });
      continue;
    }
    const page = extractSitePage(html, finalUrl, response.status);
    pages.push(page);
    page.links.filter((link) => link.kind === "internal").forEach((link) => enqueue(link.url));
  }

  if (!pages.some((page) => page.status >= 200 && page.status < 400)) {
    throw new SiteCrawlerError("no_pages", "Не удалось получить ни одной открытой страницы сайта");
  }
  await emit("analyzing", 78, "Собираем поисковый аудит и доказательства");
  const report = buildSiteAnalysisReport(target, pages, limits);
  await emit("planning", 92, "Формируем маркетинговый план");
  await emit("ready", 100, "Анализ готов");
  return { report, pages, totalBytes, robots: { sitemaps: [...seenSitemaps] } };
}
