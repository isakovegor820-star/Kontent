export type LegalPractice =
  | "Банкротство"
  | "Налоги"
  | "Финансовое право"
  | "Трудовое право"
  | "Корпоративное право"
  | "Договоры"
  | "Госзакупки"
  | "Недвижимость"
  | "Интеллектуальная собственность"
  | "Цифровое право"
  | "Антимонопольное право"
  | "Семейное право"
  | "Уголовное право"
  | "Судебная практика"
  | "Регулирование"
  | "Общая практика";

export type LegalEventStatus =
  | "Законопроект"
  | "Принято"
  | "Вступает в силу"
  | "Разъяснение"
  | "Судебная практика"
  | "Правовая новость";

export type LegalOpportunityPriority = "high" | "medium" | "standard";

export type LegalOpportunityInput = {
  title: string | null;
  summary: string | null;
  feedTitle: string | null;
  publishedAt: string | null;
  fetchedAt: string;
};

export type LegalOpportunityInsight = {
  title: string;
  summary: string;
  practice: LegalPractice;
  status: LegalEventStatus;
  priority: LegalOpportunityPriority;
  priorityLabel: "Срочно" | "Важно" | "Актуально";
  whyImportant: string;
  audience: string;
  contentAngle: string;
  sourceLabel: string;
};

type LegalOpportunityFingerprintInput = Pick<LegalOpportunityInput, "title" | "summary">;
type LegalOpportunityRelevanceInput = Pick<LegalOpportunityInput, "title" | "summary" | "feedTitle">;

const PRACTICE_TERMS: ReadonlyArray<{
  practice: LegalPractice;
  terms: readonly string[];
}> = [
  { practice: "Банкротство", terms: ["банкрот", "должник", "конкурсн", "финансовый управляющ", "несостоятельн"] },
  { practice: "Налоги", terms: ["налог", "фнс", "ндс", "ндфл", "декларац", "страхов взнос"] },
  { practice: "Финансовое право", terms: ["банк россии", "центробанк", "кредитн", "финансовый рынок", "ценн бумаг", "страхован"] },
  { practice: "Трудовое право", terms: ["трудов", "работник", "работодател", "увольнен", "зарплат", "кадров"] },
  { practice: "Корпоративное право", terms: ["корпоратив", "ооо", "акционер", "директор", "участник обществ", "юрлиц"] },
  { practice: "Госзакупки", terms: ["госзакуп", "закупк", "44-фз", "223-фз", "контрактн систем", "тендер"] },
  { practice: "Недвижимость", terms: ["недвижим", "земельн", "егрн", "кадастр", "застройщик", "жилищн"] },
  { practice: "Интеллектуальная собственность", terms: ["интеллектуальн собственност", "авторск", "товарн знак", "патент", "роспатент"] },
  { practice: "Цифровое право", terms: ["персональн данн", "роскомнадзор", "цифров", "интернет", "искусственн интеллект", "информационн систем", "мессенджер", "онлайн-платформ", "запрещенн контент"] },
  { practice: "Антимонопольное право", terms: ["антимонопол", "фас россии", "защит конкуренц", "недобросовестн конкуренц", "закон о реклам"] },
  { practice: "Семейное право", terms: ["семейн", "алимент", "брак", "супруг", "родительск прав", "опек"] },
  { practice: "Уголовное право", terms: ["уголовн", "преступлен", "обвиняем", "осужден", "ук рф", "упк рф"] },
  { practice: "Договоры", terms: ["договор", "сделк", "обязательств", "неустойк", "контракт"] },
  { practice: "Судебная практика", terms: ["верховн суд", "конституционн суд", "арбитраж", "судебн", "кассац", "апелляц"] },
  { practice: "Регулирование", terms: ["регулятор", "лиценз", "комплаенс", "персональн данн", "антимонопол", "центробанк"] },
] as const;

const PRACTICE_AUDIENCES: Record<LegalPractice, string> = {
  "Банкротство": "Должники, кредиторы, финансовые управляющие и собственники бизнеса.",
  "Налоги": "Компании, предприниматели, бухгалтеры и налоговые консультанты.",
  "Финансовое право": "Банки, финансовые организации, инвесторы, заёмщики и их консультанты.",
  "Трудовое право": "Работодатели, руководители, HR-команды и сотрудники.",
  "Корпоративное право": "Собственники компаний, директора, участники и инвесторы.",
  "Договоры": "Бизнес, предприниматели и специалисты, которые заключают или исполняют договоры.",
  "Госзакупки": "Заказчики, поставщики, контрактные службы и участники закупок.",
  "Недвижимость": "Собственники, застройщики, арендаторы, покупатели и владельцы земли.",
  "Интеллектуальная собственность": "Правообладатели, авторы, IT-компании, бренды и разработчики.",
  "Цифровое право": "Онлайн-сервисы, владельцы сайтов, IT-команды и операторы персональных данных.",
  "Антимонопольное право": "Компании, рекламодатели, торговые площадки и участники конкурентных рынков.",
  "Семейное право": "Супруги, родители, опекуны и семьи, которым нужно защитить личные и имущественные права.",
  "Уголовное право": "Обвиняемые, потерпевшие, адвокаты и компании с уголовно-правовыми рисками.",
  "Судебная практика": "Юристы, участники споров и компании с похожими правовыми рисками.",
  "Регулирование": "Компании из регулируемых отраслей, руководители и комплаенс-команды.",
  "Общая практика": "Граждане, предприниматели и компании, которых касается изменение.",
};

