// Декларативный реестр настроек публикации.
//
// Зачем отдельный модуль: раньше поля были «зашиты» в разметку двух вкладок, поэтому
// один и тот же параметр встречался дважды с разными подписями, а новый ключ легко
// было забыть в интерфейсе. Здесь единственный источник правды по составу настроек:
// компонент рисует поля из реестра, а тест `post-settings-menu-coverage.test.ts`
// падает, если в модели появился ключ, которого нет в реестре.
//
// Модуль намеренно без React — его импортируют и клиентский компонент, и тесты.

import type { PostSettings } from "./post-settings";

export type PostSettingsFieldKey = keyof PostSettings;

export type FieldKind = "select" | "text" | "textarea" | "number" | "toggle" | "list" | "proofs";

export type FieldOption = readonly [value: string, label: string];

export interface PostSettingsField {
  key: PostSettingsFieldKey;
  label: string;
  group: PostSettingsGroupId;
  kind: FieldKind;
  /** Что произойдёт с постом — человеческим языком, без жаргона. */
  help?: string;
  /** Пример значения или формат ввода. */
  placeholder?: string;
  options?: readonly FieldOption[];
  min?: number;
  max?: number;
  /** Поле показывается только когда применимо (например, точное число эмодзи). */
  visibleWhen?: (settings: PostSettings) => boolean;
  /** Показывать в «Простом режиме» — там только то, что реально меняет пост. */
  simple?: boolean;
  /** Поле участвует в генерации только в паре с другим (для подсказок в UI). */
  dependsOn?: string;
  /** Ключ модели, который нигде не читается: держим в реестре ради полноты покрытия. */
  dead?: boolean;
}

export type PostSettingsGroupId =
  "base" | "audience" | "offer" | "proof" | "sales" | "cta" | "context" | "voice" | "format" | "originality" | "exact" | "output";

export interface PostSettingsGroup {
  id: PostSettingsGroupId;
  title: string;
  /** Короткая строка в навигации: что настраивается в группе. */
  caption: string;
  /** Одна фраза-объяснение в начале группы. */
  lead: string;
}

export const POST_SETTINGS_GROUPS: readonly PostSettingsGroup[] = [
  { id: "base", title: "Основа", caption: "Задача, длина, смысл", lead: "Что за публикация и какой результат она должна дать." },
  { id: "audience", title: "Аудитория", caption: "Кому и что болит", lead: "Чем точнее описан читатель, тем меньше общих слов в тексте." },
  {
    id: "offer",
    title: "Продукт и оффер",
    caption: "Что продвигаем",
    lead: "Предложение, выгода и отличие. Пустые поля Аврора возьмёт из паспорта канала.",
  },
  { id: "proof", title: "Доказательства", caption: "Факты и их проверка", lead: "Цифры, кейсы и ссылки, за которые автор отвечает." },
  {
    id: "sales",
    title: "Механика продажи",
    caption: "Угол, давление, срочность",
    lead: "Как вести читателя к решению — без давления, которого не просили.",
  },
  { id: "cta", title: "Призыв к действию", caption: "Что сделать читателю", lead: "Одно понятное действие и что будет после него." },
  {
    id: "context",
    title: "Контекст",
    caption: "Место в серии и воронке",
    lead: "Что было раньше, что будет дальше и о чём нельзя говорить.",
  },
  {
    id: "voice",
    title: "Голос автора",
    caption: "Тон, стиль, привычки",
    lead: "Как звучит автор: обращения, ритм, запрещённые формулировки.",
  },
  {
    id: "format",
    title: "Оформление",
    caption: "Начало, структура, эмодзи",
    lead: "Как текст выглядит в ленте: абзацы, списки, эмодзи, хэштеги.",
  },
  { id: "originality", title: "Оригинальность", caption: "Повторы и шаблоны", lead: "Насколько новый пост должен отличаться от прошлых." },
  { id: "exact", title: "Точные требования", caption: "Слова, ссылки, стоп-темы", lead: "Жёсткие списки: их Аврора проверяет дословно." },
  {
    id: "output",
    title: "Комплектация",
    caption: "Что вернуть вместе с постом",
    lead: "Дополнительные материалы и режим качества генерации.",
  },
] as const;

const TONE_OPTIONS: readonly FieldOption[] = [
  ["auto", "Из голоса канала"],
  ["casual", "Разговорно"],
  ["neutral", "Нейтрально"],
  ["formal", "Формально"],
];

const ADDRESS_OPTIONS: readonly FieldOption[] = [
  ["auto", "Из голоса канала"],
  ["ты", "На «ты»"],
  ["вы", "На «вы»"],
  ["neutral", "Без обращения"],
];

