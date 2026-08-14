/**
 * Редакционный каталог RSS-источников.
 *
 * Это не пользовательские feeds и не таблица БД: каталог версионируется вместе с
 * приложением, поэтому сломанную ссылку можно заменить одной правкой. Ручное добавление
 * через `/api/rss` проверяет URL живым запросом. Автоматический
 * bootstrap берёт адреса только из этого закрытого каталога, поэтому пользовательский
 * URL не может попасть в фоновый запрос в обход SSRF-защиты.
 */

export type RssCatalogCategory =
  | "Технологии"
  | "Бизнес"
  | "Финансы"
  | "Право"
  | "Маркетинг"
  | "Наука";

export type RssCatalogLanguage = "RU" | "EN";

type CatalogRecord = {
  id: string;
  title: string;
  url: string;
  description: string;
  category: RssCatalogCategory;
  language: RssCatalogLanguage;
  featured: number;
  tags?: string[];
};

export type RankedRssSource = Omit<CatalogRecord, "featured" | "tags"> & {
  score: number;
  recommended: boolean;
  reason: string;
};

export type PublicLegalRssSource = Pick<
  CatalogRecord,
  "id" | "title" | "url" | "description" | "language"
> & { category: "Юридические источники"; access: "public_rss" };

const CATEGORY_TERMS: Record<RssCatalogCategory, string[]> = {
  "Технологии": [
    "технолог", "it", "айти", "разработ", "программ", "код", "стартап", "saas",
    "нейросет", "искусственн", "машинн", "данн", "кибер", "digital", "цифров",
  ],
  "Бизнес": [
    "бизнес", "предприним", "компан", "руковод", "менедж", "продаж", "рынок",
    "стартап", "продукт", "управлен", "hr", "карьер", "работодат",
  ],
  "Финансы": [
    "финанс", "эконом", "деньг", "инвест", "банк", "кредит", "бирж", "валют",
    "бюджет", "налог", "бухгалтер", "капитал", "страхов",
  ],
  "Право": [
    "прав", "юри", "закон", "суд", "договор", "банкрот", "налог", "адвокат",
    "нотари", "комплаенс", "регулирован", "норматив",
  ],
  "Маркетинг": [
    "маркет", "реклам", "smm", "смм", "контент", "бренд", "медиа", "seo", "сео",
    "копирай", "продвиж", "коммуникац", "пиар", "pr", "дизайн",
  ],
  "Наука": [
    "наук", "исследован", "медицин", "здоров", "биолог", "физик", "хими", "космос",
    "психолог", "образован", "обучен", "эколог", "истори",
  ],
};

