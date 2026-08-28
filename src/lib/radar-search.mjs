// Чистое ядро гибридного поиска «Конкуренты и тренды».
// Здесь нет PostgreSQL, Redis и глобального fetch: модуль можно тестировать отдельно,
// а внешний источник можно заменить, не меняя API, воркер и интерфейс.

export const RADAR_SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;
export const RADAR_DISCOVERY_BUDGET = Object.freeze({
  maxPages: 24,
  maxCandidates: 250,
  maxQueries: 8,
  maxResponseBytes: 2 * 1024 * 1024,
  deadlineMs: 15_000,
});
export const RADAR_WEB_DISCOVERY_BUDGET = Object.freeze({
  maxPages: 18,
  maxCandidates: 200,
  maxQueries: 5,
  maxResponseBytes: 2 * 1024 * 1024,
  deadlineMs: 12_000,
});

const TELEGRAM_HANDLE = /^[a-z][a-z0-9_]{3,31}$/u;
const TELEGRAM_STOP_HANDLES = new Set([
  "addemoji",
  "addstickers",
  "c",
  "contact",
  "iv",
  "joinchat",
  "login",
  "proxy",
  "s",
  "setlanguage",
  "share",
  "socks",
  "telegram",
]);
const QUERY_STOP_WORDS = new Set([
  "без",
  "где",
  "дай",
  "для",
  "или",
  "информация",
  "информации",
  "информацию",
  "ищи",
  "ищу",
  "как",
  "канал",
  "каналы",
  "мне",
  "найди",
  "найти",
  "обсуждают",
  "покажи",
  "пишет",
  "пишут",
  "пост",
  "посты",
  "про",
  "расскажи",
  "рассказывают",
  "тема",
  "теме",
  "темы",
  "телеграм",
  "telegram",
  "что",
  "это",
]);
const SPAM_WORDS = [
  "casino",
  "казино",
  "ставки на спорт",
  "букмекер",
  "быстрый заработок",
  "гарантированный доход",
  "18+",
];
const WEB_SEARCH_HOSTS = new Set([
  "bing.com",
  "brave.com",
  "cdn.search.brave.com",
  "duckduckgo.com",
  "google.com",
  "html.duckduckgo.com",
  "imgs.search.brave.com",
  "search.brave.com",
  "search.yahoo.com",
  "r.search.yahoo.com",
  "www.bing.com",
  "www.google.com",
]);
const SENSITIVE_QUERY_PARAM = /^(?:access[_-]?token|api[_-]?key|auth(?:orization)?|code|cookie|credential|jwt|password|refresh[_-]?token|session(?:id)?|sid|signature|token|utm_.+|fbclid|gclid)$/iu;
const IDENTITY_PROMPT = /(?:^|\s)(?:биография|био|кто\s+(?:такой|такая)|найди\s+(?:про|человека)|официальн(?:ый|ая|ое)|профиль|аккаунт)(?:\s|$)/iu;
const HANDLE_QUERY = /^@?[a-z][a-z0-9_.-]{2,63}$/iu;
const PERSON_NAME_QUERY = /^\p{Lu}[\p{L}'’-]{1,}(?:\s+\p{Lu}[\p{L}'’-]{1,}){1,3}$/u;
const SOCIAL_HOSTS = /(?:^|\.)(?:dzen\.ru|facebook\.com|instagram\.com|linkedin\.com|ok\.ru|rutube\.ru|tiktok\.com|vk\.com|x\.com|youtube\.com)$/iu;

export class RadarDiscoveryError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "RadarDiscoveryError";
    this.code = code;
  }
}

export function normalizeRadarQuery(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}_@+.-]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 200);
}

export function radarIdentityHandle(value) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const parts = url.pathname.split("/").filter(Boolean);
    const candidate = parts.find((part) => HANDLE_QUERY.test(part));
    if (candidate) return candidate.replace(/^@/u, "").toLowerCase();
  } catch {
    // Ниже проверим обычный username без URL.
  }
  return HANDLE_QUERY.test(raw) ? raw.replace(/^@/u, "").toLowerCase() : null;
}

export function detectRadarQueryIntent(value) {
  const raw = String(value ?? "").normalize("NFKC").trim();
  if (!raw) return "topic";
  try {
    const url = new URL(raw);
    if (url.protocol === "http:" || url.protocol === "https:") return "identity";
  } catch {
    // Не URL — применяем текстовые сигналы.
  }
  return radarIdentityHandle(raw) || IDENTITY_PROMPT.test(raw) || PERSON_NAME_QUERY.test(raw)
    ? "identity"
    : "topic";
}

export function sanitizeRadarPublicText(value, maxLength = 12_000) {
  const limit = Number.isSafeInteger(Number(maxLength))
    ? Math.max(0, Math.min(24_000, Number(maxLength)))
    : 12_000;
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, "[email скрыт]")
    .replace(/(?<!\d)(?:\+?\d[\s().-]*){10,15}(?!\d)/gu, "[телефон скрыт]")
    .replace(/[ \t]+/gu, " ")
    .replace(/\n{3,}/gu, "\n\n")
    .trim()
    .slice(0, limit);
}

function tokenStem(value) {
  const token = String(value).replace(/^@/u, "");
  if (token.length < 6) return token;
  // Не пытаемся быть морфологическим словарём. Короткий общий префикс нужен только для
  // мягкого совпадения «рыбалка/рыбалке» и «садоводство/садоводстве» после web-discovery.
  return token.replace(
    /(иями|ями|ами|ого|ему|ому|ыми|ими|иях|ах|ях|ия|ие|ий|ый|ая|ое|ые|ов|ев|ам|ям|ом|ем|у|ю|а|я|ы|и|е|о)$/u,
    "",
  );
}

export function radarQueryTokens(value) {
  const normalized = normalizeRadarQuery(value);
  const tokens = normalized
    .split(/\s+/u)
    .map((token) => token.replace(/^@/u, ""))
    .filter((token) => token.length >= 3 && !QUERY_STOP_WORDS.has(token))
    .map(tokenStem)
    .filter((token) => token.length >= 3);
  return [...new Set(tokens)].slice(0, 12);
}

export function competitorDiscoveryQuery(input = {}) {
  for (const value of [input.niche, input.audience, input.channelTitle]) {
    const query = normalizeRadarQuery(value);
    if (query.length >= 2) return query;
  }
  return "";
}

/**
 * Полнотекстовая ветка ищет слова через ИЛИ, а точность затем проверяет кодовое
 * ранжирование. Это важно для живых вопросов: PostgreSQL `plainto_tsquery` связывает
 * все слова через И и теряет канал, если в одном посте есть «строительство», а в другом
 * «загородные дома».
 */
export function radarTsQuery(value) {
  const normalized = normalizeRadarQuery(value);
  const tokens = normalized
    .split(/\s+/u)
    .map((token) => token.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token));
  return [...new Set(tokens)].slice(0, 12).join(" | ");
}

function radarDiscoveryPhrase(value) {
  return normalizeRadarQuery(value)
    .split(/\s+/u)
    .map((token) => token.replace(/[^\p{L}\p{N}_@+.-]/gu, ""))
    .filter((token) => token.length >= 2 && !QUERY_STOP_WORDS.has(token))
    .slice(0, 12)
    .join(" ");
}

/**
 * Keep the user's wording for intent, then add a compact content query and bounded
 * semantic formulations. This lets natural requests work even when AI expansion is
 * unavailable: «найди мне каналы про строительство» also searches «строительство».
 */
export function buildRadarDiscoveryQueries(query, expanded = []) {
  const source = [query, ...(Array.isArray(expanded) ? expanded : [])];
  const values = source.flatMap((value) => {
    const normalized = normalizeRadarQuery(value);
    const compact = radarDiscoveryPhrase(value);
    return compact && compact !== normalized ? [normalized, compact] : [normalized];
  }).filter((value) => value.length >= 2);
  return [...new Set(values)];
}