const ENERGY_OPTIONS: readonly FieldOption[] = [
  ["auto", "Авто — по теме"],
  ["calm", "Спокойная"],
  ["balanced", "Сбалансированная"],
  ["high", "Высокая"],
];

const HUMOR_OPTIONS: readonly FieldOption[] = [
  ["auto", "Если уместно"],
  ["none", "Без юмора"],
  ["light", "Лёгкий"],
  ["bold", "Смелый без грубости"],
];

const LEVEL_OPTIONS: readonly FieldOption[] = [
  ["none", "Не использовать"],
  ["low", "Низкий"],
  ["medium", "Средний"],
  ["high", "Высокий"],
];

const CTAS: readonly FieldOption[] = [
  ["auto", "Авто — только при необходимости"],
  ["none", "Без призыва"],
  ["comment", "Комментарий"],
  ["save", "Сохранить"],
  ["share", "Поделиться"],
  ["subscribe", "Подписаться"],
  ["click", "Перейти по ссылке"],
  ["buy", "Купить / оставить заявку"],
  ["reply", "Ответить автору"],
  ["register", "Зарегистрироваться"],
  ["download", "Скачать материал"],
];

const PROFANITY_MODES: readonly FieldOption[] = [
  ["auto", "Как в настройках канала"],
  ["forbid", "Запрещён"],
  ["allow", "Допустим, но не обязателен"],
  ["masked", "Обязателен, со звёздочками"],
  ["required_direct", "Обязателен, без цензуры"],
];

const EMOJI_MODES: readonly FieldOption[] = [
  ["auto", "Авто — если уместно"],
  ["none", "Без эмодзи"],
  ["few", "Один эмодзи"],
  ["moderate", "От двух до трёх"],
  ["many", "От четырёх до восьми"],
  ["custom", "Точное количество"],
];

const QUALITY_MODES: readonly FieldOption[] = [
  ["fast", "Быстро — один проход и проверка"],
  ["balanced", "Качественно — один сильный проход"],
  ["maximum", "Максимум — черновик и редактура"],
];

const LENGTHS: readonly FieldOption[] = [
  ["auto", "Авто — по формату"],
  ["short", "Короткая"],
  ["medium", "Средняя"],
  ["long", "Длинная"],
  ["custom", "Точный диапазон"],
];

const AUDIENCE_PRESETS: readonly FieldOption[] = [
  ["", "Из паспорта канала"],
  ["новая аудитория, которая ещё не знакома с брендом", "Новая аудитория"],
  ["подписчики, которые уже читают канал", "Текущие подписчики"],
  ["потенциальные клиенты, которые выбирают решение", "Потенциальные клиенты"],
  ["действующие клиенты", "Действующие клиенты"],
  ["новички в теме", "Новички в теме"],
  ["профессионалы и эксперты в теме", "Профессионалы и эксперты"],
];

export const OUTPUT_PART_OPTIONS: readonly FieldOption[] = [
  ["hooks", "5 вариантов начала"],
  ["titles", "3 заголовка"],
  ["cover", "Текст на обложку"],
  ["first_comment", "Первый комментарий"],
  ["pinned_comment", "Закреплённый комментарий"],
  ["hashtags", "Хэштеги"],
  ["alt", "Описание изображения"],
  ["visual_brief", "Задание для изображения"],
  ["image_idea", "Идея изображения"],
  ["short_version", "Короткая версия"],
  ["stories", "Версия для историй"],
  ["cross_platform", "Другая площадка"],
  ["comment_replies", "Ответы на комментарии"],
  ["utm", "Ссылка с меткой"],
  ["discussion_question", "Вопрос для обсуждения"],
];

export const AVOID_REPETITION_OPTIONS: readonly FieldOption[] = [
  ["hooks", "Начала постов"],
  ["cta", "Призывы"],
  ["stories", "Истории"],
  ["examples", "Примеры"],
  ["structure", "Структуру"],
  ["phrases", "Ключевые формулировки"],
];

