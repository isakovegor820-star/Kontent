import { createHash } from "node:crypto";

export const SITE_PROBE_LIMITS = Object.freeze({ maxQuestions: 12, maxEngines: 3 });
export const SITE_PROBE_PROMPT_VERSION = "site-probe-v1";

function clean(value, max = 300) {
  return String(value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);
}

function normalizeQuestion(text) {
  return clean(text, 300).toLocaleLowerCase("ru-RU").replace(/[^a-zа-яё0-9\s]/giu, "").replace(/\s+/gu, " ").trim();
}

function questionKey(text) {
  return `q_${createHash("sha256").update(normalizeQuestion(text), "utf8").digest("hex").slice(0, 16)}`;
}

function ensureQuestionMark(text) {
  const cleaned = clean(text, 300).replace(/[.!…]+$/u, "");
  return /\?$/u.test(cleaned) ? cleaned : `${cleaned}?`;
}

/**
 * Реестр вопросов ниши для зонда. Вопросы никогда не содержат название бренда: зонд
 * измеряет, называют ли компанию без подсказки. Порядок детерминирован, чтобы прогоны
 * разных месяцев сравнивались по одним и тем же ключам.
 */
export function buildProbeQuestions({ profile, brandName = null, domain = null, audienceQuestions = [], maxQuestions = SITE_PROBE_LIMITS.maxQuestions, region = null }) {
  const forbidden = [brandName, domain].filter(Boolean).map((value) => String(value).toLocaleLowerCase("ru-RU"));
  const containsBrand = (text) => forbidden.some((needle) => needle && text.toLocaleLowerCase("ru-RU").includes(needle));
  const seen = new Set();
  const out = [];
  const push = (text, kind) => {
    const question = ensureQuestionMark(text);
    const normalized = normalizeQuestion(question);
    if (!normalized || normalized.length < 8 || seen.has(normalized) || containsBrand(question)) return;
    seen.add(normalized);
    out.push(Object.freeze({ key: questionKey(question), text: question, kind }));
  };

  for (const item of [...audienceQuestions].sort((a, b) => Number(b.occurrences || 0) - Number(a.occurrences || 0))) {
    push(item.question || item.text, "audience");
    if (out.length >= maxQuestions) return Object.freeze(out.slice(0, maxQuestions));
  }
  for (const gap of (profile?.gaps || []).filter((item) => item.kind === "question_without_answer")) {
    push(gap.label, "gap");
    if (out.length >= maxQuestions) return Object.freeze(out.slice(0, maxQuestions));
  }
  const where = region ? ` в ${clean(region, 60)}` : "";
  for (const topic of (profile?.topics || []).slice(0, 6)) {
    push(`Какие компании посоветуете по теме «${topic.label}»${where}`, "topic_recommendation");
    push(`Как выбрать специалиста по теме «${topic.label}»: на что смотреть`, "topic_selection");
    if (out.length >= maxQuestions) break;
  }
  return Object.freeze(out.slice(0, maxQuestions));
}

export function probeSystemPrompt() {
  return [
    "Ты — поисковый ассистент. Отвечай на русском, кратко и конкретно.",
    "Если уместно, называй конкретные компании, бренды и сайты (с доменами), которые обычно рекомендуют по этому вопросу.",
    "Не задавай уточняющих вопросов. Не более 180 слов.",
  ].join("\n");
}

const HOST_PATTERN = /\b(?:https?:\/\/)?(?:www\.)?((?:[a-z0-9-]+\.)+(?:ru|com|net|org|su|рф|io|by|kz|ua|de|uk|info|biz|pro|online|site|store|shop|clinic|dental|legal|expert))\b/giu;

function normalizeHost(value) {
  return String(value).toLocaleLowerCase("ru-RU").replace(/^www\./u, "");
}

function brandPattern(brandName) {
  const cleaned = clean(brandName, 120).replace(/[«»"']/gu, "").trim();
  if (cleaned.length < 3) return null;
  const escaped = cleaned.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&").replace(/\s+/gu, "\\s+");
  return new RegExp(`(?<![a-zа-яё0-9])${escaped}(?![a-zа-яё0-9])`, "iu");
}

/**
 * Детерминированное извлечение упоминаний: бренд — по названию (без окончаний), сайт — по
 * домену, конкуренты — по известным названиям из разведки и по чужим доменам в ответе.
 */
export function extractMentions({ answer, brandName = null, domain = null, competitorNames = [] }) {
  const text = String(answer ?? "");
  const lower = text.toLocaleLowerCase("ru-RU");
  const ownDomain = domain ? normalizeHost(domain) : null;
  const brand = brandPattern(brandName);
  const brandMentioned = Boolean(brand && brand.test(text));
  const hosts = new Set();
  for (const match of text.matchAll(HOST_PATTERN)) hosts.add(normalizeHost(match[1]));
  const siteCited = Boolean(ownDomain && [...hosts].some((host) => host === ownDomain || host.endsWith(`.${ownDomain}`)));
  const competitors = new Map();
  for (const host of hosts) {
    if (ownDomain && (host === ownDomain || host.endsWith(`.${ownDomain}`))) continue;
    competitors.set(host, { name: host, kind: "domain" });
  }
  for (const rawName of competitorNames) {
    const name = clean(rawName, 120);
    if (name.length < 3) continue;
    const pattern = brandPattern(name);
    if (pattern && pattern.test(text) && !(brand && normalizeQuestion(name) === normalizeQuestion(brandName))) {
      competitors.set(name.toLocaleLowerCase("ru-RU"), { name, kind: "known_competitor" });
    }
  }
  return Object.freeze({
    brandMentioned,
    siteCited,
    competitors: Object.freeze([...competitors.values()].slice(0, 12)),
    excerpt: lower ? clean(text, 600) : "",
  });
}

/** Сводка прогона: доля вопросов с упоминанием и рейтинг конкурентов. */
export function summarizeProbeRun(rows) {
  const answered = rows.filter((row) => row.status === "answered");
  const byQuestion = new Map();
  for (const row of answered) {
    const entry = byQuestion.get(row.question_key ?? row.questionKey) || { brand: false, cited: false };
    entry.brand = entry.brand || Boolean(row.brand_mentioned ?? row.brandMentioned);
    entry.cited = entry.cited || Boolean(row.site_cited ?? row.siteCited);
    byQuestion.set(row.question_key ?? row.questionKey, entry);
  }
  const competitorCounts = new Map();
  for (const row of answered) {
    const list = row.competitors_mentioned ?? row.competitors ?? [];
    for (const item of list) {
      const name = String(item?.name || item).toLocaleLowerCase("ru-RU");
      if (!name) continue;
      const entry = competitorCounts.get(name) || { name: item?.name || item, mentions: 0 };
      entry.mentions += 1;
      competitorCounts.set(name, entry);
    }
  }
  return Object.freeze({
    questions: byQuestion.size,
    answers: answered.length,
    skipped: rows.filter((row) => row.status === "skipped_budget").length,
    failed: rows.filter((row) => row.status === "failed").length,
    brandMentioned: [...byQuestion.values()].filter((entry) => entry.brand).length,
    siteCited: [...byQuestion.values()].filter((entry) => entry.cited).length,
    engines: [...new Set(rows.map((row) => row.engine))],
    competitorsTop: Object.freeze([...competitorCounts.values()].sort((a, b) => b.mentions - a.mentions || a.name.localeCompare(b.name)).slice(0, 8)),
  });
}