export function buildRadarWebDiscoveryQueries(query, expanded = []) {
  const raw = String(query ?? "").normalize("NFKC").trim();
  const normalized = normalizeRadarQuery(raw);
  const handle = radarIdentityHandle(raw);
  const intent = detectRadarQueryIntent(raw);
  const values = [];
  if (raw && /^https?:\/\//iu.test(raw)) values.push(raw);
  if (normalized) values.push(normalized);
  if (handle) {
    values.push(`"${handle}"`, `"@${handle}"`, `"${handle}" биография`, `"${handle}" официальный`);
  } else if (intent === "identity") {
    values.push(`"${normalized}" биография`, `"${normalized}" официальный профиль`);
  } else {
    const compact = radarDiscoveryPhrase(normalized);
    if (compact && compact !== normalized) values.push(compact);
    const topic = compact || normalized;
    if (topic) values.push(`${topic} новости`, `${topic} тренды`);
    values.push(...(Array.isArray(expanded) ? expanded : []));
  }
  return [...new Set(values.map((value) => String(value || "").trim()).filter((value) => value.length >= 2))];
}

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&#x([0-9a-f]+);/giu, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&#(\d+);/gu, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&nbsp;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&(?:mdash|#8212);/giu, "—")
    .replace(/&(?:ndash|#8211);/giu, "–")
    .replace(/&(?:bull|#8226);/giu, "•")
    .replace(/&(?:copy|#169);/giu, "©")
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function decodeJavascriptString(value) {
  const source = String(value ?? "");
  try {
    return JSON.parse(`"${source}"`);
  } catch {
    return source
      .replace(/\\u([0-9a-f]{4})/giu, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
      .replace(/\\(["\\/])/gu, "$1");
  }
}

export function parseBraveSearchCorrection(payload) {
  const match = String(payload || "").match(/\baltered:"((?:\\.|[^"\\])*)"/u);
  return match ? sanitizeRadarPublicText(decodeJavascriptString(match[1]), 200) || null : null;
}

function stripMarkup(value) {
  return sanitizeRadarPublicText(
    decodeHtml(String(value ?? "").replace(/<[^>]+>/gu, " ")).replace(/\s+/gu, " "),
    4_000,
  );
}

function unwrapWebSearchRedirect(raw) {
  let value = decodeHtml(raw).trim();
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    if (/(?:^|\.)r\.search\.yahoo\.com$/iu.test(url.hostname)) {
      const yahooTarget = url.pathname.match(/\/RU=([^/]+)\/(?:RK|RS)=/iu)?.[1];
      if (yahooTarget) {
        try {
          const decoded = decodeURIComponent(yahooTarget);
          if (/^https?:\/\//iu.test(decoded)) return decoded;
        } catch {
          // Повреждённый redirect будет отклонён общей нормализацией ниже.
        }
      }
    }
    const redirected = url.searchParams.get("uddg") || url.searchParams.get("url") || url.searchParams.get("u");
    if (redirected && /^https?:\/\//iu.test(redirected)) return redirected;
  } catch {
    return value;
  }
  return value;
}

function obviousPrivateHostname(hostname) {
  const host = String(hostname || "").toLowerCase().replace(/^\[|\]$/gu, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (/^(?:0|10|127)\./u.test(host) || /^169\.254\./u.test(host) || /^192\.168\./u.test(host)) return true;
  const private172 = host.match(/^172\.(\d+)\./u);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}

export function normalizeRadarWebCandidate(rawUrl, metadata = {}) {
  const unwrapped = unwrapWebSearchRedirect(rawUrl);
  let url;
  try {
    url = new URL(unwrapped);
  } catch {
    return null;
  }
  if (!/^https?:$/u.test(url.protocol) || url.username || url.password || obviousPrivateHostname(url.hostname)) return null;
  const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (WEB_SEARCH_HOSTS.has(url.hostname.toLowerCase()) || WEB_SEARCH_HOSTS.has(hostname)) return null;
  if (hostname === "t.me" || hostname === "telegram.me") return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (SENSITIVE_QUERY_PARAM.test(key)) url.searchParams.delete(key);
  }
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/u, "") || "/";
  const canonicalUrl = url.toString();
  return {
    canonicalUrl,
    canonicalKey: `web:${canonicalUrl}`,
    domain: hostname,
    title: sanitizeRadarPublicText(metadata.title, 500) || null,
    snippet: sanitizeRadarPublicText(metadata.snippet, 2_000) || null,
    publishedAt: metadata.publishedAt || null,
    provider: String(metadata.provider || "web").slice(0, 80),
  };
}

function xmlRawTag(payload, tag) {
  const match = String(payload || "").match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "iu"));
  return decodeHtml(String(match?.[1] || "").replace(/^<!\[CDATA\[|\]\]>$/gu, "")).trim();
}

function xmlTag(payload, tag) {
  return stripMarkup(xmlRawTag(payload, tag));
}

export function parseBingRssWebCandidates(payload, provider = "bing-rss-web") {
  const candidates = [];
  for (const match of String(payload || "").matchAll(/<item\b[\s\S]*?<\/item>/giu)) {
    const item = match[0];
    const candidate = normalizeRadarWebCandidate(xmlRawTag(item, "link"), {
      title: xmlTag(item, "title"),
      snippet: xmlTag(item, "description"),
      publishedAt: xmlTag(item, "pubDate") || null,
      provider,
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

export function parseBraveWebCandidates(payload, provider = "brave-html-web") {
  const source = String(payload || "");
  const correctedQuery = parseBraveSearchCorrection(source);
  const candidates = new Map();

  // Brave renders ordinary links, but also includes a compact serialized copy of the
  // result list. The latter is more stable than generated CSS class names and contains
  // the same public title, snippet and publication date shown in the browser.
  const resultPattern = /full_title:"((?:\\.|[^"\\])*)",url:"((?:\\.|[^"\\])*)"([\s\S]{0,5000}?)(?=full_title:|$)/gu;
  for (const match of source.matchAll(resultPattern)) {
    const tail = match[3] || "";
    const description = tail.match(/\bdescription:"((?:\\.|[^"\\])*)"/u)?.[1];
    const publishedAt = tail.match(/\bpage_age:"((?:\\.|[^"\\])*)"/u)?.[1];
    const candidate = normalizeRadarWebCandidate(decodeJavascriptString(match[2]), {
      title: stripMarkup(decodeJavascriptString(match[1])),
      snippet: stripMarkup(decodeJavascriptString(description || "")),
      publishedAt: publishedAt ? decodeJavascriptString(publishedAt) : null,
      provider,
    });
    if (!candidate) continue;
    candidates.set(candidate.canonicalUrl, { ...candidate, correctedQuery });
  }

  // Keep a DOM fallback for intentionally simplified HTML and for provider markup
  // changes. Search assets are rejected by normalizeRadarWebCandidate above.
  if (candidates.size === 0) {
    for (const match of source.matchAll(/<a\b([^>]*)href\s*=\s*["'](https?:\/\/[^"']+)["']([^>]*)>([\s\S]{0,1800}?)<\/a>/giu)) {
      const attrs = `${match[1]} ${match[3]}`;
      if (!/(?:\bresult\b|\bl1\b|data-testid\s*=\s*["']result)/iu.test(attrs)) continue;
      const title = stripMarkup(match[4]);
      const tail = source.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 1_800);
      const snippet = tail.match(/class\s*=\s*["'][^"']*(?:snippet|description)[^"']*["'][^>]*>([\s\S]*?)<\/(?:div|p|span)>/iu)?.[1];
      const candidate = normalizeRadarWebCandidate(decodeHtml(match[2]), {
        title,
        snippet: stripMarkup(snippet || ""),
        provider,
      });
      if (!candidate) continue;
      candidates.set(candidate.canonicalUrl, { ...candidate, correctedQuery });
    }
  }
  return [...candidates.values()];
}

export function parseYahooSearchCorrection(payload) {
  const source = decodeHtml(payload);
  const match = source.match(/[?&]p=([^&"']+)&fr2=12642/iu);
  if (!match) return null;
  try {
    return sanitizeRadarPublicText(decodeURIComponent(match[1].replace(/\+/gu, " ")), 200) || null;
  } catch {
    return sanitizeRadarPublicText(match[1], 200) || null;
  }
}

export function parseYahooWebCandidates(payload, provider = "yahoo-html-web") {
  const source = String(payload || "");
  const correctedQuery = parseYahooSearchCorrection(source);
  const candidates = new Map();
  for (const match of source.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/giu)) {
    const item = match[1];
    if (!/class\s*=\s*["'][^"']*\balgo\b/iu.test(item)) continue;
    const rawUrl = item.match(/href\s*=\s*["']([^"']+)["']/iu)?.[1];
    const title = item.match(/<h3\b[^>]*>([\s\S]*?)<\/h3>/iu)?.[1];
    if (!rawUrl || !title) continue;
    const snippet = item.match(/class\s*=\s*["'][^"']*\bcompText\b[^"']*["'][\s\S]*?<p\b[^>]*>([\s\S]*?)<\/p>/iu)?.[1];
    const candidate = normalizeRadarWebCandidate(decodeHtml(rawUrl), {
      title: stripMarkup(title),
      snippet: stripMarkup(snippet || ""),
      provider,
    });
    if (!candidate) continue;
    candidates.set(candidate.canonicalUrl, { ...candidate, correctedQuery });
  }
  return [...candidates.values()];
}

export function parseDuckDuckGoWebCandidates(payload, provider = "duckduckgo-html-web") {
  const source = String(payload || "");
  const candidates = [];
  for (const match of source.matchAll(/<a\b([^>]*)class\s*=\s*["'][^"']*result__a[^"']*["']([^>]*)>([\s\S]*?)<\/a>/giu)) {
    const attrs = `${match[1]} ${match[2]}`;
    const href = attrs.match(/href\s*=\s*["']([^"']+)["']/iu)?.[1];
    if (!href) continue;
    const tail = source.slice((match.index || 0) + match[0].length, (match.index || 0) + match[0].length + 1_500);
    const snippet = tail.match(/class\s*=\s*["'][^"']*result__snippet[^"']*["'][^>]*>([\s\S]*?)<\/(?:a|div|span)>/iu)?.[1];
    const candidate = normalizeRadarWebCandidate(href, {
      title: stripMarkup(match[3]),
      snippet: stripMarkup(snippet || ""),
      provider,
    });
    if (candidate) candidates.push(candidate);
  }
  return candidates;
}

function unwrapSearchRedirect(raw) {
  let value = unwrapWebSearchRedirect(raw);
  if (value.startsWith("//")) value = `https:${value}`;
  try {
    const url = new URL(value);
    const redirected = url.searchParams.get("uddg") || url.searchParams.get("url") || url.searchParams.get("u");
    if (redirected && /(?:^|\.)t\.me$/iu.test(new URL(redirected).hostname)) return redirected;
  } catch {
    // Ниже попробуем разобрать значение как прямую Telegram-ссылку.
  }
  return value;
}

export function normalizeTelegramCandidate(rawUrl) {
  const unwrapped = unwrapSearchRedirect(rawUrl);
  let url;
  try {
    url = new URL(unwrapped.startsWith("http") ? unwrapped : `https://${unwrapped.replace(/^\/+/, "")}`);
  } catch {
    return null;
  }
  const hostname = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (hostname !== "t.me" && hostname !== "telegram.me") return null;

  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "s") parts.shift();
  const handle = String(parts[0] || "").toLowerCase();
  if (!TELEGRAM_HANDLE.test(handle) || TELEGRAM_STOP_HANDLES.has(handle) || /bot$/iu.test(handle)) {
    return null;
  }
  const messageId = /^\d+$/u.test(String(parts[1] || "")) ? Number(parts[1]) : null;
  const canonicalUrl = messageId
    ? `https://t.me/${handle}/${messageId}`
    : `https://t.me/${handle}`;
  return {
    handle,
    messageId,
    canonicalUrl,
    canonicalKey: messageId ? `tg:post:${handle}:${messageId}` : `tg:channel:${handle}`,
  };
}

function candidateUrlsFromPayload(payload) {
  const source = decodeHtml(payload);
  const values = [];
  for (const match of source.matchAll(/(?:href|url|link)\s*=\s*["']([^"']+)["']/giu)) {
    values.push(match[1]);
  }
  for (const match of source.matchAll(/https?(?:%3A%2F%2F|:\/\/)(?:www\.)?(?:t\.me|telegram\.me)(?:%2F|\/)[^\s<"'&]+/giu)) {
    let value = match[0];
    try { value = decodeURIComponent(value); } catch { /* уже декодировано */ }
    values.push(value);
  }
  return values;
}

export function parseTelegramCandidates(payload, provider = "web") {
  const unique = new Map();
  for (const raw of candidateUrlsFromPayload(payload)) {
    const candidate = normalizeTelegramCandidate(raw);
    if (!candidate) continue;
    const channelKey = `tg:channel:${candidate.handle}`;
    const current = unique.get(channelKey);
    unique.set(channelKey, {
      ...(current || candidate),
      handle: candidate.handle,
      messageId: current?.messageId ?? candidate.messageId,
      canonicalUrl: `https://t.me/${candidate.handle}`,
      canonicalKey: channelKey,
      provider,
    });
  }
  return [...unique.values()];
}

function mergeTelegramCandidates(target, candidates) {
  for (const candidate of candidates || []) {
    if (!candidate?.handle) continue;
    const current = target.get(candidate.handle);
    target.set(candidate.handle, {
      ...(current || candidate),
      ...candidate,
      matchedQueries: [...new Set([
        ...(current?.matchedQueries || []),
        ...(candidate.matchedQueries || []),
      ])],
      providers: [...new Set([
        ...(current?.providers || []),
        ...(candidate.providers || []),
        candidate.provider,
      ].filter(Boolean))],
    });
  }
}

function pageSignature(values) {
  return (values || [])
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .sort()
    .join("\n");
}

function xmlItemCount(payload) {
  return [...String(payload || "").matchAll(/<item\b/giu)].length;
}

function xmlTotalResults(payload) {
  const match = String(payload || "").match(/<(?:\w+:)?totalResults\b[^>]*>(\d+)<\//iu);
  return match ? Number(match[1]) : null;
}

function htmlHiddenInput(payload, name) {
  for (const match of String(payload || "").matchAll(/<input\b([^>]*)>/giu)) {
    const attrs = match[1];
    const nameMatch = attrs.match(/\bname\s*=\s*["']([^"']+)["']/iu);
    if (nameMatch?.[1] !== name) continue;
    const valueMatch = attrs.match(/\bvalue\s*=\s*["']([^"']*)["']/iu);
    if (valueMatch) return decodeHtml(valueMatch[1]);
  }
  return null;
}

function duckDuckGoNextOffset(payload) {
  const moreForm = String(payload || "").match(
    /<form\b[^>]*class\s*=\s*["'][^"']*result--more[^"']*["'][^>]*>[\s\S]*?<\/form>/iu,
  );
  return htmlHiddenInput(moreForm?.[0] || "", "s");
}

function boundedBudgetNumber(value, fallback, min, max) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

export function createRadarDiscoveryBudget(input = {}) {
  const limits = {
    maxPages: boundedBudgetNumber(input.maxPages, RADAR_DISCOVERY_BUDGET.maxPages, 1, 100),
    maxCandidates: boundedBudgetNumber(input.maxCandidates, RADAR_DISCOVERY_BUDGET.maxCandidates, 1, 2_000),
    maxQueries: boundedBudgetNumber(input.maxQueries, RADAR_DISCOVERY_BUDGET.maxQueries, 1, 50),
    maxResponseBytes: boundedBudgetNumber(
      input.maxResponseBytes,
      RADAR_DISCOVERY_BUDGET.maxResponseBytes,
      1_024,
      10 * 1024 * 1024,
    ),
    deadlineMs: boundedBudgetNumber(input.deadlineMs, RADAR_DISCOVERY_BUDGET.deadlineMs, 10, 60_000),
  };
  const controller = new AbortController();
  const startedAt = Date.now();
  const deadlineAt = startedAt + limits.deadlineMs;
  const reasons = new Set();
  const acceptedCandidates = new Set();
  let pages = 0;
  const timer = setTimeout(() => {
    reasons.add("deadline");
    controller.abort(new RadarDiscoveryError("discovery_deadline_exceeded"));
  }, limits.deadlineMs);
  timer.unref?.();
  if (input.signal) {
    if (input.signal.aborted) controller.abort(input.signal.reason);
    else input.signal.addEventListener("abort", () => controller.abort(input.signal.reason), { once: true });
  }

  const expired = () => {
    if (controller.signal.aborted || Date.now() >= deadlineAt) {
      reasons.add("deadline");
      if (!controller.signal.aborted) controller.abort(new RadarDiscoveryError("discovery_deadline_exceeded"));
      return true;
    }
    return false;
  };

  return {
    limits,
    signal: controller.signal,
    mark(reason) { reasons.add(String(reason)); },
    expired,
    takePage() {
      if (expired()) return false;
      if (pages >= limits.maxPages) {
        reasons.add("max_pages");
        return false;
      }
      pages += 1;
      return true;
    },
    acceptCandidates(candidates) {
      const accepted = [];
      for (const candidate of Array.isArray(candidates) ? candidates : []) {
        const key = String(candidate?.handle || candidate?.canonicalUrl || candidate?.canonicalKey || "").toLowerCase();
        if (!key) continue;
        if (!acceptedCandidates.has(key) && acceptedCandidates.size >= limits.maxCandidates) {
          reasons.add("max_candidates");
          break;
        }
        acceptedCandidates.add(key);
        accepted.push(candidate);
      }
      return accepted;
    },
    assertResponseSize(payload, declaredLength) {
      if (Number.isFinite(declaredLength) && declaredLength > limits.maxResponseBytes) {
        reasons.add("max_response_bytes");
        throw new RadarDiscoveryError("response_too_large");
      }
      if (new TextEncoder().encode(String(payload || "")).byteLength > limits.maxResponseBytes) {
        reasons.add("max_response_bytes");
        throw new RadarDiscoveryError("response_too_large");
      }
    },
    async run(task) {
      if (expired()) throw new RadarDiscoveryError("discovery_deadline_exceeded");
      return new Promise((resolve, reject) => {
        const abort = () => reject(new RadarDiscoveryError("discovery_deadline_exceeded"));
        controller.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve(task).then(
          (value) => {
            controller.signal.removeEventListener("abort", abort);
            resolve(value);
          },
          (error) => {
            controller.signal.removeEventListener("abort", abort);
            reject(error);
          },
        );
      });
    },
    finish() { clearTimeout(timer); },
    summary() {
      return {
        pages,
        candidates: acceptedCandidates.size,
        reasons: [...reasons],
        deadlineMs: limits.deadlineMs,
      };
    },
  };
}

function providerRequest(url, init = {}, budget) {
  const signals = [init.signal, budget?.signal, AbortSignal.timeout(12_000)].filter(Boolean);
  return {
    url,
    init: {
      ...init,
      headers: {
        accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "accept-language": "ru,en;q=0.8",
        "user-agent": "Mozilla/5.0 (compatible; AuroraRadar/1.0; public-source-discovery)",
        ...(init.headers || {}),
      },
      signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals),
    },
  };
}

async function responseText(response, budget) {
  const declaredLength = Number(response.headers?.get?.("content-length"));
  let payload;
  if (typeof response.text === "function") payload = await response.text();
  else if (typeof response.json === "function") payload = JSON.stringify(await response.json());
  else payload = "";
  budget?.assertResponseSize(payload, declaredLength);
  return payload;
}

async function readSearchResponse(fetchImpl, request, provider, budget) {
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) throw new RadarDiscoveryError(`${provider}_http_${response.status}`);
  return responseText(response, budget);
}

export function createSearxngTelegramProvider({ endpoint, fetchImpl = fetch } = {}) {
  const base = String(endpoint || "").trim();
  if (!base) return null;
  return {
    name: "searxng",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL(base);
      if (!/\/search\/?$/u.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/u, "")}/search`;
      // /s/ указывает поисковику на публичные страницы с текстами постов. Название
      // канала намеренно не добавляем в запрос: ищем содержание, а не вывеску.
      url.searchParams.set("q", `site:t.me/s ${query}`);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", "ru-RU");
      const found = new Map();
      const seenPages = new Set();
      for (let page = 1; ; page += 1) {
        if (budget && !budget.takePage()) break;
        url.searchParams.set("pageno", String(page));
        let response;
        try {
          response = await fetchImpl(url, providerRequest(url, {}, budget).init);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        if (!response.ok) {
          if (found.size) break;
          throw new RadarDiscoveryError(`searxng_http_${response.status}`);
        }
        const payloadText = await responseText(response, budget);
        let json;
        try { json = JSON.parse(payloadText); } catch { throw new RadarDiscoveryError("searxng_invalid_json"); }
        const pageResults = Array.isArray(json?.results) ? json.results : [];
        if (!pageResults.length) break;
        const signature = pageSignature(pageResults.map((item) => item?.url));
        if (!signature || seenPages.has(signature)) break;
        seenPages.add(signature);
        const payload = pageResults
          .map((item) => `${item?.url || ""}\n${item?.content || ""}`)
          .join("\n");
        const pageCandidates = parseTelegramCandidates(payload, "searxng");
        mergeTelegramCandidates(found, budget ? budget.acceptCandidates(pageCandidates) : pageCandidates);
        const total = Number(json?.number_of_results);
        if (Number.isFinite(total) && total > 0 && page * pageResults.length >= total) break;
      }
      return [...found.values()];
    },
  };
}

export function createBraveHtmlTelegramProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "brave-html",
    async search(query, context = {}) {
      const budget = context.budget;
      if (budget && !budget.takePage()) return [];
      const url = new URL("https://search.brave.com/search");
      url.searchParams.set("q", `${query} Telegram каналы`);
      url.searchParams.set("source", "web");
      const payload = await readSearchResponse(
        fetchImpl,
        providerRequest(url, {}, budget),
        "brave_html",
        budget,
      );
      const correctedQuery = parseBraveSearchCorrection(payload);
      return parseTelegramCandidates(payload, "brave-html").map((candidate) => ({
        ...candidate,
        correctedQuery,
      }));
    },
  };
}

export function createYahooHtmlTelegramProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "yahoo-html",
    async search(query, context = {}) {
      const budget = context.budget;
      if (budget && !budget.takePage()) return [];
      const url = new URL("https://search.yahoo.com/search");
      url.searchParams.set("p", `${query} Telegram каналы`);
      const payload = await readSearchResponse(
        fetchImpl,
        providerRequest(url, {}, budget),
        "yahoo_html",
        budget,
      );
      const correctedQuery = parseYahooSearchCorrection(payload);
      return parseTelegramCandidates(payload, "yahoo-html").map((candidate) => ({
        ...candidate,
        correctedQuery,
      }));
    },
  };
}

export function createPublicHtmlTelegramProvider({ fetchImpl = fetch } = {}) {
  const yahoo = createYahooHtmlTelegramProvider({ fetchImpl });
  const brave = createBraveHtmlTelegramProvider({ fetchImpl });
  return {
    name: "public-html",
    async search(query, context = {}) {
      let yahooCompleted = false;
      try {
        const candidates = await yahoo.search(query, context);
        yahooCompleted = true;
        if (candidates.length > 0) return candidates;
      } catch {
        // Brave ниже — независимый резерв на случай блокировки Yahoo.
      }
      try {
        return await brave.search(query, context);
      } catch (error) {
        if (yahooCompleted) return [];
        throw error;
      }
    },
  };
}

export function createBingRssTelegramProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "bing-rss",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL("https://www.bing.com/search");
      url.searchParams.set("format", "rss");
      // Bing часто игнорирует site:t.me для русскоязычной RSS-выдачи. Широкая
      // формулировка находит также каталоги и подборки, а ниже мы всё равно принимаем
      // только реальные t.me-ссылки и отдельно проверяем сам публичный канал.
      url.searchParams.set("q", `${query} Telegram каналы`);
      url.searchParams.set("count", "50");
      const found = new Map();
      const seenPages = new Set();
      let first = 1;
      let pageCount = 0;
      for (;;) {
        if (pageCount >= 1) break;
        if (budget && !budget.takePage()) break;
        pageCount += 1;
        url.searchParams.set("first", String(first));
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url, {}, budget), "bing_rss", budget);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        const parsedCandidates = parseTelegramCandidates(payload, "bing-rss");
        const pageCandidates = budget ? budget.acceptCandidates(parsedCandidates) : parsedCandidates;
        const itemCount = xmlItemCount(payload);
        if (!itemCount) {
          mergeTelegramCandidates(found, pageCandidates);
          break;
        }
        const signature = pageSignature(
          [...String(payload).matchAll(/<item\b[\s\S]*?<\/item>/giu)].map((match) => match[0]),
        );
        if (!signature || seenPages.has(signature)) break;
        seenPages.add(signature);
        mergeTelegramCandidates(found, pageCandidates);
        const total = xmlTotalResults(payload);
        first += itemCount;
        if (total != null && first > total) break;
      }
      return [...found.values()];
    },
  };
}

export function createDuckDuckGoTelegramProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "duckduckgo-html",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", `${query} Telegram каналы`);
      const found = new Map();
      const seenOffsets = new Set();
      let offset = "0";
      let pageCount = 0;
      for (;;) {
        if (pageCount >= 1) break;
        if (budget && !budget.takePage()) break;
        pageCount += 1;
        if (offset === "0") url.searchParams.delete("s");
        else url.searchParams.set("s", offset);
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url, {}, budget), "duckduckgo", budget);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        const pageCandidates = parseTelegramCandidates(payload, "duckduckgo-html");
        mergeTelegramCandidates(found, budget ? budget.acceptCandidates(pageCandidates) : pageCandidates);
        const nextOffset = duckDuckGoNextOffset(payload);
        if (!nextOffset || nextOffset === offset || seenOffsets.has(nextOffset)) break;
        seenOffsets.add(offset);
        offset = nextOffset;
      }
      return [...found.values()];
    },
  };
}

export function createSearxngWebProvider({ endpoint, fetchImpl = fetch } = {}) {
  const base = String(endpoint || "").trim();
  if (!base) return null;
  return {
    name: "searxng-web",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL(base);
      if (!/\/search\/?$/u.test(url.pathname)) url.pathname = `${url.pathname.replace(/\/$/u, "")}/search`;
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      url.searchParams.set("language", "ru-RU");
      const found = new Map();
      const seenPages = new Set();
      for (let page = 1; ; page += 1) {
        if (budget && !budget.takePage()) break;
        url.searchParams.set("pageno", String(page));
        let response;
        try {
          response = await fetchImpl(url, providerRequest(url, {}, budget).init);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        if (!response.ok) {
          if (found.size) break;
          throw new RadarDiscoveryError(`searxng_web_http_${response.status}`);
        }
        const payloadText = await responseText(response, budget);
        let json;
        try { json = JSON.parse(payloadText); } catch { throw new RadarDiscoveryError("searxng_web_invalid_json"); }
        const pageResults = Array.isArray(json?.results) ? json.results : [];
        if (!pageResults.length) break;
        const signature = pageSignature(pageResults.map((item) => item?.url));
        if (!signature || seenPages.has(signature)) break;
        seenPages.add(signature);
        for (const item of pageResults) {
          const candidate = normalizeRadarWebCandidate(item?.url, {
            title: item?.title,
            snippet: item?.content,
            publishedAt: item?.publishedDate,
            provider: "searxng-web",
          });
          if (candidate) found.set(candidate.canonicalUrl, candidate);
        }
        const total = Number(json?.number_of_results);
        if (Number.isFinite(total) && total > 0 && page * pageResults.length >= total) break;
      }
      return [...found.values()];
    },
  };
}

export function createBraveHtmlWebProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "brave-html-web",
    async search(query, context = {}) {
      const budget = context.budget;
      if (budget && !budget.takePage()) return [];
      const url = new URL("https://search.brave.com/search");
      url.searchParams.set("q", query);
      url.searchParams.set("source", "web");
      const payload = await readSearchResponse(
        fetchImpl,
        providerRequest(url, {}, budget),
        "brave_html_web",
        budget,
      );
      return parseBraveWebCandidates(payload, "brave-html-web");
    },
  };
}

export function createYahooHtmlWebProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "yahoo-html-web",
    async search(query, context = {}) {
      const budget = context.budget;
      if (budget && !budget.takePage()) return [];
      const url = new URL("https://search.yahoo.com/search");
      url.searchParams.set("p", query);
      const payload = await readSearchResponse(
        fetchImpl,
        providerRequest(url, {}, budget),
        "yahoo_html_web",
        budget,
      );
      return parseYahooWebCandidates(payload, "yahoo-html-web");
    },
  };
}

export function createPublicHtmlWebProvider({ fetchImpl = fetch } = {}) {
  const yahoo = createYahooHtmlWebProvider({ fetchImpl });
  const brave = createBraveHtmlWebProvider({ fetchImpl });
  return {
    name: "public-html-web",
    async search(query, context = {}) {
      let yahooCompleted = false;
      try {
        const candidates = await yahoo.search(query, context);
        yahooCompleted = true;
        if (candidates.length > 0) return candidates;
      } catch {
        // Brave ниже — независимый резерв на случай блокировки Yahoo.
      }
      try {
        return await brave.search(query, context);
      } catch (error) {
        if (yahooCompleted) return [];
        throw error;
      }
    },
  };
}

export function createBingRssWebProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "bing-rss-web",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL("https://www.bing.com/search");
      url.searchParams.set("format", "rss");
      url.searchParams.set("q", query);
      url.searchParams.set("count", "50");
      const found = new Map();
      const seenPages = new Set();
      let first = 1;
      let pageCount = 0;
      for (;;) {
        if (pageCount >= 1) break;
        if (budget && !budget.takePage()) break;
        pageCount += 1;
        url.searchParams.set("first", String(first));
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url, {}, budget), "bing_rss_web", budget);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        const pageCandidates = parseBingRssWebCandidates(payload);
        for (const candidate of pageCandidates) found.set(candidate.canonicalUrl, candidate);
        const itemCount = xmlItemCount(payload);
        if (!itemCount) break;
        const signature = pageSignature(pageCandidates.map((candidate) => candidate.canonicalUrl));
        if (!signature || seenPages.has(signature)) break;
        seenPages.add(signature);
        const total = xmlTotalResults(payload);
        first += itemCount;
        if (total != null && first > total) break;
      }
      return [...found.values()];
    },
  };
}

export function createDuckDuckGoWebProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "duckduckgo-html-web",
    async search(query, context = {}) {
      const budget = context.budget;
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", query);
      const found = new Map();
      const seenOffsets = new Set();
      let offset = "0";
      let pageCount = 0;
      for (;;) {
        if (pageCount >= 1) break;
        if (budget && !budget.takePage()) break;
        pageCount += 1;
        if (offset === "0") url.searchParams.delete("s");
        else url.searchParams.set("s", offset);
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url, {}, budget), "duckduckgo_web", budget);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        for (const candidate of parseDuckDuckGoWebCandidates(payload)) {
          found.set(candidate.canonicalUrl, candidate);
        }
        const nextOffset = duckDuckGoNextOffset(payload);
        if (!nextOffset || nextOffset === offset || seenOffsets.has(nextOffset)) break;
        seenOffsets.add(offset);
        offset = nextOffset;
      }
      return [...found.values()];
    },
  };
}

export async function discoverRadarWebCandidates(query, options = {}) {
  const raw = String(query ?? "").normalize("NFKC").trim();
  if (normalizeRadarQuery(raw).length < 2) throw new RadarDiscoveryError("query_too_short");
  const providers = options.providers || [
    createSearxngWebProvider({ endpoint: options.searxngUrl, fetchImpl: options.fetchImpl }),
    createPublicHtmlWebProvider({ fetchImpl: options.fetchImpl }),
    createBingRssWebProvider({ fetchImpl: options.fetchImpl }),
    createDuckDuckGoWebProvider({ fetchImpl: options.fetchImpl }),
  ].filter(Boolean);
  if (providers.length === 0) throw new RadarDiscoveryError("provider_not_configured");

  const budget = createRadarDiscoveryBudget({
    ...RADAR_WEB_DISCOVERY_BUDGET,
    ...(options.budget || {}),
    signal: options.signal,
  });
  const found = new Map();
  const failures = [];
  let completed = 0;
  const allQueries = buildRadarWebDiscoveryQueries(raw, options.expandedQueries);
  const discoveryQueries = allQueries.slice(0, budget.limits.maxQueries);
  if (allQueries.length > discoveryQueries.length) budget.mark("max_queries");
  try {
    const direct = /^https?:\/\//iu.test(raw)
      ? normalizeRadarWebCandidate(raw, { provider: "direct-url" })
      : null;
    if (direct) found.set(direct.canonicalUrl, { ...direct, matchedQueries: [raw], providers: ["direct-url"] });
    for (const discoveryQuery of discoveryQueries) {
      if (budget.expired()) break;
      const settled = await Promise.allSettled(
        providers.map(async (provider) => ({
          provider,
          candidates: await budget.run(provider.search(discoveryQuery, { budget, signal: budget.signal })),
        })),
      );
      for (const result of settled) {
        if (result.status === "rejected") {
          failures.push(result.reason?.code || result.reason?.message || "provider_failed");
          continue;
        }
        completed += 1;
        const accepted = budget.acceptCandidates(result.value.candidates || []);
        for (const candidate of accepted) {
          if (!candidate?.canonicalUrl) continue;
          const current = found.get(candidate.canonicalUrl);
          found.set(candidate.canonicalUrl, {
            ...(current || candidate),
            ...candidate,
            matchedQueries: [...new Set([...(current?.matchedQueries || []), discoveryQuery])],
            providers: [...new Set([...(current?.providers || []), candidate.provider || result.value.provider.name])],
          });
        }
      }
    }
    const summary = budget.summary();
    if (completed === 0 && !direct && summary.reasons.length === 0) {
      throw new RadarDiscoveryError("all_providers_unavailable", failures.join(", "));
    }
    if (failures.length > 0 && (completed > 0 || direct)) budget.mark("provider_failed");
    const finalSummary = budget.summary();
    const domainCounts = new Map();
    const result = [...found.values()].filter((candidate) => {
      const count = domainCounts.get(candidate.domain) || 0;
      if (count >= 3) return false;
      domainCounts.set(candidate.domain, count + 1);
      return true;
    });
    Object.defineProperties(result, {
      status: { value: finalSummary.reasons.length > 0 ? "partial" : "complete", enumerable: false },
      partialReasons: { value: finalSummary.reasons, enumerable: false },
      budget: { value: finalSummary, enumerable: false },
    });
    return result;
  } finally {
    budget.finish();
  }
}

export async function discoverTelegramCandidates(query, options = {}) {
  const normalized = normalizeRadarQuery(query);
  if (normalized.length < 2) throw new RadarDiscoveryError("query_too_short");
  const providers = options.providers || [
    createSearxngTelegramProvider({ endpoint: options.searxngUrl, fetchImpl: options.fetchImpl }),
    createPublicHtmlTelegramProvider({ fetchImpl: options.fetchImpl }),
    createBingRssTelegramProvider({ fetchImpl: options.fetchImpl }),
    createDuckDuckGoTelegramProvider({ fetchImpl: options.fetchImpl }),
  ].filter(Boolean);
  if (providers.length === 0) throw new RadarDiscoveryError("provider_not_configured");

  const budget = createRadarDiscoveryBudget({ ...(options.budget || {}), signal: options.signal });
  const found = new Map();
  const failures = [];
  let completed = 0;
  const allQueries = buildRadarDiscoveryQueries(normalized, options.expandedQueries);
  const discoveryQueries = allQueries.slice(0, budget.limits.maxQueries);
  if (allQueries.length > discoveryQueries.length) budget.mark("max_queries");
  try {
    for (const discoveryQuery of discoveryQueries) {
      if (budget.expired()) break;
      const settled = await Promise.allSettled(
        providers.map(async (provider) => ({
          provider,
          candidates: await budget.run(provider.search(discoveryQuery, { budget, signal: budget.signal })),
        })),
      );
      for (const result of settled) {
        if (result.status === "rejected") {
          failures.push(result.reason?.code || result.reason?.message || "provider_failed");
          continue;
        }
        completed += 1;
        const accepted = budget.acceptCandidates(result.value.candidates || []);
        for (const candidate of accepted) {
          if (!candidate?.handle) continue;
          const current = found.get(candidate.handle);
          const correctedQuery = normalizeRadarQuery(candidate.correctedQuery);
          found.set(candidate.handle, {
            ...(current || candidate),
            ...candidate,
            matchedQuery: discoveryQuery,
            matchedQueries: [...new Set([
              ...(current?.matchedQueries || []),
              discoveryQuery,
              ...(correctedQuery.length >= 2 ? [correctedQuery] : []),
            ])],
            providers: [...new Set([...(current?.providers || []), candidate.provider || result.value.provider.name])],
          });
        }
      }
    }
    const summary = budget.summary();
    if (completed === 0 && summary.reasons.length === 0) {
      throw new RadarDiscoveryError("all_providers_unavailable", failures.join(", "));
    }
    if (failures.length > 0 && completed > 0) budget.mark("provider_failed");
    const finalSummary = budget.summary();
    const result = [...found.values()];
    Object.defineProperties(result, {
      status: { value: finalSummary.reasons.length > 0 ? "partial" : "complete", enumerable: false },
      partialReasons: { value: finalSummary.reasons, enumerable: false },
      budget: { value: finalSummary, enumerable: false },
    });
    return result;
  } finally {
    budget.finish();
  }
}

export function scoreRadarSemanticSimilarity(value) {
  const similarity = Number(value);
  if (!Number.isFinite(similarity) || similarity < 0.42) return 0;
  // На русских bge-m3-векторах 0.45 — нижняя граница тематической связи, 0.70+
  // означает почти прямое совпадение. Растягиваем измеренный рабочий диапазон на 0–100.
  return Math.round(Math.max(0, Math.min(100, ((similarity - 0.42) / 0.28) * 100)));
}

function searchableText(value) {
  return normalizeRadarQuery(value).replace(/_/gu, " ");
}

function tokenMatches(corpus, token) {
  if (!token) return false;
  return corpus.includes(token);
}

function tokenOccurrences(corpus, token) {
  if (!token) return 0;
  let count = 0;
  let offset = 0;
  while (offset < corpus.length) {
    const found = corpus.indexOf(token, offset);
    if (found < 0) break;
    count += 1;
    offset = found + token.length;
  }
  return count;
}

export function scoreRadarRelevance(query, input = {}) {
  const tokens = radarQueryTokens(query);
  if (tokens.length === 0) return 0;
  const title = searchableText(`${input.title || ""} ${input.handle || ""}`);
  const description = searchableText(input.description || "");
  const posts = (Array.isArray(input.posts) ? input.posts : [])
    .map((post) => searchableText(post?.text || post || ""))
    .filter(Boolean);
  const corpus = `${title} ${description} ${posts.join(" ")}`;
  const matched = tokens.filter((token) => tokenMatches(corpus, token));
  const coverage = matched.length / tokens.length;
  if (coverage === 0) return 0;

  const titleCoverage = tokens.filter((token) => tokenMatches(title, token)).length / tokens.length;
  const descriptionCoverage = tokens.filter((token) => tokenMatches(description, token)).length / tokens.length;
  const relevantPosts = posts.filter((post) => tokens.some((token) => tokenMatches(post, token))).length;
  const postSignal = posts.length ? Math.min(1, relevantPosts / Math.min(posts.length, 4)) : 0;
  const phrase = normalizeRadarQuery(query);
  const exactPhrase = phrase.length >= 4 && corpus.includes(phrase) ? 1 : 0;

  let score = coverage * 45 + titleCoverage * 25 + descriptionCoverage * 10 + postSignal * 15 + exactPhrase * 5;
  const postCorpus = posts.join(" ");
  const occurrenceCount = tokens.reduce((sum, token) => sum + tokenOccurrences(postCorpus, token), 0);
  // Одно упоминание «садоводства» в длинном юридическом разборе не делает его материалом
  // про садоводство. Сигнал остаётся, если тема подтверждается названием/описанием,
  // повторяется несколько раз или публикация достаточно короткая и сфокусированная.
  if (
    titleCoverage === 0
    && descriptionCoverage === 0
    && postCorpus.length >= 650
    && occurrenceCount <= tokens.length
  ) {
    score -= 38;
  }

  return Math.round(Math.max(0, Math.min(100, score)));
}

export function scoreRadarFreshness(value, now = Date.now()) {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return 20;
  const days = Math.max(0, (now - timestamp) / 86_400_000);
  if (days <= 2) return 100;
  if (days <= 7) return 90;
  if (days <= 30) return 72;
  if (days <= 90) return 48;
  if (days <= 365) return 25;
  return 8;
}

export function scoreRadarActivity(postsPerWeek) {
  const value = Number(postsPerWeek);
  if (!Number.isFinite(value) || value < 0) return 30;
  if (value >= 3 && value <= 28) return 100;
  if (value >= 1) return 82;
  if (value >= 0.25) return 55;
  return 18;
}

export function radarSpamPenalty(query, input = {}) {
  const corpus = searchableText(`${input.title || ""} ${input.description || ""} ${(input.posts || []).map?.((p) => p?.text || p).join?.(" ") || ""}`);
  const queryText = searchableText(query);
  let penalty = 0;
  for (const marker of SPAM_WORDS) {
    if (corpus.includes(marker) && !queryText.includes(marker)) penalty += 18;
  }
  if (/([!?])\1{4,}/u.test(corpus)) penalty += 8;
  return Math.min(55, penalty);
}

export function rankVerifiedTelegramSource(query, source, now = Date.now()) {
  const activity = source.activity || {};
  const lexicalRelevance = scoreRadarRelevance(query, source);
  const semanticRelevance = scoreRadarSemanticSimilarity(source.semanticSimilarity);
  const relevance = Math.max(lexicalRelevance, semanticRelevance);
  const freshness = scoreRadarFreshness(activity.lastPostAt || source.lastPostAt, now);
  const activityScore = scoreRadarActivity(activity.postsPerWeek ?? source.postsPerWeek);
  const trust = source.ok && Array.isArray(source.posts) && source.posts.length > 0 ? 100 : 0;
  const completenessParts = [source.title, source.description, source.subscribers, activity.lastPostAt]
    .filter((value) => value !== null && value !== undefined && value !== "").length;
  const completeness = Math.round((completenessParts / 4) * 100);
  const penalty = radarSpamPenalty(query, source);
  const score = Math.max(0, Math.round(
    relevance * 0.45 + freshness * 0.2 + activityScore * 0.15 + trust * 0.1 + completeness * 0.1 - penalty,
  ));
  const relevantPostCount = (source.posts || []).filter(
    (post) => scoreRadarRelevance(query, { posts: [post] }) >= 35,
  ).length;
  const reasonParts = [];
  if (semanticRelevance > lexicalRelevance && semanticRelevance >= 35) {
    reasonParts.push("тематика публикаций совпадает с запросом по смыслу");
  } else if (relevance >= 75) reasonParts.push("тема явно совпадает с запросом");
  else if (relevance >= 45) reasonParts.push("в публикациях встречается нужная тема");
  if (freshness >= 72) reasonParts.push("канал публиковался недавно");
  if (activityScore >= 82) reasonParts.push("канал активен");
  if (relevantPostCount > 0) reasonParts.push(`найдено релевантных публикаций: ${relevantPostCount}`);

  return {
    score,
    relevance,
    lexicalRelevance,
    semanticRelevance,
    freshness,
    activity: activityScore,
    trust,
    completeness,
    penalty,
    relevantPostCount,
    accepted:
      trust === 100
      && relevance >= 35
      && score >= 35,
    reason: reasonParts.slice(0, 3).join("; ") || "публичный источник проверен",
  };
}

export function rankVerifiedTelegramSourceAcrossQueries(query, expandedQueries, source, now = Date.now()) {
  const original = normalizeRadarQuery(query);
  const queries = buildRadarDiscoveryQueries(original, expandedQueries);
  let strongest = null;
  for (const candidateQuery of queries) {
    const rank = rankVerifiedTelegramSource(candidateQuery, source, now);
    if (!strongest || rank.score > strongest.score) {
      strongest = { ...rank, matchedQuery: candidateQuery };
    }
  }
  const selected = strongest || { ...rankVerifiedTelegramSource(original, source, now), matchedQuery: original };
  if (selected.accepted && selected.matchedQuery && selected.matchedQuery !== original) {
    return {
      ...selected,
      reason: `найдено по близкой формулировке «${selected.matchedQuery}»; ${selected.reason}`,
    };
  }
  return selected;
}

export function rankVerifiedTelegramPost(query, post, channelRank, now = Date.now()) {
  const relevance = scoreRadarRelevance(query, { posts: [post] });
  const freshness = scoreRadarFreshness(post?.postedAt, now);
  const views = Number(post?.views);
  const engagement = Number.isFinite(views) && views > 0 ? Math.min(100, 30 + Math.log10(views + 1) * 18) : 30;
  const score = Math.round(relevance * 0.55 + freshness * 0.25 + engagement * 0.1 + channelRank.trust * 0.1);
  return {
    score,
    relevance,
    freshness,
    accepted: Boolean(String(post?.text || "").trim()) && relevance >= 35 && score >= 40,
    reason: relevance >= 70
      ? "публикация напрямую отвечает теме запроса"
      : "публикация найдена в проверенном тематическом канале",
  };
}

export function radarWebSourceKind(value) {
  let hostname = "";
  let pathname = "";
  try {
    const url = new URL(String(value || ""));
    hostname = url.hostname.toLowerCase();
    pathname = url.pathname.toLowerCase();
  } catch {
    return "other";
  }
  if (SOCIAL_HOSTS.test(hostname)) return "social";
  if (/(?:^|\.)wikipedia\.org$/u.test(hostname) || /(?:^|\.)wikidata\.org$/u.test(hostname)) return "reference";
  if (/(?:about|bio|author|people|person|profile|team)/u.test(pathname)) return "profile";
  if (/(?:news|blog|article|post|publication)/u.test(pathname)) return "article";
  return "organization";
}

function radarWebDomainTrust(domain, sourceKind) {
  const hostname = String(domain || "").toLowerCase();
  if (/(?:^|\.)wikipedia\.org$/u.test(hostname) || /(?:^|\.)wikidata\.org$/u.test(hostname)) return 88;
  if (sourceKind === "social") return 82;
  if (/\.(?:gov|edu)(?:\.[a-z]{2})?$/u.test(hostname)) return 92;
  if (sourceKind === "profile" || sourceKind === "organization") return 74;
  return 62;
}

function boundedEditDistance(leftValue, rightValue, maxDistance = 2) {
  const left = String(leftValue || "");
  const right = String(rightValue || "");
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_value, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    const current = [row];
    let rowMinimum = row;
    for (let column = 1; column <= right.length; column += 1) {
      const value = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      current[column] = value;
      rowMinimum = Math.min(rowMinimum, value);
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

function correctedIdentityHandle(requestedHandle, correction, corpus) {
  const requested = String(requestedHandle || "").toLowerCase();
  if (!requested || !correction) return null;
  const tokens = normalizeRadarQuery(correction)
    .split(/\s+/u)
    .map((token) => token.replace(/^@/u, ""))
    .filter((token) => HANDLE_QUERY.test(token));
  for (const token of tokens) {
    if (token === requested || !String(corpus || "").includes(token)) continue;
    const maxDistance = Math.max(requested.length, token.length) >= 8 ? 2 : 1;
    if (boundedEditDistance(requested, token, maxDistance) <= maxDistance) return token;
  }
  return null;
}

export function rankRadarWebSource(query, source = {}) {
  const intent = source.intent || detectRadarQueryIntent(query);
  const handle = radarIdentityHandle(query);
  const urlText = searchableText(source.url || source.canonicalUrl || "");
  const title = searchableText(source.title || "");
  const description = searchableText(source.description || source.snippet || "");
  const body = searchableText(source.text || "");
  const sourceKind = source.sourceKind || radarWebSourceKind(source.url || source.canonicalUrl);
  const domain = source.domain || (() => {
    try { return new URL(String(source.url || source.canonicalUrl)).hostname; } catch { return ""; }
  })();
  let relevance = scoreRadarRelevance(query, {
    title,
    description,
    posts: body ? [{ text: body }] : [],
  });
  let exactIdentity = false;
  let correctedIdentity = null;
  try {
    const requestedUrl = new URL(String(query || "").trim());
    const sourceUrl = new URL(String(source.url || source.canonicalUrl || ""));
    if (
      requestedUrl.hostname.toLowerCase() === sourceUrl.hostname.toLowerCase()
      && requestedUrl.pathname.replace(/\/+$/u, "") === sourceUrl.pathname.replace(/\/+$/u, "")
    ) {
      exactIdentity = true;
      relevance = Math.max(relevance, 100);
    }
  } catch {
    // Обычный текстовый запрос.
  }
  if (handle) {
    const normalizedHandle = searchableText(handle);
    const identityCorpus = [urlText, title, description, body].join(" ");
    exactIdentity = exactIdentity || identityCorpus.includes(normalizedHandle);
    correctedIdentity = exactIdentity
      ? null
      : correctedIdentityHandle(normalizedHandle, source.correctedQuery, identityCorpus);
    if (correctedIdentity) exactIdentity = true;
    if (exactIdentity) relevance = Math.max(relevance, urlText.includes(normalizedHandle) ? 96 : 82);
    if (correctedIdentity) relevance = Math.max(relevance, urlText.includes(correctedIdentity) ? 92 : 80);
  }
  const trust = radarWebDomainTrust(domain, sourceKind);
  const fetched = source.fetched === true;
  const completeness = [source.title, source.description || source.snippet, source.text]
    .filter((value) => String(value || "").trim()).length;
  const score = Math.round(Math.max(0, Math.min(100,
    relevance * 0.62 + trust * 0.23 + (fetched ? 10 : 3) + completeness * 1.5,
  )));
  const accepted = intent === "identity"
    ? (exactIdentity || relevance >= 48) && score >= 45
    : relevance >= 35 && score >= 40;
  const reason = fetched
    ? correctedIdentity
      ? `Публичная страница открыта; поисковик исправил ник на @${correctedIdentity}`
      : exactIdentity
      ? "Публичная страница открыта; ник точно совпадает с запросом"
      : "Публичная страница открыта и её содержание совпадает с запросом"
    : correctedIdentity
      ? `Поисковик исправил ник на @${correctedIdentity}; совпадение подтверждено открытым индексом`
      : exactIdentity
      ? "Ник точно совпадает в открытом поисковом индексе; сайт не дал дочитать страницу"
      : "Источник найден в открытом поисковом индексе и совпадает с запросом";
  return {
    score,
    relevance,
    freshness: scoreRadarFreshness(source.publishedAt),
    activity: 0,
    trust,
    completeness: Math.round((completeness / 3) * 100),
    exactIdentity,
    correctedIdentity,
    accepted,
    sourceKind,
    reason,
  };
}

function boundedString(value, maxLength) {
  const text = sanitizeRadarPublicText(value, maxLength);
  return text || null;
}

export function parseRadarOsintProfile(raw, sourceCountValue) {
  const sourceCount = Math.max(0, Math.min(50, Number(sourceCountValue) || 0));
  const source = String(raw || "").trim().replace(/^```(?:json)?\s*/iu, "").replace(/\s*```$/u, "");
  let parsed;
  try { parsed = JSON.parse(source); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const facts = (Array.isArray(parsed.facts) ? parsed.facts : []).flatMap((fact) => {
    if (!fact || typeof fact !== "object") return [];
    const text = boundedString(fact.text, 600);
    const sourceIds = [...new Set((Array.isArray(fact.sourceIds) ? fact.sourceIds : [])
      .map(Number)
      .filter((id) => Number.isSafeInteger(id) && id >= 1 && id <= sourceCount))].slice(0, 6);
    return text && sourceIds.length ? [{ text, sourceIds }] : [];
  }).slice(0, 12);
  const ambiguities = (Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [])
    .map((value) => boundedString(value, 500))
    .filter(Boolean)
    .slice(0, 8);
  const aliases = (Array.isArray(parsed.aliases) ? parsed.aliases : [])
    .map((value) => boundedString(value, 120))
    .filter(Boolean)
    .slice(0, 10);
  const displayName = boundedString(parsed.displayName, 180);
  const bio = boundedString(parsed.bio, 1_600);
  if (!displayName && !bio && facts.length === 0) return null;
  const requestedConfidence = ["low", "medium", "high"].includes(parsed.confidence)
    ? parsed.confidence
    : "low";
  const confidence = sourceCount < 2
    ? "low"
    : sourceCount < 3 && requestedConfidence === "high"
      ? "medium"
      : requestedConfidence;
  return { displayName, bio, facts, aliases, ambiguities, confidence };
}

export function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
