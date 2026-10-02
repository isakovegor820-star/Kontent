// Реестр источников, которым Аврора доверяет при выходе в интернет.
//
// Зачем отдельный модуль: до него «доверие» к сайту вычислялось эвристиками внутри
// поиска и нигде не было зафиксировано. Из-за этого RSS-новость с неизвестного домена
// и официальное опубликование закона попадали в один пул кандидатов. Здесь домен
// получает явный уровень доверия, а правила ниже решают, может ли факт с этого домена
// попасть в пост.
//
// Модуль обязан оставаться чистым: ни сети, ни БД, ни Redis. Он используется и в
// воркере, и в веб-процессе, и в тестах.

export const WEB_SOURCE_TIERS = Object.freeze([
  "official",
  "professional",
  "research",
  "media",
  "open",
]);

// Числовой вес нужен для сортировки и для порога «достаточно ли надёжен единственный
// источник». Порядок tiers намеренно совпадает с порядком убывания веса.
export const WEB_SOURCE_TIER_TRUST = Object.freeze({
  official: 95,
  professional: 85,
  research: 82,
  media: 70,
  open: 40,
});

export const WEB_SOURCE_TIER_LABELS = Object.freeze({
  official: "Официальный источник",
  professional: "Отраслевой источник",
  research: "Исследование",
  media: "СМИ",
  open: "Открытый источник",
});

export const WEB_SOURCE_CATEGORIES = Object.freeze([
  "law",
  "benchmark",
  "market",
  "technology",
  "statistics",
  "society",
]);

export const WEB_SOURCE_CATEGORY_LABELS = Object.freeze({
  law: "Право",
  benchmark: "Бенчмарк",
  market: "Рынок",
  technology: "Технологии",
  statistics: "Статистика",
  society: "Общество",
});

/**
 * @typedef {object} WebSourceEntry
 * @property {string} domain      registrable-домен без www, в нижнем регистре
 * @property {string} label       человекочитаемое название для UI
 * @property {"official"|"professional"|"research"|"media"|"open"} tier
 * @property {string[]} categories
 * @property {"RU"|"EN"} language
 * @property {string|null} publisher
 * @property {string[]} [aliases] дополнительные хосты того же издателя
 */