export const POST_SETTINGS_FIELDS: readonly PostSettingsField[] = [
  /* ---------------------------------------------------------------- основа */
  {
    key: "target",
    label: "Площадка и формат",
    group: "base",
    kind: "select",
    simple: true,
    help: "Определяет допустимый объём, лимит эмодзи и норму хэштегов.",
  },
  {
    key: "preset",
    label: "Характер публикации",
    group: "base",
    kind: "select",
    simple: true,
    help: "Готовый набор: выберите шаблон, а потом поправьте любое поле вручную.",
  },
  {
    key: "goal",
    label: "Цель",
    group: "base",
    kind: "select",
    simple: true,
    options: [
      ["auto", "Авто — по задаче"],
      ["reach", "Охват"],
      ["engagement", "Вовлечение"],
      ["sale", "Продажа"],
      ["traffic", "Трафик"],
      ["education", "Обучение"],
      ["announcement", "Анонс"],
      ["warmup", "Прогрев"],
    ],
  },
  { key: "length", label: "Длина", group: "base", kind: "select", simple: true, options: LENGTHS },
  {
    key: "customMinChars",
    label: "От, знаков",
    group: "base",
    kind: "number",
    min: 1,
    visibleWhen: (settings) => settings.length === "custom",
    dependsOn: "length = «Точный диапазон»",
  },
  {
    key: "customMaxChars",
    label: "До, знаков",
    group: "base",
    kind: "number",
    min: 1,
    visibleWhen: (settings) => settings.length === "custom",
    dependsOn: "length = «Точный диапазон»",
  },
  {
    key: "mainIdea",
    label: "Главная мысль",
    group: "base",
    kind: "textarea",
    simple: true,
    placeholder: "Одно предложение, которое читатель должен запомнить",
    help: "Обычно не нужно: Аврора берёт тему из сообщения в чате.",
  },
  { key: "readerUnderstanding", label: "Что читатель должен понять", group: "base", kind: "text" },
  {
    key: "desiredFeeling",
    label: "Что должен почувствовать",
    group: "base",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["interest", "Интерес"],
      ["trust", "Доверие"],
      ["desire", "Желание"],
      ["urgency", "Срочность"],
      ["relief", "Облегчение"],
      ["inspiration", "Вдохновение"],
    ],
  },
  { key: "readerAction", label: "Что должен сделать", group: "base", kind: "text" },
  {
    key: "primaryMetric",
    label: "Главная метрика",
    group: "base",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["readthrough", "Дочитывания"],
      ["saves", "Сохранения"],
      ["comments", "Комментарии"],
      ["clicks", "Переходы"],
      ["leads", "Заявки"],
      ["sales", "Продажи"],
    ],
  },
  {
    key: "messageCount",
    label: "Количество смыслов",
    group: "base",
    kind: "select",
    options: [
      ["one", "Один основной"],
      ["one_plus", "Основной и дополнительный"],
      ["several", "Несколько"],
    ],
  },
  { key: "includeConclusion", label: "Добавлять вывод", group: "base", kind: "toggle" },

  /* -------------------------------------------------------------- аудитория */
  {
    key: "audience",
    label: "Сегмент аудитории",
    group: "audience",
    kind: "text",
    simple: true,
    options: AUDIENCE_PRESETS,
    placeholder: "Например: юристы малого бизнеса",
    help: "Пусто — Аврора возьмёт портрет из паспорта канала.",
  },
  {
    key: "awareness",
    label: "Осведомлённость",
    group: "audience",
    kind: "select",
    options: [
      ["auto", "Авто — по контексту"],
      ["unaware", "Не знает о проблеме"],
      ["problem_aware", "Понимает проблему"],
      ["solution_aware", "Ищет решение"],
      ["product_aware", "Знает продукт"],
      ["ready", "Готова действовать"],
    ],
  },
  { key: "readerSituation", label: "Ситуация читателя", group: "audience", kind: "text" },
  { key: "audienceProblem", label: "Главная проблема", group: "audience", kind: "text" },
  { key: "desiredResult", label: "Желаемый результат", group: "audience", kind: "text" },
  { key: "emotionalDesire", label: "Эмоциональное желание", group: "audience", kind: "text" },
  { key: "primaryFear", label: "Главный страх", group: "audience", kind: "text" },
  { key: "barrier", label: "Барьер", group: "audience", kind: "text" },
  { key: "objection", label: "Основное возражение", group: "audience", kind: "text" },
  { key: "failedAttempts", label: "Неудачные попытки", group: "audience", kind: "text" },
  { key: "currentAlternative", label: "Текущая альтернатива", group: "audience", kind: "text" },
  { key: "purchaseTrigger", label: "Триггер покупки", group: "audience", kind: "text" },
  { key: "choiceCriterion", label: "Критерий выбора", group: "audience", kind: "text" },
  {
    key: "trustLevel",
    label: "Уровень доверия",
    group: "audience",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["cold", "Холодная"],
      ["familiar", "Знакомая"],
      ["warm", "Тёплая"],
      ["customer", "Клиент"],
    ],
  },
  { key: "audienceLanguage", label: "Язык аудитории", group: "audience", kind: "text" },
  { key: "excludedAudience", label: "Не наша аудитория", group: "audience", kind: "text" },

  /* ----------------------------------------------------------------- оффер */
  {
    key: "promotionType",
    label: "Тип предложения",
    group: "offer",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["product", "Продукт"],
      ["service", "Услуга"],
      ["event", "Мероприятие"],
      ["personal_brand", "Личный бренд"],
      ["lead_magnet", "Бесплатный материал"],
    ],
  },
  { key: "promotionName", label: "Что продвигаем", group: "offer", kind: "text", simple: true },
  { key: "offer", label: "Конкретное предложение", group: "offer", kind: "text" },
  { key: "mainBenefit", label: "Главная выгода", group: "offer", kind: "text", simple: true },
  { key: "differentiation", label: "Главное отличие", group: "offer", kind: "text" },
  {
    key: "price",
    label: "Цена",
    group: "offer",
    kind: "text",
    placeholder: "Например: 12 000 ₽",
    visibleWhen: (settings) => settings.priceMode !== "never",
    dependsOn: "priceMode ≠ «Не указывать»",
  },
  {
    key: "offerDestination",
    label: "Ссылка или место обращения",
    group: "offer",
    kind: "text",
    placeholder: "Сайт, бот, личные сообщения",
  },
  {
    key: "salesIntensity",
    label: "Интенсивность продажи",
    group: "offer",
    kind: "select",
    options: [
      ["native", "Нативная"],
      ["soft", "Мягкая"],
      ["confident", "Уверенная"],
      ["direct", "Прямая"],
    ],
  },
  {
    key: "productReveal",
    label: "Когда показать продукт",
    group: "offer",
    kind: "select",
    options: [
      ["immediately", "Сразу"],
      ["after_problem", "После проблемы"],
      ["near_end", "Ближе к концу"],
      ["cta_only", "Только в призыве"],
    ],
  },

  /* --------------------------------------------------------- доказательства */
  { key: "proofs", label: "Доказательства", group: "proof", kind: "proofs" },
  {
    key: "proofCount",
    label: "Сколько доказательств использовать",
    group: "proof",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["0", "Ни одного"],
      ["1", "Одно"],
      ["2", "Два"],
      ["3_plus", "Три и более"],
    ],
    visibleWhen: (settings) => settings.proofs.some((proof) => proof.text.trim().length > 0),
    dependsOn: "заполненное доказательство",
  },
  {
    key: "factStrictness",
    label: "Проверка фактов",
    group: "proof",
    kind: "select",
    help: "«Только подтверждённые» оставляет в тексте лишь факты из доказательств и паспорта канала.",
    options: [
      ["off", "Отключена"],
      ["verified", "Только подтверждённые"],
      ["verified_inference", "Факты и осторожные выводы"],
      ["general", "Общие рассуждения"],
      ["creative_no_new_facts", "Креативно, без новых фактов"],
    ],
  },
  {
    key: "missingFactsMode",
    label: "Если данных недостаточно",
    group: "proof",
    kind: "select",
    options: [
      ["ask", "Задать вопрос"],
      ["omit", "Не использовать утверждение"],
      ["neutral", "Написать нейтрально"],
      ["placeholder", "Оставить место для заполнения"],
    ],
  },
  { key: "requiredFacts", label: "Обязательные факты", group: "proof", kind: "list", placeholder: "Один факт на строку" },

  /* ------------------------------------------------------------- продажи */
  {
    key: "salesAngle",
    label: "Угол подачи",
    group: "sales",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["problem", "Через проблему"],
      ["desired_result", "Через желаемый результат"],
      ["mistake", "Через ошибку"],
      ["lost_opportunity", "Через потерянную возможность"],
      ["saving", "Через экономию"],
      ["speed", "Через скорость"],
      ["simplicity", "Через простоту"],
      ["safety", "Через безопасность"],
      ["status", "Через статус"],
      ["novelty", "Через новизну"],
      ["comparison", "Через сравнение"],
      ["case", "Через кейс"],
      ["objection", "Через возражение"],
      ["demo", "Через демонстрацию"],
      ["personal_story", "Через личную историю"],
    ],
  },
  {
    key: "persuasionFormula",
    label: "Формула убеждения",
    group: "sales",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["aida", "Внимание → интерес → желание → действие"],
      ["pas", "Проблема → усиление → решение"],
      ["problem_consequence_solution", "Проблема → последствия → решение"],
      ["before_after_bridge", "До → после → мост"],
      ["story_insight_offer", "История → вывод → предложение"],
      ["objection_proof_offer", "Возражение → доказательство → предложение"],
      ["mistake_approach_product", "Ошибка → подход → продукт"],
      ["result_mechanism_cta", "Результат → механизм → призыв"],
      ["alternatives", "Сравнение альтернатив"],
      ["demo_benefit_action", "Демонстрация → выгода → действие"],
    ],
  },
  { key: "objectionToHandle", label: "Какое возражение закрыть", group: "sales", kind: "text" },
  {
    key: "priceMode",
    label: "Указывать цену",
    group: "sales",
    kind: "select",
    options: [
      ["auto", "Если уместно"],
      ["required", "Обязательно"],
      ["never", "Не указывать"],
    ],
  },
  {
    key: "salesPressure",
    label: "Уровень давления",
    group: "sales",
    kind: "select",
    options: [
      ["soft", "Без давления"],
      ["neutral", "Уверенный"],
      ["direct", "Прямой"],
    ],
  },
  {
    key: "scarcity",
    label: "Дефицит",
    group: "sales",
    kind: "select",
    options: [
      ["none", "Не использовать"],
      ["real_quantity", "Реальное ограничение количества"],
    ],
  },
  {
    key: "urgency",
    label: "Срочность",
    group: "sales",
    kind: "select",
    options: [
      ["none", "Без срочности"],
      ["deadline", "Реальный дедлайн"],
      ["event", "Событие"],
      ["price_increase", "Повышение цены"],
      ["enrollment_end", "Окончание набора"],
    ],
  },
  {
    key: "urgencyReason",
    label: "Реальная причина",
    group: "sales",
    kind: "text",
    help: "Без причины срочность и дефицит остановят генерацию: выдумывать их нельзя.",
    visibleWhen: (settings) => settings.urgency !== "none" || settings.scarcity !== "none",
    dependsOn: "срочность или дефицит",
  },
  { key: "eventDate", label: "Дата или событие", group: "sales", kind: "text", placeholder: "Например: 14 марта, конференция" },
  {
    key: "riskReducer",
    label: "Снижение риска",
    group: "sales",
    kind: "select",
    options: [
      ["none", "Не использовать"],
      ["guarantee", "Гарантия"],
      ["trial", "Пробный период"],
      ["consultation", "Бесплатная консультация"],
      ["refund", "Возврат"],
      ["demo", "Демонстрация"],
    ],
  },

  /* ------------------------------------------------------------------ CTA */
  { key: "cta", label: "Основное действие", group: "cta", kind: "select", simple: true, options: CTAS },
  { key: "ctaWording", label: "Конкретная формулировка", group: "cta", kind: "text" },
  { key: "ctaDestination", label: "Куда ведём", group: "cta", kind: "text" },
  { key: "ctaOutcome", label: "Что будет после действия", group: "cta", kind: "text" },
  { key: "ctaCodeword", label: "Кодовое слово", group: "cta", kind: "text" },
  { key: "secondaryCta", label: "Второй призыв", group: "cta", kind: "select", options: CTAS },
  {
    key: "ctaStrength",
    label: "Сила призыва",
    group: "cta",
    kind: "select",
    options: [
      ["soft", "Мягкая"],
      ["neutral", "Ясная"],
      ["direct", "Прямая"],
    ],
  },
  {
    key: "ctaPlacement",
    label: "Позиция призыва",
    group: "cta",
    kind: "select",
    options: [
      ["natural", "По смыслу"],
      ["end", "В конце"],
    ],
  },
  {
    key: "ctaRepeats",
    label: "Повторять призыв",
    group: "cta",
    kind: "select",
    options: [
      ["1", "Один раз"],
      ["2", "Два раза"],
    ],
  },
  { key: "ctaAddReason", label: "Добавлять причину действовать", group: "cta", kind: "toggle" },
  { key: "ctaNextStep", label: "Указывать следующий шаг", group: "cta", kind: "toggle" },

  /* -------------------------------------------------------------- контекст */
  {
    key: "trafficType",
    label: "Тип трафика",
    group: "context",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["organic", "Органический"],
      ["paid", "Рекламный"],
    ],
  },
  {
    key: "audienceTemperature",
    label: "Температура аудитории",
    group: "context",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["cold", "Холодная"],
      ["warm", "Тёплая"],
      ["hot", "Горячая"],
    ],
  },
  {
    key: "funnelStage",
    label: "Этап воронки",
    group: "context",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["awareness", "Знакомство"],
      ["problem", "Проблема"],
      ["solution", "Решение"],
      ["trust", "Доверие"],
      ["objection", "Возражение"],
      ["offer", "Предложение"],
      ["close", "Завершение"],
    ],
  },
  {
    key: "touchType",
    label: "Тип касания",
    group: "context",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["first", "Первое"],
      ["repeat", "Повторное"],
      ["final", "Финальное"],
    ],
  },
  { key: "campaign", label: "Кампания", group: "context", kind: "text" },
  {
    key: "seriesStage",
    label: "Серия постов",
    group: "context",
    kind: "select",
    options: [
      ["none", "Нет"],
      ["start", "Начало"],
      ["middle", "Середина"],
      ["finish", "Завершение"],
    ],
  },
  { key: "previousPost", label: "Что было до этого", group: "context", kind: "textarea" },
  { key: "nextPost", label: "Что будет дальше", group: "context", kind: "textarea" },
  { key: "audienceKnows", label: "Что аудитория уже знает", group: "context", kind: "textarea" },
  { key: "confidential", label: "Что нельзя раскрывать", group: "context", kind: "textarea" },
  {
    key: "relevance",
    label: "Актуальность",
    group: "context",
    kind: "select",
    options: [
      ["evergreen", "Вечнозелёный"],
      ["temporary", "Временный"],
      ["news", "Новостной"],
    ],
  },

  /* ----------------------------------------------------------------- голос */
  {
    key: "language",
    label: "Язык",
    group: "voice",
    kind: "select",
    simple: true,
    options: [
      ["auto", "Язык сообщения"],
      ["ru", "Русский"],
      ["en", "Английский"],
    ],
  },
  { key: "formality", label: "Тон", group: "voice", kind: "select", simple: true, options: TONE_OPTIONS },
  { key: "address", label: "Обращение", group: "voice", kind: "select", simple: true, options: ADDRESS_OPTIONS },
  { key: "energy", label: "Энергия", group: "voice", kind: "select", options: ENERGY_OPTIONS },
  { key: "humor", label: "Юмор", group: "voice", kind: "select", options: HUMOR_OPTIONS },
  { key: "profanityMode", label: "Мат", group: "voice", kind: "select", simple: true, options: PROFANITY_MODES },
  { key: "goodVoiceExamples", label: "Пиши примерно так", group: "voice", kind: "list", placeholder: "Пример на строку" },
  { key: "badVoiceExamples", label: "Никогда не пиши так", group: "voice", kind: "list", placeholder: "Антипример на строку" },
  { key: "signatureExpressions", label: "Фирменные выражения", group: "voice", kind: "list", placeholder: "Одно выражение на строку" },
  { key: "bannedExpressions", label: "Запрещённые выражения", group: "voice", kind: "list", placeholder: "Одно выражение на строку" },
  {
    key: "sentenceLength",
    label: "Длина предложений",
    group: "voice",
    kind: "select",
    options: [
      ["auto", "Авто"],
      ["short", "Короткие"],
      ["mixed", "Разный ритм"],
      ["long", "Развёрнутые"],
    ],
  },
  {
    key: "styleMatch",
    label: "Степень копирования",
    group: "voice",
    kind: "select",
    options: [
      ["light", "Лёгкое сходство"],
      ["recognizable", "Узнаваемый голос"],
      ["maximum", "Максимально близко"],
    ],
  },
  { key: "slangLevel", label: "Уровень сленга", group: "voice", kind: "select", options: LEVEL_OPTIONS },
  { key: "metaphorLevel", label: "Уровень метафор", group: "voice", kind: "select", options: LEVEL_OPTIONS },
  { key: "anglicisms", label: "Англицизмы", group: "voice", kind: "select", options: LEVEL_OPTIONS },
  {
    key: "rhetoricalQuestions",
    label: "Риторические вопросы",
    group: "voice",
    kind: "select",
    options: [
      ["none", "Запрещены"],
      ["low", "Редко"],
      ["medium", "Умеренно"],
      ["high", "Допустимы"],
    ],
  },
  { key: "provocationLevel", label: "Уровень провокации", group: "voice", kind: "select", options: LEVEL_OPTIONS },
  { key: "punctuationNotes", label: "Пунктуация", group: "voice", kind: "text", placeholder: "Тире, скобки, многоточия" },
  { key: "capitalsAllowed", label: "Разрешить заглавные слова", group: "voice", kind: "toggle" },
  { key: "neverStart", label: "Никогда не начинать", group: "voice", kind: "list", placeholder: "Вариант начала на строку" },
  { key: "neverEnd", label: "Никогда не заканчивать", group: "voice", kind: "list", placeholder: "Вариант финала на строку" },

  /* ------------------------------------------------------------ оформление */
  {
    key: "hook",
    label: "Тип начала",
    group: "format",
    kind: "select",
    options: [
      ["auto", "Авто — по содержанию"],
      ["insight", "Вывод"],
      ["benefit", "Польза"],
      ["problem", "Проблема"],
      ["story", "Сцена"],
      ["fact", "Факт"],
      ["question", "Вопрос"],
      ["contrast", "Контраст"],
      ["none", "Без отдельного начала"],
    ],
  },
  {
    key: "structure",
    label: "Структура",
    group: "format",
    kind: "select",
    options: [
      ["auto", "Авто — по материалу"],
      ["free", "Свободная"],
      ["explainer", "Объяснение"],
      ["problem_solution", "Проблема → решение"],
      ["story", "История"],
      ["list", "Список"],
      ["news", "Новость"],
      ["announcement", "Анонс"],
    ],
  },
  {
    key: "paragraphs",
    label: "Абзацы",
    group: "format",
    kind: "select",
    options: [
      ["auto", "Нативно площадке"],
      ["short", "1–2 предложения"],
      ["medium", "2–4 предложения"],
    ],
  },
  {
    key: "lists",
    label: "Списки",
    group: "format",
    kind: "select",
    options: [
      ["auto", "Только когда полезно"],
      ["avoid", "Не использовать"],
      ["prefer", "Предпочитать для шагов"],
      ["required", "Один список обязателен"],
    ],
  },
  { key: "emojiMode", label: "Эмодзи", group: "format", kind: "select", simple: true, options: EMOJI_MODES },
  {
    key: "emojiMax",
    label: "Точное количество эмодзи",
    group: "format",
    kind: "number",
    min: 0,
    max: 20,
    visibleWhen: (settings) => settings.emojiMode === "custom",
    dependsOn: "emojiMode = «Точное количество»",
  },
  {
    key: "emojiPlacement",
    label: "Позиция эмодзи",
    group: "format",
    kind: "select",
    options: [
      ["auto", "Нативно"],
      ["inline", "Внутри строк"],
      ["line_end", "В конце строк"],
      ["bullets", "Маркеры списка"],
    ],
  },
  {
    key: "hashtags",
    label: "Хэштеги",
    group: "format",
    kind: "select",
    simple: true,
    options: [
      ["auto", "Авто — по площадке"],
      ["none", "Без хэштегов"],
      ["custom", "Точное количество"],
    ],
  },
  {
    key: "hashtagCount",
    label: "Количество хэштегов",
    group: "format",
    kind: "number",
    min: 0,
    max: 30,
    visibleWhen: (settings) => settings.hashtags === "custom",
    dependsOn: "hashtags = «Точное количество»",
  },
  {
    key: "allowedEmojis",
    label: "Разрешённые эмодзи",
    group: "format",
    kind: "list",
    placeholder: "✅ 💡",
    visibleWhen: (settings) => settings.emojiMode !== "none",
    dependsOn: "эмодзи не запрещены",
  },
  { key: "forbiddenEmojis", label: "Запрещённые эмодзи", group: "format", kind: "list", placeholder: "🔥 🚀" },
  {
    key: "creativity",
    label: "Креативность",
    group: "format",
    kind: "select",
    options: [
      ["low", "Низкая — точность"],
      ["balanced", "Сбалансированная"],
      ["high", "Высокая без выдумки"],
    ],
  },

  /* -------------------------------------------------------- оригинальность */
  {
    key: "requireNewAngle",
    label: "Требовать новый угол",
    group: "originality",
    kind: "toggle",
    help: "Выключает весь блок сравнения с прошлыми публикациями.",
  },
  {
    key: "similarityLevel",
    label: "Максимальная похожесть",
    group: "originality",
    kind: "select",
    simple: true,
    options: [
      ["strict", "Строгая"],
      ["moderate", "Умеренная"],
      ["allow", "Повторы допустимы"],
    ],
    visibleWhen: (settings) => settings.requireNewAngle,
    dependsOn: "«Требовать новый угол» включено",
  },
  {
    key: "originalityDepth",
    label: "Глубина сравнения",
    group: "originality",
    kind: "select",
    options: [
      ["10", "Последние 10"],
      ["30", "Последние 30"],
      ["100", "Последние 100"],
      ["all", "Все доступные"],
    ],
    visibleWhen: (settings) => settings.requireNewAngle,
    dependsOn: "«Требовать новый угол» включено",
  },
  {
    key: "avoidRepetitions",
    label: "Не повторять",
    group: "originality",
    kind: "list",
    options: AVOID_REPETITION_OPTIONS,
    visibleWhen: (settings) => settings.requireNewAngle,
    dependsOn: "«Требовать новый угол» включено",
  },
  { key: "blockAiCliches", label: "Запрещать шаблонные фразы ИИ", group: "originality", kind: "toggle" },
  { key: "blockGenericPhrases", label: "Запрещать общие фразы", group: "originality", kind: "toggle" },
  { key: "requireConcreteExample", label: "Требовать конкретный пример", group: "originality", kind: "toggle" },
  {
    key: "showSimilarPosts",
    label: "Показывать похожие посты",
    group: "originality",
    kind: "toggle",
    help: "Показывает до трёх ближайших совпадений из истории канала перед генерацией.",
  },

  /* ----------------------------------------------------- точные требования */
  { key: "keywords", label: "Ключевые слова", group: "exact", kind: "list", placeholder: "Одно слово или фраза на строку" },
  { key: "mentions", label: "Упоминания", group: "exact", kind: "list", placeholder: "@channel" },
  { key: "links", label: "Ссылки", group: "exact", kind: "list", placeholder: "https://…" },
  { key: "forbiddenWords", label: "Запрещённые слова", group: "exact", kind: "list", placeholder: "Одно слово на строку" },
  { key: "forbiddenTopics", label: "Стоп-темы", group: "exact", kind: "list", placeholder: "Одна тема на строку" },

  /* ---------------------------------------------------------- комплектация */
  { key: "outputParts", label: "Что получить вместе с постом", group: "output", kind: "list", options: OUTPUT_PART_OPTIONS },
  {
    key: "variantChange",
    label: "Что менять в «Ещё вариант»",
    group: "output",
    kind: "select",
    options: [
      ["full", "Полностью другую концепцию"],
      ["hook", "Новое начало"],
      ["sales_angle", "Новый угол продажи"],
      ["structure", "Новую структуру"],
      ["emotional", "Более эмоциональный"],
      ["expert", "Более экспертный"],
      ["native", "Более естественный"],
    ],
  },
  { key: "qualityMode", label: "Режим качества", group: "output", kind: "select", simple: true, options: QUALITY_MODES },
  {
    key: "qualityThreshold",
    label: "Минимальная оценка",
    group: "output",
    kind: "select",
    options: [
      ["7", "7 из 10"],
      ["8", "8 из 10"],
      ["9", "9 из 10"],
    ],
  },
  {
    key: "autoImprove",
    label: "Автоматически переписывать при нарушении",
    group: "output",
    kind: "toggle",
    help: "Если проверка нашла нарушение настроек, Аврора сделает второй проход и исправит текст.",
  },

  /* -------------------------------------------------------------------------
     Служебные ключи модели. В интерфейсе не показываются, но обязаны быть в
     реестре: тест покрытия следит, чтобы новый ключ не остался без поля.
     ------------------------------------------------------------------------- */
  { key: "version", label: "Версия контракта настроек", group: "base", kind: "number", dead: true },
  {
    key: "hideCriticalResult",
    label: "Скрывать критичный результат",
    group: "output",
    kind: "toggle",
    dead: true,
  },
];

