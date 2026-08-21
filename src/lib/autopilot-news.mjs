import { createHash } from "node:crypto";

export const AUTOPILOT_NEWS_MAX_AGE_DAYS = 7;
export const AUTOPILOT_NEWS_SOURCE_LIMIT = 6;
export const AUTOPILOT_NEWS_CANDIDATE_LIMIT = 36;

const DAY_MS = 86_400_000;
const MAX_FUTURE_CLOCK_SKEW_MS = 10 * 60_000;
const EVENT_SIGNAL = /(?:будет|пройд[её]т|состоится|запланирован|ожидается|анонсировал|объявил|запускает|вступит\s+в\s+силу)/iu;

const normalize = (value) => String(value ?? "")
  .normalize("NFKC")
  .toLocaleLowerCase("ru-RU")
  .replace(/ё/gu, "е")
  .replace(/[^a-zа-я0-9]+/giu, " ")
  .replace(/\s+/gu, " ")
  .trim();

const contentTokens = (value) => new Set(
  normalize(value)
    .split(" ")
    .filter((token) => token.length >= 4),
);

function safeHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function normalizeAutopilotNewsSources(value, limit = AUTOPILOT_NEWS_SOURCE_LIMIT) {
  const seen = new Set();
  const sources = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const id = String(raw?.id ?? "").trim().slice(0, 64);
    const title = String(raw?.title ?? "").trim().slice(0, 160);
    const url = safeHttpUrl(raw?.url);
    if (!id || !title || !url || seen.has(url)) continue;
    seen.add(url);
    sources.push({
      id,
      title,
      url,
      category: String(raw?.category ?? "").trim().slice(0, 80) || null,
      language: raw?.language === "EN" ? "EN" : "RU",
      score: Math.max(0, Math.min(100, Number(raw?.score) || 0)),
      reason: String(raw?.reason ?? "").trim().slice(0, 240) || null,
    });
    if (sources.length >= Math.max(1, Number(limit) || AUTOPILOT_NEWS_SOURCE_LIMIT)) break;
  }
  return sources;
}

function lexicalScore(value, contextTokens) {
  if (!contextTokens.size) return 0;
  const candidate = contentTokens(value);
  let matches = 0;
  for (const token of contextTokens) if (candidate.has(token)) matches++;
  return Math.min(30, matches * 6);
}

function candidateId(sourceId, guid, link, title) {
  const digest = createHash("sha256")
    .update(`${sourceId}\n${guid || link || title}`, "utf8")
    .digest("hex")
    .slice(0, 20);
  return `news-${digest}`;
}

/**
 * Convert already parsed RSS payloads into a fresh, deduplicated editorial pool.
 * Fetching stays outside this pure module so SSRF checks and timeouts remain owned by
 * the worker's safe HTTP layer.
 */
export function buildAutopilotNewsCandidates(
  sourceResults,
  {
    context = "",
    now = Date.now(),
    maxAgeDays = AUTOPILOT_NEWS_MAX_AGE_DAYS,
    limit = AUTOPILOT_NEWS_CANDIDATE_LIMIT,
  } = {},
) {
  const nowMs = Number(now) || Date.now();
  const oldest = nowMs - Math.max(1, Number(maxAgeDays) || AUTOPILOT_NEWS_MAX_AGE_DAYS) * DAY_MS;
  const contextTokens = contentTokens(context);
  const seen = new Set();
  const candidates = [];

  for (const result of Array.isArray(sourceResults) ? sourceResults : []) {
    const source = normalizeAutopilotNewsSources([result?.source], 1)[0];
    if (!source) continue;
    for (const item of Array.isArray(result?.items) ? result.items : []) {
      const title = String(item?.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 240);
      const summary = String(item?.summary ?? "").replace(/\s+/gu, " ").trim().slice(0, 4_000);
      const url = safeHttpUrl(item?.link);
      const publishedMs = Date.parse(String(item?.publishedAt ?? ""));
      if (!title || !summary || !url || !Number.isFinite(publishedMs)) continue;
      if (publishedMs < oldest || publishedMs > nowMs + MAX_FUTURE_CLOCK_SKEW_MS) continue;

      const duplicateKey = normalize(title).slice(0, 180);
      if (!duplicateKey || seen.has(duplicateKey) || seen.has(url)) continue;
      seen.add(duplicateKey);
      seen.add(url);

      const ageDays = Math.max(0, (nowMs - publishedMs) / DAY_MS);
      const freshness = Math.max(0, 35 - ageDays * 5);
      const relevance = lexicalScore(`${title} ${summary}`, contextTokens);
      const eventBonus = EVENT_SIGNAL.test(`${title} ${summary}`) ? 8 : 0;
      const depthBonus = summary.length >= 240 ? 5 : summary.length >= 120 ? 2 : 0;
      const score = freshness + relevance + eventBonus + depthBonus + source.score / 5;
      const text = `${title}. ${summary}`.trim().slice(0, 4_500);

      candidates.push({
        id: candidateId(source.id, item?.guid, url, title),
        kind: "news",
        title,
        text,
        url,
        sourceId: source.id,
        sourceTitle: source.title,
        sourceCategory: source.category,
        sourceReason: source.reason,
        publishedAt: new Date(publishedMs).toISOString(),
        score,
      });
    }
  }

  return candidates
    .sort((left, right) => right.score - left.score || Date.parse(right.publishedAt) - Date.parse(left.publishedAt))
    .slice(0, Math.max(1, Number(limit) || AUTOPILOT_NEWS_CANDIDATE_LIMIT));
}

export function autopilotNewsEvidence(candidate) {
  if (!candidate || candidate.kind !== "news") return null;
  const url = safeHttpUrl(candidate.url);
  const id = String(candidate.id ?? "").trim().slice(0, 64);
  const text = String(candidate.text ?? "").trim().slice(0, 8_000);
  if (!id || !text || !url) return null;
  return {
    id,
    text,
    kind: "news",
    title: String(candidate.sourceTitle || candidate.title || "Источник").trim().slice(0, 180),
    url,
    publishedAt: String(candidate.publishedAt || ""),
  };
}

export function appendAutopilotSourceFooter(text, sources, maxChars = 4_000) {
  const value = String(text ?? "").trim();
  const external = (Array.isArray(sources) ? sources : []).find((source) => safeHttpUrl(source?.url));
  if (!value || !external) return value;
  const title = String(external.title || "Источник").trim().slice(0, 120) || "Источник";
  const url = safeHttpUrl(external.url);
  if (!url || value.includes(url)) return value;
  const footer = `Источник: ${title}\n${url}`;
  const maximum = Math.max(500, Number(maxChars) || 4_000);
  if (value.length + footer.length + 2 <= maximum) return `${value}\n\n${footer}`;

  const available = Math.max(1, maximum - footer.length - 2);
  const clipped = value.slice(0, available);
  const boundary = Math.max(clipped.lastIndexOf("\n\n"), clipped.lastIndexOf(". "));
  const body = (boundary >= Math.floor(available * 0.65) ? clipped.slice(0, boundary + 1) : clipped).trim();
  return `${body}\n\n${footer}`.slice(0, maximum).trim();
}