/** @type {ReadonlyArray<WebSourceEntry>} */
export const WEB_SOURCE_REGISTRY = Object.freeze([
  // ── Официальные российские источники: единственная опора для норм права ──────────
  {
    domain: "pravo.gov.ru",
    label: "Официальный интернет-портал правовой информации",
    tier: "official",
    categories: ["law"],
    language: "RU",
    publisher: "Государство",
    aliases: ["publication.pravo.gov.ru", "publication.pravo.gov.ru:443"],
  },
  {
    domain: "sozd.duma.gov.ru",
    label: "СОЗД Государственной Думы — законопроекты",
    tier: "official",
    categories: ["law"],
    language: "RU",
    publisher: "Государственная Дума",
  },
  {
    domain: "government.ru",
    label: "Правительство России",
    tier: "official",
    categories: ["law", "society", "market"],
    language: "RU",
    publisher: "Правительство РФ",
  },
  {
    domain: "kremlin.ru",
    label: "Президент России",
    tier: "official",
    categories: ["law", "society"],
    language: "RU",
    publisher: "Администрация Президента",
  },
  {
    domain: "cbr.ru",
    label: "Банк России",
    tier: "official",
    categories: ["statistics", "market"],
    language: "RU",
    publisher: "Банк России",
  },
  {
    domain: "rosstat.gov.ru",
    label: "Росстат",
    tier: "official",
    categories: ["statistics", "market"],
    language: "RU",
    publisher: "Росстат",
  },
  {
    domain: "nalog.gov.ru",
    label: "ФНС России",
    tier: "official",
    categories: ["law", "statistics"],
    language: "RU",
    publisher: "ФНС",
  },
  {
    domain: "digital.gov.ru",
    label: "Минцифры России",
    tier: "official",
    categories: ["law", "technology"],
    language: "RU",
    publisher: "Минцифры",
  },
  {
    domain: "fas.gov.ru",
    label: "ФАС России",
    tier: "official",
    categories: ["law", "market"],
    language: "RU",
    publisher: "ФАС",
  },
  {
    domain: "vsrf.ru",
    label: "Верховный Суд Российской Федерации",
    tier: "official",
    categories: ["law"],
    language: "RU",
    publisher: "Верховный Суд",
  },
  {
    domain: "ksrf.ru",
    label: "Конституционный Суд Российской Федерации",
    tier: "official",
    categories: ["law"],
    language: "RU",
    publisher: "Конституционный Суд",
  },
  {
    domain: "rkn.gov.ru",
    label: "Роскомнадзор",
    tier: "official",
    categories: ["law", "technology"],
    language: "RU",
    publisher: "Роскомнадзор",
  },
  {
    domain: "rospotrebnadzor.ru",
    label: "Роспотребнадзор",
    tier: "official",
    categories: ["law", "society"],
    language: "RU",
    publisher: "Роспотребнадзор",
  },
  {
    domain: "mintrud.gov.ru",
    label: "Минтруд России",
    tier: "official",
    categories: ["law", "society"],
    language: "RU",
    publisher: "Минтруд",
  },

  // ── Отраслевые правовые системы ────────────────────────────────────────────────
  {
    domain: "consultant.ru",
    label: "КонсультантПлюс",
    tier: "professional",
    categories: ["law"],
    language: "RU",
    publisher: "КонсультантПлюс",
  },
  {
    domain: "garant.ru",
    label: "Гарант",
    tier: "professional",
    categories: ["law"],
    language: "RU",
    publisher: "Гарант",
    aliases: ["rss.garant.ru"],
  },
  {
    domain: "pravo.ru",
    label: "Право.ru",
    tier: "professional",
    categories: ["law"],
    language: "RU",
    publisher: "Право.ru",
  },
  {
    domain: "zakon.ru",
    label: "Закон.ру",
    tier: "professional",
    categories: ["law"],
    language: "RU",
    publisher: "Закон.ру",
  },
  {
    domain: "audit-it.ru",
    label: "Аудит-it",
    tier: "professional",
    categories: ["law", "statistics"],
    language: "RU",
    publisher: "Аудит-it",
  },
  {
    domain: "gkh-konsultant.ru",
    label: "ЖКХ-консультант",
    tier: "professional",
    categories: ["law"],
    language: "RU",
    publisher: "ЖКХ-консультант",
  },

  // ── Отраслевые издания по нишам платформы ──────────────────────────────────────
  // Добавлены после боевого замера: эти домены регулярно попадали в выдачу по темам
  // каналов и отклонялись как weak_source. Все — узнаваемые отраслевые издания,
  // а не случайные сайты из выдачи.
  {
    domain: "vc.ru",
    label: "vc.ru",
    tier: "professional",
    categories: ["technology", "market"],
    language: "RU",
    publisher: "vc.ru",
  },
  {
    domain: "tadviser.ru",
    label: "TAdviser",
    tier: "professional",
    categories: ["technology", "market", "benchmark"],
    language: "RU",
    publisher: "TAdviser",
  },
  {
    domain: "cossa.ru",
    label: "Cossa",
    tier: "professional",
    categories: ["market", "technology"],
    language: "RU",
    publisher: "Cossa",
  },
  {
    domain: "sostav.ru",
    label: "Sostav",
    tier: "media",
    categories: ["market"],
    language: "RU",
    publisher: "Sostav",
  },
  {
    domain: "adindex.ru",
    label: "AdIndex",
    tier: "media",
    categories: ["market"],
    language: "RU",
    publisher: "AdIndex",
  },
  {
    domain: "klerk.ru",
    label: "Клерк",
    tier: "professional",
    categories: ["law", "statistics"],
    language: "RU",
    publisher: "Клерк",
  },
  {
    domain: "ppt.ru",
    label: "PPT.ru",
    tier: "professional",
    categories: ["law", "society"],
    language: "RU",
    publisher: "PPT.ru",
  },
  {
    domain: "nplus1.ru",
    label: "N+1",
    tier: "professional",
    categories: ["technology", "statistics"],
    language: "RU",
    publisher: "N+1",
  },
  {
    domain: "securitylab.ru",
    label: "SecurityLab",
    tier: "professional",
    categories: ["technology"],
    language: "RU",
    publisher: "SecurityLab",
  },
  {
    domain: "incrussia.ru",
    label: "Inc. Russia",
    tier: "media",
    categories: ["market", "society"],
    language: "RU",
    publisher: "Inc. Russia",
  },
  {
    domain: "thebell.io",
    label: "The Bell",
    tier: "media",
    categories: ["market", "society"],
    language: "RU",
    publisher: "The Bell",
  },

  // ── Исследования и бенчмарки ───────────────────────────────────────────────────
  {
    domain: "arxiv.org",
    label: "arXiv",
    tier: "research",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "Cornell University",
  },
  {
    domain: "nature.com",
    label: "Nature",
    tier: "research",
    categories: ["benchmark", "technology"],
    language: "EN",
    publisher: "Springer Nature",
  },
  {
    domain: "science.org",
    label: "Science",
    tier: "research",
    categories: ["benchmark", "technology"],
    language: "EN",
    publisher: "AAAS",
  },
  {
    domain: "ieee.org",
    label: "IEEE",
    tier: "research",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "IEEE",
    aliases: ["spectrum.ieee.org"],
  },
  {
    domain: "acm.org",
    label: "ACM",
    tier: "research",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "ACM",
  },
  {
    domain: "nist.gov",
    label: "NIST",
    tier: "official",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "U.S. Department of Commerce",
  },
  {
    domain: "oecd.org",
    label: "OECD",
    tier: "research",
    categories: ["statistics", "market", "benchmark"],
    language: "EN",
    publisher: "OECD",
  },
  {
    domain: "worldbank.org",
    label: "World Bank",
    tier: "research",
    categories: ["statistics", "market"],
    language: "EN",
    publisher: "World Bank",
  },
  {
    domain: "weforum.org",
    label: "World Economic Forum",
    tier: "research",
    categories: ["benchmark", "market"],
    language: "EN",
    publisher: "WEF",
  },
  {
    domain: "europa.eu",
    label: "European Union",
    tier: "official",
    categories: ["law", "statistics"],
    language: "EN",
    publisher: "European Union",
    aliases: ["eur-lex.europa.eu", "ec.europa.eu"],
  },
  {
    domain: "eurostat.ec.europa.eu",
    label: "Eurostat",
    tier: "official",
    categories: ["statistics", "market"],
    language: "EN",
    publisher: "European Commission",
  },
  {
    domain: "statista.com",
    label: "Statista",
    tier: "research",
    categories: ["statistics", "market", "benchmark"],
    language: "EN",
    publisher: "Statista",
  },
  {
    domain: "gartner.com",
    label: "Gartner",
    tier: "research",
    categories: ["benchmark", "technology", "market"],
    language: "EN",
    publisher: "Gartner",
  },
  {
    domain: "mckinsey.com",
    label: "McKinsey",
    tier: "research",
    categories: ["benchmark", "market"],
    language: "EN",
    publisher: "McKinsey & Company",
  },
  {
    domain: "gsmarena.com",
    label: "GSMArena",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "GSMArena",
  },
  {
    domain: "notebookcheck.net",
    label: "Notebookcheck",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "Notebookcheck",
  },
  {
    domain: "tomshardware.com",
    label: "Tom's Hardware",
    tier: "media",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "Future plc",
  },
  {
    domain: "arxiv-vanity.com",
    label: "arXiv Vanity",
    tier: "open",
    categories: ["technology"],
    language: "EN",
    publisher: null,
  },

  // ── Деловая и технологическая пресса ───────────────────────────────────────────
  {
    domain: "rbc.ru",
    label: "РБК",
    tier: "media",
    categories: ["market", "society", "law"],
    language: "RU",
    publisher: "РБК",
  },
  {
    domain: "vedomosti.ru",
    label: "Ведомости",
    tier: "media",
    categories: ["market", "society"],
    language: "RU",
    publisher: "Ведомости",
  },
  {
    domain: "kommersant.ru",
    label: "Коммерсантъ",
    tier: "media",
    categories: ["market", "society", "law"],
    language: "RU",
    publisher: "Коммерсантъ",
  },
  {
    domain: "tass.ru",
    label: "ТАСС",
    tier: "media",
    categories: ["society", "law", "market"],
    language: "RU",
    publisher: "ТАСС",
  },
  {
    domain: "interfax.ru",
    label: "Интерфакс",
    tier: "media",
    categories: ["society", "market", "law"],
    language: "RU",
    publisher: "Интерфакс",
  },
  {
    domain: "forbes.ru",
    label: "Forbes Россия",
    tier: "media",
    categories: ["market", "society"],
    language: "RU",
    publisher: "Forbes",
  },
  {
    domain: "cnews.ru",
    label: "CNews",
    tier: "media",
    categories: ["technology", "market"],
    language: "RU",
    publisher: "CNews",
  },
  {
    domain: "habr.com",
    label: "Хабр",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "RU",
    publisher: "Хабр",
  },
  {
    domain: "reuters.com",
    label: "Reuters",
    tier: "media",
    categories: ["market", "society", "technology"],
    language: "EN",
    publisher: "Thomson Reuters",
  },
  {
    domain: "techcrunch.com",
    label: "TechCrunch",
    tier: "media",
    categories: ["technology", "market"],
    language: "EN",
    publisher: "TechCrunch",
  },
  {
    domain: "theverge.com",
    label: "The Verge",
    tier: "media",
    categories: ["technology"],
    language: "EN",
    publisher: "Vox Media",
  },
  {
    domain: "arstechnica.com",
    label: "Ars Technica",
    tier: "media",
    categories: ["technology"],
    language: "EN",
    publisher: "Condé Nast",
  },

  // ── Первоисточники вендоров: релизы, а не пересказ ──────────────────────────────
  {
    domain: "openai.com",
    label: "OpenAI",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "OpenAI",
  },
  {
    domain: "anthropic.com",
    label: "Anthropic",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "Anthropic",
  },
  {
    domain: "blog.google",
    label: "Google Blog",
    tier: "professional",
    categories: ["technology"],
    language: "EN",
    publisher: "Google",
  },
  {
    domain: "github.com",
    label: "GitHub",
    tier: "professional",
    categories: ["technology", "benchmark"],
    language: "EN",
    publisher: "GitHub",
  },
  {
    domain: "w3.org",
    label: "W3C",
    tier: "official",
    categories: ["technology"],
    language: "EN",
    publisher: "W3C",
  },
  {
    domain: "ietf.org",
    label: "IETF",
    tier: "official",
    categories: ["technology"],
    language: "EN",
    publisher: "IETF",
  },
]);

