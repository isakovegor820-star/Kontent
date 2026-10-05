// Контракт «факт из интернета». Здесь живут ворота достоверности: правило
// «нет ссылки — нет факта» доведено до «нет дословной цитаты в скачанном тексте —
// нет факта». Модель не может ничего утверждать от себя: она обязана вернуть цитату,
// а модуль проверяет её наличие в реально полученной странице.
//
// Модуль чистый: ни сети, ни БД, ни Redis. Всё внешнее передаётся аргументами,
// поэтому ворота проверяются тестами без единого сетевого запроса.

import { resolveWebSource, WEB_RESEARCH_SOLE_SOURCE_TIERS, WEB_SOURCE_TIER_LABELS } from "./web-research-sources.mjs";

export const WEB_FINDING_KINDS = Object.freeze([
  "law",
  "benchmark",
  "market",
  "statistics",
  "event",
  "statement",
]);

export const WEB_FINDING_KIND_LABELS = Object.freeze({
  law: "Норма права",
  benchmark: "Бенчмарк",
  market: "Рынок",
  statistics: "Статистика",
  event: "Событие",
  statement: "Заявление",
});

/**
 * Юридический статус нормы. Для юридической темы это не украшение, а условие
 * корректности: «законопроект внесён» и «закон вступил в силу» — разные новости,
 * и перепутать их значит потерять доверие читателя-юриста.
 */
export const LEGAL_STATUSES = Object.freeze([
  "in_force",
  "signed",
  "adopted",
  "bill_second_reading",
  "bill_first_reading",
  "bill_submitted",
  "bill_drafted",
  "public_discussion",
  "not_normative",
  "unknown",
]);

export const LEGAL_STATUS_LABELS = Object.freeze({
  in_force: "Закон вступил в силу",
  signed: "Закон подписан",
  adopted: "Закон принят",
  bill_second_reading: "Законопроект прошёл второе чтение",
  bill_first_reading: "Законопроект принят в первом чтении",
  bill_submitted: "Законопроект внесён в Госдуму",
  bill_drafted: "Законопроект разрабатывается",
  public_discussion: "Идёт обсуждение инициативы",
  not_normative: "Не норма права",
  unknown: "Статус не определён",
});

/** Статусы, которые можно публиковать как утверждение о действующем праве. */
export const LEGAL_STATUSES_IN_FORCE = Object.freeze(["in_force", "signed", "adopted"]);

/** Статусы-законопроекты: публиковать можно, но только с явной пометкой. */
export const LEGAL_STATUSES_PENDING = Object.freeze([
  "bill_second_reading",
  "bill_first_reading",
  "bill_submitted",
  "bill_drafted",
  "public_discussion",
]);

export const WEB_FINDING_REJECTION_LABELS = Object.freeze({
  empty_claim: "Пустое утверждение",
  claim_too_long: "Утверждение слишком длинное",
  missing_url: "Нет ссылки на источник",
  bad_url: "Ссылка не является адресом страницы",
  non_source_domain: "Домен не является источником (поисковик, агрегатор или соцсеть)",
  missing_quote: "Нет дословной цитаты из источника",
  quote_not_in_source: "Цитата не найдена в скачанном тексте источника",
  source_too_short: "Страница источника слишком короткая для проверки",
  missing_published_at: "Не известна дата публикации",
  bad_published_at: "Дата публикации не разобрана",
  future_dated_source: "Дата публикации в будущем",
  stale_source: "Источник устарел для этого типа факта",
  missing_legal_status: "Для нормы права не определён юридический статус",
  unknown_legal_status: "Юридический статус нормы не определён",
  number_not_in_source: "Число из утверждения не найдено в источнике",
  weak_source: "Единственный источник недостаточно надёжен и нет подтверждения",
  page_blocked: "Страница не отдала содержимое: отказ доступа или проверка бота",
});

/**
 * Отдала ли страница содержимое или страницу-заглушку.
 *
 * `developers.openai.com` ответил «You don't have permission to access…», и этот текст
 * попадал в факты как утверждение со ссылкой на источник. Признаки отказа проверяются
 * только в начале текста и только на короткой странице: в длинной статье про блокировки
 * и капчу эти же слова встречаются законно.
 */
