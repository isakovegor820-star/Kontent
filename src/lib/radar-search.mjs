// Чистое ядро гибридного поиска «Конкуренты и тренды».
// Здесь нет PostgreSQL, Redis и глобального fetch: модуль можно тестировать отдельно,
// а внешний источник можно заменить, не меняя API, воркер и интерфейс.

export const RADAR_SEARCH_CACHE_MS = 24 * 60 * 60 * 1000;

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

function decodeHtml(value) {
  return String(value ?? "")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;/giu, '"')
    .replace(/&#0?39;/giu, "'")
    .replace(/&lt;/giu, "<")
    .replace(/&gt;/giu, ">");
}

function unwrapSearchRedirect(raw) {
  let value = decodeHtml(raw).trim();
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

function providerRequest(url, init = {}) {
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
      signal: AbortSignal.timeout(12_000),
    },
  };
}

async function readSearchResponse(fetchImpl, request, provider) {
  const response = await fetchImpl(request.url, request.init);
  if (!response.ok) throw new RadarDiscoveryError(`${provider}_http_${response.status}`);
  return response.text();
}

export function createSearxngTelegramProvider({ endpoint, fetchImpl = fetch } = {}) {
  const base = String(endpoint || "").trim();
  if (!base) return null;
  return {
    name: "searxng",
    async search(query) {
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
        url.searchParams.set("pageno", String(page));
        let response;
        try {
          response = await fetchImpl(url, providerRequest(url).init);
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        if (!response.ok) {
          if (found.size) break;
          throw new RadarDiscoveryError(`searxng_http_${response.status}`);
        }
        const json = await response.json();
        const pageResults = Array.isArray(json?.results) ? json.results : [];
        if (!pageResults.length) break;
        const signature = pageSignature(pageResults.map((item) => item?.url));
        if (!signature || seenPages.has(signature)) break;
        seenPages.add(signature);
        const payload = pageResults
          .map((item) => `${item?.url || ""}\n${item?.content || ""}`)
          .join("\n");
        mergeTelegramCandidates(found, parseTelegramCandidates(payload, "searxng"));
        const total = Number(json?.number_of_results);
        if (Number.isFinite(total) && total > 0 && page * pageResults.length >= total) break;
      }
      return [...found.values()];
    },
  };
}

export function createBingRssTelegramProvider({ fetchImpl = fetch } = {}) {
  return {
    name: "bing-rss",
    async search(query) {
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
      for (;;) {
        url.searchParams.set("first", String(first));
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url), "bing_rss");
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        const pageCandidates = parseTelegramCandidates(payload, "bing-rss");
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
    async search(query) {
      const url = new URL("https://html.duckduckgo.com/html/");
      url.searchParams.set("q", `${query} Telegram каналы`);
      const found = new Map();
      const seenOffsets = new Set();
      let offset = "0";
      for (;;) {
        if (offset === "0") url.searchParams.delete("s");
        else url.searchParams.set("s", offset);
        let payload;
        try {
          payload = await readSearchResponse(fetchImpl, providerRequest(url), "duckduckgo");
        } catch (error) {
          if (found.size) break;
          throw error;
        }
        mergeTelegramCandidates(found, parseTelegramCandidates(payload, "duckduckgo-html"));
        const nextOffset = duckDuckGoNextOffset(payload);
        if (!nextOffset || nextOffset === offset || seenOffsets.has(nextOffset)) break;
        seenOffsets.add(offset);
        offset = nextOffset;
      }
      return [...found.values()];
    },
  };
}

export async function discoverTelegramCandidates(query, options = {}) {
  const normalized = normalizeRadarQuery(query);
  if (normalized.length < 2) throw new RadarDiscoveryError("query_too_short");
  const providers = options.providers || [
    createSearxngTelegramProvider({ endpoint: options.searxngUrl, fetchImpl: options.fetchImpl }),
    createBingRssTelegramProvider({ fetchImpl: options.fetchImpl }),
    createDuckDuckGoTelegramProvider({ fetchImpl: options.fetchImpl }),
  ].filter(Boolean);
  if (providers.length === 0) throw new RadarDiscoveryError("provider_not_configured");

  const found = new Map();
  const failures = [];
  let completed = 0;
  const discoveryQueries = buildRadarDiscoveryQueries(normalized, options.expandedQueries);
  for (const discoveryQuery of discoveryQueries) {
    const settled = await Promise.allSettled(
      providers.map(async (provider) => ({ provider, candidates: await provider.search(discoveryQuery) })),
    );
    for (const result of settled) {
      if (result.status === "rejected") {
        failures.push(result.reason?.code || result.reason?.message || "provider_failed");
        continue;
      }
      completed += 1;
      for (const candidate of result.value.candidates || []) {
        if (!candidate?.handle) continue;
        const current = found.get(candidate.handle);
        found.set(candidate.handle, {
          ...(current || candidate),
          ...candidate,
          matchedQuery: discoveryQuery,
          matchedQueries: [...new Set([...(current?.matchedQueries || []), discoveryQuery])],
          providers: [...new Set([...(current?.providers || []), candidate.provider || result.value.provider.name])],
        });
      }
    }
  }
  if (completed === 0) {
    throw new RadarDiscoveryError("all_providers_unavailable", failures.join(", "));
  }
  return [...found.values()];
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

export function median(values) {
  const sorted = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}