const REGISTRY_INDEX = (() => {
  /** @type {Map<string, WebSourceEntry>} */
  const index = new Map();
  for (const entry of WEB_SOURCE_REGISTRY) {
    index.set(entry.domain, entry);
    for (const alias of entry.aliases || []) index.set(alias, entry);
  }
  return index;
})();

/** Домены, которые заведомо не являются источником факта: агрегаторы ссылок и поисковики. */
export const WEB_RESEARCH_NON_SOURCE_HOSTS = Object.freeze([
  "bing.com",
  "search.brave.com",
  "search.yahoo.com",
  "duckduckgo.com",
  "html.duckduckgo.com",
  "google.com",
  "yandex.ru",
  "ya.ru",
  "searx.be",
  "t.co",
  "bit.ly",
  "vk.com",
  "ok.ru",
  "t.me",
  "telegram.me",
  "youtube.com",
  "youtu.be",
  "pinterest.com",
  "facebook.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "reddit.com",
]);

/**
 * Приводит любой URL или хост к registrable-домену без www.
 * Возвращает null, если значение не похоже на хост.
 */
export function normalizeWebDomain(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  let hostname = raw;
  if (/^https?:\/\//iu.test(raw)) {
    try {
      hostname = new URL(raw).hostname;
    } catch {
      return null;
    }
  } else {
    hostname = raw.replace(/^\/+/u, "").split("/")[0];
  }
  hostname = hostname.toLowerCase().split("@").pop() || "";
  hostname = hostname.split(":")[0] || "";
  hostname = hostname.replace(/^www\./u, "").replace(/\.$/u, "");
  if (!hostname || !/^[a-z0-9.-]+$/u.test(hostname) || !hostname.includes(".")) return null;
  return hostname;
}