export function looksLikeBlockedPage(text) {
  const value = String(text ?? "").replace(/\s+/gu, " ").trim();
  if (!value) return false;
  const head = value.slice(0, 600).toLocaleLowerCase("ru-RU");
  const denial = /(?:you don'?t have permission to access|access denied|403 forbidden|enable javascript and cookies to continue|checking your browser|just a moment|attention required|проверка.{0,20}(?:робот|бот)|доступ (?:запрещён|ограничен)|подтвердите, что вы не робот)/iu;
  if (!denial.test(head)) return false;
  return value.length < 1_500;
}

export class WebFindingRejected extends Error {
  constructor(code, detail) {
    super(WEB_FINDING_REJECTION_LABELS[code] || code);
    this.name = "WebFindingRejected";
    this.code = code;
    this.detail = detail || null;
  }
}

const DAY_MS = 86_400_000;
const MAX_CLOCK_SKEW_MS = 36 * 60 * 60 * 1000;

/** Максимальный возраст источника по типу факта: у нормы права и бенчмарка он больше. */
export const WEB_FINDING_MAX_AGE_DAYS = Object.freeze({
  law: 1_095,
  benchmark: 730,
  market: 365,
  statistics: 730,
  event: 60,
  statement: 90,
});

const MIN_SOURCE_TEXT_LENGTH = 200;
export const MAX_CLAIM_LENGTH = 600;
export const WEB_FINDING_MIN_QUOTE_LENGTH = 24;

const ZERO_WIDTH = /[\u200b-\u200d\ufeff\u00ad]/gu;
const DASHES = /[\u2010-\u2015\u2212]/gu;
const QUOTES = /[\u2018\u2019\u201a\u201b\u2032\u201c\u201d\u201e\u2033«»]/gu;

/**
 * Нормализация для сравнения цитаты с текстом страницы. Приводит типографику
 * к единому виду, потому что модель почти всегда переписывает кавычки и тире.
 *
 * `№` заменяется до NFKC: NFKC разворачивает знак номера в латинское «No» и ломает
 * распознавание ссылок на законопроекты («законопроект № 123456-8»).
 */
export function normalizeForMatch(value) {
  return String(value ?? "")
    .replace(/\u2116/gu, "#")
    .normalize("NFKC")
    .replace(ZERO_WIDTH, "")
    .replace(DASHES, "-")
    .replace(QUOTES, '"')
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/gu, "е")
    .replace(/\s+/gu, " ")
    .trim();
}

/** Убирает разметку и скрипты, чтобы цитата искалась в видимом тексте страницы. */
export function sourceTextFromHtml(html) {
  let text = String(html ?? "");
  if (!text) return "";
  text = text
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/giu, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/giu, " ")
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/<\/(?:p|div|li|tr|h[1-6]|section|article|blockquote)>/giu, "\n")
    .replace(/<br\s*\/?>/giu, "\n")
    .replace(/<[^>]+>/gu, " ");
  return decodeHtmlEntities(text).replace(/[ \t\u00a0]+/gu, " ").replace(/\n{3,}/gu, "\n\n").trim();
}

const ENTITIES = Object.freeze({
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"', deg: "°",
});