export const POST_SETTINGS_FIELD_BY_KEY: ReadonlyMap<PostSettingsFieldKey, PostSettingsField> = new Map(
  POST_SETTINGS_FIELDS.map((field) => [field.key, field]),
);

/** Поля, которые в модели есть, но в интерфейс не выводятся (служебные). */
export function isTechnicalField(field: PostSettingsField): boolean {
  return field.dead === true;
}

/** Поля группы с учётом применимости к текущим настройкам. */
export function fieldsForGroup(group: PostSettingsGroupId, settings: PostSettings): PostSettingsField[] {
  return POST_SETTINGS_FIELDS.filter(
    (field) => field.group === group && !isTechnicalField(field) && (!field.visibleWhen || field.visibleWhen(settings)),
  );
}

/** Все поля, которые сейчас видны пользователю (для поиска и счётчиков). */
export function visibleFields(settings: PostSettings): PostSettingsField[] {
  return POST_SETTINGS_FIELDS.filter((field) => !isTechnicalField(field) && (!field.visibleWhen || field.visibleWhen(settings)));
}

/**
 * Поиск по полям: подпись, подсказка, ключ и варианты ответа.
 * Русская раскладка и регистр не важны — настройки ищут в спешке.
 */
export function searchFields(query: string, settings: PostSettings): PostSettingsField[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  return visibleFields(settings).filter((field) => {
    const haystack = [field.label, field.help ?? "", field.placeholder ?? "", field.key, ...(field.options ?? []).map(([, label]) => label)]
      .join(" ")
      .toLowerCase();
    return haystack.includes(needle);
  });
}