/**
 * Ищет домен в реестре, поднимаясь по поддоменам вверх.
 * `publication.pravo.gov.ru` → запись `pravo.gov.ru`.
 * @returns {WebSourceEntry|null}
 */
export function lookupWebSource(value) {
  const domain = normalizeWebDomain(value);
  if (!domain) return null;
  const direct = REGISTRY_INDEX.get(domain);
  if (direct) return direct;
  const parts = domain.split(".");
  for (let index = 1; index < parts.length - 1; index++) {
    const parent = parts.slice(index).join(".");
    const entry = REGISTRY_INDEX.get(parent);
    if (entry) return entry;
  }
  return null;
}

/**
 * Уровень доверия и признак «домен вообще не источник».
 * Незарегистрированный домен получает tier `open` — он годится для контекста,
 * но не может быть единственной опорой факта.
 */
export function resolveWebSource(value) {
  const domain = normalizeWebDomain(value);
  if (!domain) {
    return { domain: null, tier: "open", trust: WEB_SOURCE_TIER_TRUST.open, label: "Некорректный адрес", registered: false, nonSource: false, entry: null };
  }
  const nonSource = WEB_RESEARCH_NON_SOURCE_HOSTS.some(
    (host) => domain === host || domain.endsWith(`.${host}`),
  );
  const entry = lookupWebSource(domain);
  if (!entry) {
    return { domain, tier: "open", trust: WEB_SOURCE_TIER_TRUST.open, label: domain, registered: false, nonSource, entry: null };
  }
  return {
    domain: entry.domain,
    tier: entry.tier,
    trust: WEB_SOURCE_TIER_TRUST[entry.tier],
    label: entry.label,
    registered: true,
    nonSource,
    entry,
  };
}