export function decodeHtmlEntities(value) {
  return String(value ?? "").replace(/&(#x?[0-9a-f]+|[a-z]+);/giu, (match, entity) => {
    const key = String(entity).toLowerCase();
    if (key.startsWith("#x")) {
      const code = Number.parseInt(key.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    if (key.startsWith("#")) {
      const code = Number.parseInt(key.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, key) ? ENTITIES[key] : match;
  });
}

/** Проверка, что цитата присутствует в скачанном тексте дословно (после нормализации). */
export function verifyQuoteInSource(quote, sourceText) {
  const needle = normalizeForMatch(quote);
  if (!needle || needle.length < WEB_FINDING_MIN_QUOTE_LENGTH) {
    return { found: false, reason: "missing_quote" };
  }
  const haystack = normalizeForMatch(sourceText);
  if (!haystack) return { found: false, reason: "source_too_short" };
  if (haystack.includes(needle)) return { found: true, reason: null };
  // Модель иногда склеивает два соседних предложения через «…». Пробуем половинки.
  const parts = needle.split(/\s*(?:\.\.\.|…)\s*/u).filter((part) => part.length >= WEB_FINDING_MIN_QUOTE_LENGTH);
  if (parts.length > 1 && parts.every((part) => haystack.includes(part))) {
    return { found: true, reason: null };
  }
  return { found: false, reason: "quote_not_in_source" };
}

const NUMBER_PATTERN = /\d[\d\s\u00a0.,]*\d|\d/gu;

/** Числа, которые встретились в утверждении: нужны для сверки с источником. */
export function extractClaimNumbers(value) {
  const matches = String(value ?? "").match(NUMBER_PATTERN) || [];
  const seen = new Set();
  const numbers = [];
  for (const match of matches) {
    const digits = match.replace(/[^\d]/gu, "");
    if (digits.length < 2) continue; // одиночные цифры — это «1 чтение», «9 месяцев», шум
    if (digits.length > 15) continue;
    if (seen.has(digits)) continue;
    seen.add(digits);
    numbers.push(digits);
  }
  return numbers;
}

export function hasNumericClaim(value) {
  return extractClaimNumbers(value).length > 0;
}

function digitsPresentIn(digits, haystackDigits) {
  return haystackDigits.includes(digits);
}

/**
 * Определяет юридический статус по тексту источника. Возвращает наиболее
 * сильное найденное утверждение: «вступил в силу» важнее, чем «обсуждается».
 */
export function classifyLegalStatus(value) {
  const text = normalizeForMatch(value);
  if (!text) return { status: "unknown", confidence: 0, marker: null };
  const rules = [
    ["in_force", /(вступил[аи]? в силу|вступает в силу|начал[аи]? действовать|действует с)/u],
    ["signed", /(подписал[аи]? (?:федеральный )?закон|закон подписан|подписание закона)/u],
    ["adopted", /(?:федеральный )?закон (?:был )?принят|принят государственной думой|одобрен советом федерации/u],
    ["in_force", /федеральный закон (?:от )?\d{2}\.\d{2}\.\d{4} #? ?\d+[-–]фз/u],
    ["bill_second_reading", /(второ[ем] чтени|принят во втором чтении)/u],
    ["bill_first_reading", /(перво[ем] чтени|принят в первом чтении)/u],
    ["bill_submitted", /(внес[её]н в государственную думу|внес[её]н в госдуму|законопроект #? ?\d+)/u],
    ["bill_drafted", /(разрабатыва(?:ется|ют) законопроект|подготовлен[а]? законопроект|проект закона разрабатыва)/u],
    ["public_discussion", /(обсужда(?:ется|ют) (?:законопроект|инициативу|поправк)|публичн(?:ое|ые) обсуждени|предлагается (?:внести|закрепить|разрешить)|инициатива о)/u],
  ];
  for (const [status, pattern] of rules) {
    const match = text.match(pattern);
    if (match) return { status, confidence: 0.8, marker: match[0] };
  }
  if (/законопроект/u.test(text)) return { status: "bill_drafted", confidence: 0.5, marker: "законопроект" };
  return { status: "not_normative", confidence: 0.3, marker: null };
}

function parseHttpUrl(value) {
  try {
    const url = new URL(String(value ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    if (!url.hostname) return null;
    return url;
  } catch {
    return null;
  }
}

export function webFindingFingerprint(finding) {
  const parts = [
    String(finding?.kind ?? ""),
    normalizeForMatch(finding?.claim).slice(0, 240),
    String(finding?.source?.url ?? ""),
  ];
  // Не криптография, а устойчивый ключ дедупликации: длина и сумма кодов не дают
  // коллизий на реальных объёмах и не тянут node:crypto в чистый модуль.
  let hash = 0;
  const input = parts.join("\n");
  for (let index = 0; index < input.length; index++) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return `wf-${Math.abs(hash).toString(36)}-${input.length.toString(36)}`;
}

/**
 * Главные ворота. Либо факт проходит целиком, либо возвращается код отказа —
 * третьего состояния нет, поэтому «серые» данные не могут утечь в пост.
 *
 * @param {object} input
 * @param {string} input.kind
 * @param {string} input.claim      утверждение, которое попадёт в пост
 * @param {string} input.quote      дословная цитата из источника
 * @param {string} input.sourceUrl
 * @param {string} input.sourceText полный скачанный текст страницы
 * @param {string} [input.publishedAt]
 * @param {string} [input.legalStatus]
 * @param {string} [input.title]
 * @param {string} [input.language]
 * @param {Array<{url: string}>} [input.corroborating]
 * @param {number} [input.now]
 */
export function evaluateWebFinding(input, options = {}) {
  const now = Number(options.now ?? input?.now) || Date.now();
  const kind = WEB_FINDING_KINDS.includes(input?.kind) ? input.kind : "statement";
  const claim = String(input?.claim ?? "").replace(/\s+/gu, " ").trim();

  if (!claim) return reject("empty_claim");
  if (claim.length > MAX_CLAIM_LENGTH) return reject("claim_too_long", { length: claim.length });

  const url = parseHttpUrl(input?.sourceUrl);
  if (!url) return reject(String(input?.sourceUrl ?? "").trim() ? "bad_url" : "missing_url");

  const source = resolveWebSource(url.hostname);
  if (source.nonSource) return reject("non_source_domain", { domain: source.domain });

  const sourceText = String(input?.sourceText ?? "");
  if (sourceText.trim().length < MIN_SOURCE_TEXT_LENGTH) {
    return reject("source_too_short", { length: sourceText.trim().length });
  }

  const quote = String(input?.quote ?? "").replace(/\s+/gu, " ").trim();
  if (!quote) return reject("missing_quote");
  const quoteCheck = verifyQuoteInSource(quote, sourceText);
  if (!quoteCheck.found) return reject(quoteCheck.reason || "quote_not_in_source");

  // Дата публикации обязательна по умолчанию: именно она не даёт старой новости
  // выглядеть свежей. Чат — единственное исключение: там Аврора отвечает человеку
  // здесь и сейчас, и требование даты просто выбросило бы половину интернета.
  // Разрешая факт без даты, модуль честно помечает его `dateKnown: false`, и промпт
  // обязывает модель не приписывать такому факту никаких дат.
  const allowMissingPublishedAt = options.allowMissingPublishedAt === true;
  const publishedRaw = input?.publishedAt;
  let publishedMs = now;
  let dateKnown = Boolean(publishedRaw);
  if (!publishedRaw) {
    if (!allowMissingPublishedAt) return reject("missing_published_at");
  } else {
    publishedMs = Date.parse(String(publishedRaw));
    if (!Number.isFinite(publishedMs)) {
      if (!allowMissingPublishedAt) return reject("bad_published_at", { publishedAt: String(publishedRaw) });
      publishedMs = now;
      dateKnown = false;
    }
  }
  if (dateKnown && publishedMs > now + MAX_CLOCK_SKEW_MS) {
    return reject("future_dated_source", { publishedAt: new Date(publishedMs).toISOString() });
  }

  const maxAgeDays = Number(options.maxAgeDays ?? WEB_FINDING_MAX_AGE_DAYS[kind]) || WEB_FINDING_MAX_AGE_DAYS.statement;
  const ageDays = dateKnown ? (now - publishedMs) / DAY_MS : 0;
  if (dateKnown && ageDays > maxAgeDays) {
    return reject("stale_source", { ageDays: Math.round(ageDays), maxAgeDays });
  }

  let legalStatus = String(input?.legalStatus ?? "").trim();
  if (kind === "law") {
    if (!legalStatus) return reject("missing_legal_status");
    if (!LEGAL_STATUSES.includes(legalStatus)) return reject("unknown_legal_status", { legalStatus });
    if (legalStatus === "unknown") return reject("unknown_legal_status", { legalStatus });
  } else if (legalStatus && !LEGAL_STATUSES.includes(legalStatus)) {
    legalStatus = "";
  }

  // Числа в утверждении должны существовать в источнике: это ловит выдуманные
  // проценты и суммы, которые модель подставляет «для убедительности».
  const numbers = extractClaimNumbers(claim);
  if (numbers.length) {
    const haystack = normalizeForMatch(sourceText).replace(/[^\d]/gu, "");
    const missing = numbers.filter((digits) => !digitsPresentIn(digits, haystack));
    if (missing.length) return reject("number_not_in_source", { numbers: missing });
  }

  const corroborating = Array.isArray(input?.corroborating) ? input.corroborating : [];
  const corroboratingDomains = new Set();
  for (const item of corroborating) {
    const itemUrl = parseHttpUrl(item?.url);
    if (!itemUrl) continue;
    const itemSource = resolveWebSource(itemUrl.hostname);
    if (itemSource.nonSource || !itemSource.domain) continue;
    if (itemSource.domain === source.domain) continue;
    corroboratingDomains.add(itemSource.domain);
  }
  const soleSourceAllowed = WEB_RESEARCH_SOLE_SOURCE_TIERS.includes(source.tier);
  // Открытый источник без подтверждения по умолчанию отбрасывается: на его основе
  // нельзя месяцами показывать автору «возможность». Чат — другое дело: там человек
  // сам читает ответ и видит каждую ссылку, а реестр из сорока доменов никогда не
  // покроет нишевую тему. Поэтому чат пропускает такой источник, но факт остаётся
  // помеченным как неподтверждённый, и промпт требует атрибуции «по данным источника».
  const allowOpenSources = options.allowOpenSources === true;
  if (!soleSourceAllowed && corroboratingDomains.size === 0 && !allowOpenSources) {
    return reject("weak_source", { domain: source.domain, tier: source.tier });
  }
  const sourceIsWeak = !soleSourceAllowed && corroboratingDomains.size === 0;

  const statusLabel = kind === "law" ? LEGAL_STATUS_LABELS[legalStatus] : null;
  const trusted = source.tier !== "open" && (soleSourceAllowed || corroboratingDomains.size > 0);

  const finding = {
    kind,
    claim,
    quote,
    title: String(input?.title ?? "").replace(/\s+/gu, " ").trim().slice(0, 240) || null,
    language: input?.language === "EN" ? "EN" : "RU",
    legalStatus: legalStatus || null,
    legalStatusLabel: statusLabel,
    source: {
      url: url.toString(),
      domain: source.domain,
      label: source.label,
      tier: source.tier,
      tierLabel: WEB_SOURCE_TIER_LABELS[source.tier] || "Открытый источник",
      trust: source.trust,
      registered: source.registered,
    },
    publishedAt: dateKnown ? new Date(publishedMs).toISOString() : null,
    dateKnown,
    retrievedAt: new Date(now).toISOString(),
    ageDays: Math.max(0, Math.round(ageDays)),
    numbers,
    corroboratingDomains: [...corroboratingDomains],
    corroborationCount: corroboratingDomains.size,
    trusted,
    /** Источник вне реестра и без независимого подтверждения: ссылаться можно, верить на слово — нет. */
    unverifiedSource: sourceIsWeak,
  };
  return { ok: true, finding: { ...finding, fingerprint: webFindingFingerprint(finding) } };
}

function reject(code, detail) {
  return { ok: false, code, reason: WEB_FINDING_REJECTION_LABELS[code] || code, detail: detail || null };
}

export function buildWebFinding(input, options = {}) {
  const result = evaluateWebFinding(input, options);
  if (!result.ok) throw new WebFindingRejected(result.code, result.detail);
  return result.finding;
}

/**
 * Готовая подпись источника для поста. Существует, чтобы формат ссылки был
 * одинаковым в Автопилоте, «Сегодня» и Инфоповодах.
 */
export function webFindingCitation(finding) {
  if (!finding?.source?.url) return "";
  const title = finding.source.label || finding.source.domain || "Источник";
  const prefix = finding.kind === "law" && finding.legalStatusLabel ? `${finding.legalStatusLabel}. ` : "";
  const date = finding.publishedAt ? ` (${finding.publishedAt.slice(0, 10)})` : "";
  return `${prefix}${title}${date}\n${finding.source.url}`;
}