const RSS_CATALOG: CatalogRecord[] = [
  {
    id: "habr",
    title: "Хабр",
    url: "https://habr.com/ru/rss/articles/?fl=ru",
    description: "Разработка, ИИ, инфраструктура и опыт технологических команд.",
    category: "Технологии",
    language: "RU",
    featured: 10,
    tags: ["инженер", "devops", "аналитик"],
  },
  {
    id: "tproger",
    title: "Tproger",
    url: "https://tproger.ru/feed",
    description: "Новости программирования, инструменты и практические разборы.",
    category: "Технологии",
    language: "RU",
    featured: 8,
    tags: ["frontend", "backend", "разработчик"],
  },
  {
    id: "cnews",
    title: "CNews",
    url: "https://www.cnews.ru/inc/rss/news.xml",
    description: "Корпоративные технологии, цифровизация и российский ИТ-рынок.",
    category: "Технологии",
    language: "RU",
    featured: 7,
    tags: ["корпоратив", "гос", "информационн"],
  },
  {
    id: "techcrunch",
    title: "TechCrunch",
    url: "https://techcrunch.com/feed/",
    description: "Международные стартапы, венчурный рынок и новые продукты.",
    category: "Технологии",
    language: "EN",
    featured: 6,
    tags: ["венчур", "founder", "инновац"],
  },
  {
    id: "the-verge",
    title: "The Verge",
    url: "https://www.theverge.com/rss/index.xml",
    description: "Гаджеты, платформы, ИИ и культура технологий.",
    category: "Технологии",
    language: "EN",
    featured: 5,
    tags: ["гаджет", "смартфон", "apple", "google"],
  },
  {
    id: "ars-technica",
    title: "Ars Technica",
    url: "https://feeds.arstechnica.com/arstechnica/index",
    description: "Глубокие технологические разборы, наука и безопасность.",
    category: "Технологии",
    language: "EN",
    featured: 4,
    tags: ["безопасност", "желез", "science"],
  },
  {
    id: "vc",
    title: "vc.ru",
    url: "https://vc.ru/rss/all",
    description: "Бизнес, продукты, маркетинг и опыт предпринимателей.",
    category: "Бизнес",
    language: "RU",
    featured: 10,
    tags: ["кейс", "основател", "ecommerce", "маркетплейс"],
  },
  {
    id: "rbc",
    title: "РБК",
    url: "https://rssexport.rbc.ru/rbcnews/news/30/full.rss",
    description: "Деловые новости, экономика, компании и регулирование.",
    category: "Бизнес",
    language: "RU",
    featured: 9,
    tags: ["эконом", "политик", "компан", "финанс"],
  },
  {
    id: "kommersant",
    title: "Коммерсантъ",
    url: "https://www.kommersant.ru/RSS/news.xml",
    description: "Оперативная деловая повестка, рынки и общество.",
    category: "Бизнес",
    language: "RU",
    featured: 8,
    tags: ["делов", "политик", "общество"],
  },
  {
    id: "cbr",
    title: "Банк России",
    url: "https://www.cbr.ru/rss/eventrss",
    description: "Решения, заявления и события финансового регулятора.",
    category: "Финансы",
    language: "RU",
    featured: 10,
    tags: ["центробанк", "ставк", "регулятор", "инфляц"],
  },
  {
    id: "government",
    title: "Правительство России",
    url: "http://government.ru/all/rss/",
    description: "Официальные постановления, распоряжения, законопроекты и решения Правительства.",
    category: "Право",
    language: "RU",
    featured: 10,
    tags: ["постановлен", "распоряжен", "законопроект", "регулирован", "правительств"],
  },
  {
    id: "consultant",
    title: "КонсультантПлюс — горячие документы",
    url: "https://www.consultant.ru/rss/hotdocs.xml",
    description: "Новые нормативные документы и важные изменения законодательства.",
    category: "Право",
    language: "RU",
    featured: 10,
    tags: ["документ", "кодекс", "постановлен", "федеральн"],
  },
  {
    id: "garant",
    title: "ГАРАНТ.РУ",
    url: "https://rss.garant.ru/news/",
    description: "Правовые новости, налоги, бухгалтерия и судебная практика.",
    category: "Право",
    language: "RU",
    featured: 9,
    tags: ["бухгалтер", "кадры", "госзакуп", "практик"],
  },
  {
    id: "pravo-ru",
    title: "Право.ru",
    url: "https://pravo.ru/rss/",
    description: "Судебная практика, законодательство и аналитика российского юридического рынка.",
    category: "Право",
    language: "RU",
    featured: 9,
    tags: ["судебн", "банкрот", "арбитраж", "юридическ", "практик"],
  },
  {
    id: "zakon-ru",
    title: "Закон.ру",
    url: "https://zakon.ru/rss/blogsanddiscussions",
    description: "Профессиональные юридические разборы, мнения и обсуждения правоприменения.",
    category: "Право",
    language: "RU",
    featured: 8,
    tags: ["правоприменен", "судебн", "договор", "арбитраж", "эксперт"],
  },
  {
    id: "cossa",
    title: "Cossa",
    url: "https://www.cossa.ru/rss/",
    description: "Маркетинг, коммуникации, реклама и цифровые кейсы.",
    category: "Маркетинг",
    language: "RU",
    featured: 10,
    tags: ["агентств", "performance", "коммуникац"],
  },
  {
    id: "texterra",
    title: "TexTerra",
    url: "https://texterra.ru/blog/rss/",
    description: "Контент-маркетинг, SEO, соцсети и продвижение бизнеса.",
    category: "Маркетинг",
    language: "RU",
    featured: 9,
    tags: ["контент-маркетинг", "соцсет", "трафик"],
  },
  {
    id: "hubspot-marketing",
    title: "HubSpot Marketing",
    url: "https://blog.hubspot.com/marketing/rss.xml",
    description: "Международные практики контента, продаж и growth-маркетинга.",
    category: "Маркетинг",
    language: "EN",
    featured: 6,
    tags: ["growth", "лид", "воронк", "crm"],
  },
  {
    id: "nplus1",
    title: "N + 1",
    url: "https://nplus1.ru/rss",
    description: "Научные новости, исследования и объяснение открытий.",
    category: "Наука",
    language: "RU",
    featured: 10,
    tags: ["археолог", "астроном", "нейро", "антрополог"],
  },
  {
    id: "science-daily",
    title: "ScienceDaily",
    url: "https://www.sciencedaily.com/rss/all.xml",
    description: "Свежие исследования в медицине, природе и технологиях.",
    category: "Наука",
    language: "EN",
    featured: 7,
    tags: ["research", "health", "environment"],
  },
];