const PRACTICE_ANGLES: Record<LegalPractice, string> = {
  "Банкротство": "Объяснить, как событие меняет риски должника и возможности кредитора.",
  "Налоги": "Разобрать, кому нужно изменить расчёты, документы или сроки.",
  "Финансовое право": "Показать, как решение регулятора влияет на деньги, сделки и финансовые риски.",
  "Трудовое право": "Показать работодателю и сотруднику, что проверить в кадровых процессах.",
  "Корпоративное право": "Перевести изменение в конкретные действия для собственника и директора.",
  "Договоры": "Показать, какие условия договора и деловые риски стоит пересмотреть.",
  "Госзакупки": "Дать заказчику и поставщику короткий чек-лист по процедуре, срокам и рискам.",
  "Недвижимость": "Объяснить, какие документы, права на объект или условия сделки стоит проверить.",
  "Интеллектуальная собственность": "Показать, как защитить результат, бренд или контент и избежать нарушения чужих прав.",
  "Цифровое право": "Перевести новые цифровые требования в понятные действия для продукта и бизнеса.",
  "Антимонопольное право": "Разобрать, какое поведение на рынке или в рекламе создаёт риск претензий регулятора.",
  "Семейное право": "Объяснить права сторон и следующий безопасный шаг без давления и сенсационности.",
  "Уголовное право": "Объяснить процессуальный риск и порядок действий, не делая выводов о виновности.",
  "Судебная практика": "Разобрать позицию суда и объяснить, как она влияет на похожие споры.",
  "Регулирование": "Собрать короткий чек-лист действий для бизнеса до появления риска.",
  "Общая практика": "Объяснить изменение простым языком и дать читателю следующий практический шаг.",
};

const SUMMARY_FALLBACK =
  "Аврора нашла новое событие в юридическом источнике. Откройте подробности и первоисточник перед публикацией.";

function normalize(value: string) {
  return value.toLocaleLowerCase("ru-RU").replace(/ё/gu, "е");
}

/**
 * Один и тот же акт часто приходит из нескольких лент с разными аннотациями.
 * Номер, вид и дата документа дают устойчивый ключ; для обычных новостей
 * используем очищенный заголовок, не сравнивая полные чужие тексты.
 */