/**
 * Домены заданной категории — из них планировщик собирает `site:`-запросы,
 * чтобы поисковик сразу возвращал первоисточники, а не пересказы.
 */
export function webSourceDomainsForCategory(category, options = {}) {
  const tiers = options.tiers ? new Set(options.tiers) : null;
  const language = options.language || null;
  return WEB_SOURCE_REGISTRY
    .filter((entry) => entry.categories.includes(category))
    .filter((entry) => !tiers || tiers.has(entry.tier))
    .filter((entry) => !language || entry.language === language)
    .sort((left, right) => WEB_SOURCE_TIER_TRUST[right.tier] - WEB_SOURCE_TIER_TRUST[left.tier])
    .map((entry) => entry.domain);
}

/**
 * Категория факта выводится из домена-источника, если он зарегистрирован.
 * Нужна, чтобы метка «Право» появлялась у поста автоматически.
 */
export function webSourceCategories(entry) {
  return Array.isArray(entry?.categories) ? entry.categories : [];
}

export const WEB_RESEARCH_OFFICIAL_TIERS = Object.freeze(["official"]);
export const WEB_RESEARCH_SOLE_SOURCE_TIERS = Object.freeze(["official", "professional", "research"]);
export const WEB_RESEARCH_NUMERIC_TIERS = Object.freeze(["official", "professional", "research", "media"]);