function normalize(value: string) {
  return value
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(context: string, words: Set<string>, term: string) {
  const normalizedTerm = normalize(term);
  if (!normalizedTerm) return false;
  if (normalizedTerm.includes(" ")) return context.includes(normalizedTerm);
  if (normalizedTerm.length <= 3) return words.has(normalizedTerm);
  // Термы записаны как основы: «технолог» должно находить «технологии», но
  // «общество» не должно случайно срабатывать внутри слова «сообщество».
  return [...words].some((word) => word.startsWith(normalizedTerm));
}

/** Ранжирует каталог без ИИ: название + бриф + профиль канала. */
export function rankRssCatalog(rawContext: string): RankedRssSource[] {
  const context = normalize(rawContext);
  const words = new Set(context.split(" ").filter(Boolean));

  const ranked = RSS_CATALOG.map((source) => {
    const categoryMatched = CATEGORY_TERMS[source.category].some((term) =>
      containsTerm(context, words, term),
    );
    const tagMatches = (source.tags ?? []).filter((term) => containsTerm(context, words, term));
    const relevanceScore = (categoryMatched ? 30 : 0) + tagMatches.length * 5;

    return {
      id: source.id,
      title: source.title,
      url: source.url,
      description: source.description,
      category: source.category,
      language: source.language,
      score: relevanceScore + source.featured,
      recommended: relevanceScore > 0,
      reason: categoryMatched
        ? `Подходит к теме «${source.category}»`
        : tagMatches.length
          ? `Совпало по теме: ${tagMatches.slice(0, 2).join(", ")}`
          : "Источник из базовой подборки",
    } satisfies RankedRssSource;
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "ru"));

  // Если профиль пустой или слишком общий, всё равно даём шесть понятных стартовых
  // источников. Это рекомендация интерфейса, а не ложное утверждение о тематическом match.
  const hasMatches = ranked.some((source) => source.recommended);
  if (!hasMatches) {
    return ranked.map((source, index) => ({
      ...source,
      recommended: index < 6,
      reason: index < 6 ? "Популярный источник для старта" : source.reason,
    }));
  }

  let recommendationsLeft = 6;
  return ranked.map((source) => {
    const recommended = source.recommended && recommendationsLeft > 0;
    if (recommended) recommendationsLeft--;
    return { ...source, recommended };
  });
}

export function rssCatalogSize() {
  return RSS_CATALOG.length;
}

/**
 * Публичная юридическая подборка использует те же записи, что общий RSS-каталог.
 * Это не второй источник истины и не попытка получить доступ к закрытым кабинетам.
 */
export function listPublicLegalRssSources(): PublicLegalRssSource[] {
  const legalSourceOrder = ["government", "cbr", "consultant", "garant", "pravo-ru", "zakon-ru"];
  return RSS_CATALOG
    .filter((source) => legalSourceOrder.includes(source.id))
    .sort((left, right) => legalSourceOrder.indexOf(left.id) - legalSourceOrder.indexOf(right.id))
    .map((source) => ({
      id: source.id,
      title: source.title,
      url: source.url,
      description: source.description,
      language: source.language,
      category: "Юридические источники",
      access: "public_rss",
    }));
}