export function legalOpportunityFingerprint(input: LegalOpportunityFingerprintInput): string {
  const title = normalize(cleanLegalSourceText(input.title, 360))
    .replace(/[«»"'()]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const combined = normalize(`${title} ${cleanLegalSourceText(input.summary, 500)}`);
  const document = combined.match(
    /(федеральн\w*\s+закон|постановлен\w*|распоряжен\w*|приказ\w*|письм\w*|определен\w*).{0,100}?(?:№|\bn\b)\s*([0-9а-яa-z][0-9а-яa-z./@-]*)/u,
  );
  if (document) {
    const date = combined.match(/\b\d{1,2}\.\d{1,2}\.\d{4}\b/u)?.[0] ?? "";
    return `document:${document[1]}:${date}:${document[2]}`;
  }

  return `title:${title
    .replace(/[^0-9а-яa-z]+/gu, " ")
    .split(" ")
    .filter((word) => word.length > 2)
    .slice(0, 16)
    .join(" ")}`;
}

export function cleanLegalSourceText(value: unknown, max = 520): string {
  return String(value ?? "")
    .replace(/<script[\s\S]*?<\/script>/giu, " ")
    .replace(/<style[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;|&#160;/giu, " ")
    .replace(/&amp;/giu, "&")
    .replace(/&quot;|&#34;/giu, "\"")
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, max);
}

export function isLikelyLegalOpportunity(input: LegalOpportunityRelevanceInput): boolean {
  const source = normalize(cleanLegalSourceText(input.feedTitle, 160));
  if (/консультант|гарант|право\.ru|закон\.ru/u.test(source)) return true;
  if (/банк россии/u.test(source)) return true;

  const text = normalize(`${cleanLegalSourceText(input.title, 360)} ${cleanLegalSourceText(input.summary, 700)}`);
  return /закон|законопроект|постановлен|распоряжен|приказ|письмо\s+(?:фнс|минфин|ведомств)|кодекс|судебн|верховн.{0,16}суд|арбитраж|кассац|апелляц|регулир|норматив|требован|обязан|штраф|запрет|налог|банкрот|договор|закупк|лиценз|персональн\s+данн|вступает\s+в\s+силу/u.test(text);
}

function practiceFrom(text: string): LegalPractice {
  let best: { practice: LegalPractice; score: number } = { practice: "Общая практика", score: 0 };
  for (const group of PRACTICE_TERMS) {
    const score = group.terms.reduce((total, term) => total + (text.includes(term) ? 1 : 0), 0);
    if (score > best.score) best = { practice: group.practice, score };
  }
  return best.practice;
}

function statusFrom(text: string): LegalEventStatus {
  if (/законопроект|проект\s+(?:закона|постановления|приказа)|предлага(?:ет|ют)\s+внести/u.test(text)) {
    return "Законопроект";
  }
  if (/вступ(?:ил|ила|ило|ят|ает|ают)\s+в\s+силу|начинает\s+действовать/u.test(text)) {
    return "Вступает в силу";
  }
  if (/верховн.{0,12}суд|конституционн.{0,12}суд|судебн.{0,12}практик|кассац|арбитраж/u.test(text)) {
    return "Судебная практика";
  }
  if (/разъясн|письмо\s+(?:фнс|минфин|ведомств)|позици(?:я|ю)\s+ведомств/u.test(text)) {
    return "Разъяснение";
  }
  if (/принят|подписан|утвержден|опубликован\s+закон/u.test(text)) return "Принято";
  return "Правовая новость";
}

function priorityFrom(text: string, publishedAt: string | null, fetchedAt: string, nowMs: number) {
  const timestamp = Date.parse(publishedAt || fetchedAt);
  const ageHours = Number.isFinite(timestamp) ? Math.max(0, (nowMs - timestamp) / 3_600_000) : 999;
  const urgentTerms = /вступает\s+в\s+силу|начинает\s+действовать|не\s+позднее|срок\s+(?:подачи|уплаты|представления|исполнения)|(?:вводится|установлен|увеличен).{0,30}(?:штраф|запрет|обязанност)|новые\s+правила/u.test(text);
  const materialTerms = /закон|суд|налог|регулятор|постановлен|приказ|кодекс/u.test(text);
  if (ageHours <= 72 && urgentTerms) return { priority: "high", priorityLabel: "Срочно" } as const;
  if (ageHours <= 168 || materialTerms) return { priority: "medium", priorityLabel: "Важно" } as const;
  return { priority: "standard", priorityLabel: "Актуально" } as const;
}

function whyImportant(status: LegalEventStatus, practice: LegalPractice) {
  if (status === "Законопроект") {
    return "Правила ещё могут измениться, но тему уже стоит объяснить аудитории без формулировок о действующем законе.";
  }
  if (status === "Вступает в силу") {
    return "У изменения есть практический срок: читателю важно заранее проверить документы, процессы и возможные риски.";
  }
  if (status === "Судебная практика") {
    return "Новая судебная позиция может повлиять на стратегию похожих споров и оценку правового риска.";
  }
  if (status === "Разъяснение") {
    return "Разъяснение помогает понять, как ведомство будет применять правила на практике и чего ждать бизнесу.";
  }
  if (status === "Принято") {
    return "Решение уже принято: аудитории важно понять, что именно изменится и когда потребуется действовать.";
  }
  return `Это актуальный повод показать экспертизу в теме «${practice}» и дать читателю понятный практический вывод.`;
}

export function classifyLegalOpportunity(
  input: LegalOpportunityInput,
  nowMs = Date.now(),
): LegalOpportunityInsight {
  const title = cleanLegalSourceText(input.title, 260) || "Новое юридическое событие";
  const summary = cleanLegalSourceText(input.summary) || SUMMARY_FALLBACK;
  const sourceLabel = cleanLegalSourceText(input.feedTitle, 160) || "Юридический источник";
  const searchable = normalize(`${title} ${summary} ${sourceLabel}`);
  const practice = practiceFrom(searchable);
  const status = statusFrom(searchable);
  const priority = priorityFrom(searchable, input.publishedAt, input.fetchedAt, nowMs);

  return {
    title,
    summary,
    practice,
    status,
    ...priority,
    whyImportant: whyImportant(status, practice),
    audience: PRACTICE_AUDIENCES[practice],
    contentAngle: PRACTICE_ANGLES[practice],
    sourceLabel,
  };
}
