/**
 * Контракт «настройка → модель» для всех 128 полей PostSettings.
 *
 * Зачем: диалог «Настройки» в Content Studio собирает PostSettings, роут
 * `POST /api/ai/generate` превращает их в промпт через `buildPostSettingsPrompt`, а часть
 * требований дополнительно доезжает детерминированным слоем
 * (`finalizePostSettingsDeterministically`, `validatePostSettingsResult`,
 * `validatePostSettingsConflicts`, `postSettingsQualityOverrides`) или поведением роута.
 *
 * Тест машинно проверяет для КАЖДОГО поля нормализованного объекта:
 *   (a) значение по умолчанию совпадает с тем, что заявлено в таблице и в DEFAULT_POST_SETTINGS;
 *   (b) отличимое от умолчания значение МЕНЯЕТ строку промпта — или поле явно перечислено
 *       как не влияющее на промпт с покрытием детерминированным слоем / пометкой DEAD.
 *
 * Механизмы (колонка `mechanism`):
 *   prompt            — текст промпта (buildPostSettingsPrompt)
 *   finalize          — детерминированная постобработка (finalizePostSettingsDeterministically)
 *   validator         — проверки результата (validatePostSettingsResult)
 *   conflicts         — проверки брифа (validatePostSettingsConflicts)
 *   quality-gate      — postSettingsQualityOverrides (жёсткие лимиты quality-gate)
 *   server-behaviour  — читается вне post-settings.ts (роут), в промпт не попадает
 *   client-only       — только интерфейс, на генерацию не влияет
 *   dead              — DEAD: не читается нигде, кроме самого контракта
 *   patch-only        — сам не влияет, но патчит другие поля (applyPostPreset)
 *   structural        — служебное поле контракта
 *
 * Известные расхождения (проверяются явно, ниже):
 *   hideCriticalResult  — DEAD: единственное место чтения — нормализация.
 *   showSimilarPosts    — client-only: рисует блок похожих постов в чате студии.
 *   preset              — прямого влияния на промпт нет; работают только поля, которые он патчит.
 *   blockAiCliches      — в промпт не попадает; работает через quality-gate и валидатор.
 *   autoImprove         — поведение роута (повторный проход), не промпт.
 */

import { describe, expect, it } from "vitest";

import type { AiKind } from "./ai-provider";
import {
  DEFAULT_POST_SETTINGS,
  POST_PRESETS,
  applyPostPreset,
  buildPostSettingsPrompt,
  finalizePostSettingsDeterministically,
  normalizePostSettings,
  postSettingsQualityOverrides,
  validatePostSettingsConflicts,
  validatePostSettingsResult,
  type PostSettings,
} from "./post-settings";

type PromptContext = { network?: string | null; kind?: AiKind; task?: string };
type Patch = Record<string, unknown>;

type Mechanism =
  | "prompt"
  | "finalize"
  | "validator"
  | "conflicts"
  | "quality-gate"
  | "server-behaviour"
  | "client-only"
  | "dead"
  | "patch-only"
  | "structural";

interface FieldContract {
  field: keyof PostSettings;
  /** Значение по умолчанию, которое заявляет сам код (DEFAULT_POST_SETTINGS). */
  default: unknown;
  mechanism: readonly Mechanism[];
  /** Отличимое от умолчания значение, которое обязано изменить промпт. */
  promptValue?: unknown;
  /** Дополнительные настройки, без которых условный блок поля не активен. */
  base?: Patch;
  context?: PromptContext;
  /** Все допустимые значения enum-поля: проверяются на сохранение и различимость в промпте. */
  allowedValues?: readonly unknown[];
  /** false — не все значения обязаны давать разный промпт (см. note). */
  allPromptValuesDistinct?: boolean;
  /** Значения для полей без влияния на промпт: промпт обязан не меняться. */
  noPromptValues?: readonly unknown[];
  note?: string;
}

const EN_DASH = "\u2013";
const PRICE = "9 900 \u20BD";
const PROOF = {
  id: "proof-1",
  type: "case",
  text: "Кейс: 120 клиентов за квартал",
  source: "внутренний отчёт",
  validAt: "2026-01",
  required: false,
  allowClientName: false,
  allowParaphrase: true,
} as const;

const PROOF_COUNT_VALUES = ["auto", "0", "1", "2", "3_plus"] as const;
const CTA_VALUES = [
  "auto", "none", "comment", "save", "share", "subscribe", "click", "buy", "reply", "register", "download",
] as const;
const VOICE_VALUES = ["none", "low", "medium", "high"] as const;

/**
 * Таблица контракта. Одна запись — одно поле PostSettings.
 * Порядок совпадает с порядком ключей в интерфейсе PostSettings.
 */
const FIELD_CONTRACTS: readonly FieldContract[] = [
  {
    field: "version",
    default: 1,
    mechanism: ["structural"],
    noPromptValues: [0, 1, 2, 99],
    note: "Служебная версия контракта: нормализация всегда возвращает 1.",
  },
  {
    field: "target",
    default: "auto",
    mechanism: ["prompt", "validator"],
    context: { network: "vk" },
    promptValue: "youtube_title",
    allowedValues: [
      "auto", "instagram_post", "instagram_reel", "telegram_channel", "vk_community",
      "youtube_title", "youtube_description", "youtube_community",
    ],
    allPromptValuesDistinct: false,
    note: "auto разрешается по сети/формату: в контексте network=vk он совпадает с vk_community.",
  },
  {
    field: "preset",
    default: "auto",
    mechanism: ["patch-only"],
    noPromptValues: ["auto", ...POST_PRESETS.map((preset) => preset.id), "custom"],
    note: "Пресет не читается промптом: нормализация хранит id, а поля применяет applyPostPreset.",
  },
  {
    field: "goal",
    default: "auto",
    mechanism: ["prompt", "conflicts"],
    promptValue: "warmup",
    allowedValues: ["auto", "reach", "engagement", "sale", "traffic", "education", "announcement", "warmup"],
  },
  {
    field: "mainIdea",
    default: "",
    mechanism: ["prompt", "finalize"],
    promptValue: "Запускаем курс по договорам",
    note: "Кроме промпта, главная мысль участвует в подборе хэштегов при finalize.",
  },
  { field: "readerUnderstanding", default: "", mechanism: ["prompt"], promptValue: "Понимает, зачем нужен договор" },
  {
    field: "desiredFeeling",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "inspiration",
    allowedValues: ["auto", "interest", "trust", "desire", "urgency", "relief", "inspiration"],
  },
  { field: "readerAction", default: "", mechanism: ["prompt", "conflicts"], promptValue: "Оставить заявку на разбор" },
  {
    field: "primaryMetric",
    default: "auto",
    mechanism: ["prompt", "conflicts"],
    promptValue: "sales",
    allowedValues: ["auto", "readthrough", "saves", "comments", "clicks", "leads", "sales"],
  },
  {
    field: "messageCount",
    default: "one",
    mechanism: ["prompt"],
    promptValue: "several",
    allowedValues: ["one", "one_plus", "several"],
  },
  {
    field: "includeConclusion",
    default: true,
    mechanism: ["prompt", "quality-gate"],
    promptValue: false,
    allowedValues: [true, false],
  },
  {
    field: "promotionType",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "lead_magnet",
    allowedValues: ["auto", "product", "service", "event", "personal_brand", "lead_magnet"],
  },
  {
    field: "promotionName",
    default: "",
    mechanism: ["prompt", "finalize", "conflicts"],
    promptValue: "Курс «Договоры без страха»",
  },
  { field: "offer", default: "", mechanism: ["prompt", "conflicts"], promptValue: "Разбор договора за 2 дня" },
  { field: "mainBenefit", default: "", mechanism: ["prompt", "conflicts"], promptValue: "Меньше правок и рисков" },
  { field: "differentiation", default: "", mechanism: ["prompt"], promptValue: "Проверяет практикующий юрист" },
  {
    field: "price",
    default: "",
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: PRICE,
    note: "В промпте есть только при priceMode != never; иначе строка «цену не указывать».",
  },
  { field: "offerDestination", default: "", mechanism: ["prompt"], promptValue: "Личные сообщения" },
  {
    field: "salesIntensity",
    default: "native",
    mechanism: ["prompt"],
    promptValue: "direct",
    allowedValues: ["native", "soft", "confident", "direct"],
  },
  {
    field: "productReveal",
    default: "after_problem",
    mechanism: ["prompt"],
    promptValue: "cta_only",
    allowedValues: ["immediately", "after_problem", "near_end", "cta_only"],
  },
  { field: "audience", default: "", mechanism: ["prompt"], promptValue: "Юристы-предприниматели" },
  {
    field: "awareness",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "ready",
    allowedValues: ["auto", "unaware", "problem_aware", "solution_aware", "product_aware", "ready"],
  },
  { field: "readerSituation", default: "", mechanism: ["prompt"], promptValue: "Открывает ИП и боится ошибок" },
  { field: "audienceProblem", default: "", mechanism: ["prompt"], promptValue: "Нет времени разбираться в договорах" },
  { field: "desiredResult", default: "", mechanism: ["prompt"], promptValue: "Подписывать договор без юриста" },
  { field: "emotionalDesire", default: "", mechanism: ["prompt"], promptValue: "Спокойствие" },
  { field: "primaryFear", default: "", mechanism: ["prompt"], promptValue: "Пропустить опасный пункт" },
  { field: "barrier", default: "", mechanism: ["prompt"], promptValue: "Думает, что это дорого" },
  { field: "objection", default: "", mechanism: ["prompt"], promptValue: "У меня всё просто, юрист не нужен" },
  { field: "failedAttempts", default: "", mechanism: ["prompt"], promptValue: "Скачивал шаблоны из интернета" },
  { field: "currentAlternative", default: "", mechanism: ["prompt"], promptValue: "Типовой шаблон из поиска" },
  { field: "purchaseTrigger", default: "", mechanism: ["prompt"], promptValue: "Срыв сделки из-за пункта" },
  { field: "choiceCriterion", default: "", mechanism: ["prompt"], promptValue: "Опыт в моей отрасли" },
  {
    field: "trustLevel",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "customer",
    allowedValues: ["auto", "cold", "familiar", "warm", "customer"],
  },
  { field: "audienceLanguage", default: "", mechanism: ["prompt"], promptValue: "Говорит «по-простому»" },
  { field: "excludedAudience", default: "", mechanism: ["prompt"], promptValue: "Крупный корпоративный бизнес" },
  {
    field: "language",
    default: "auto",
    mechanism: ["prompt", "validator"],
    promptValue: "en",
    allowedValues: ["auto", "ru", "en"],
  },
  {
    field: "length",
    default: "auto",
    mechanism: ["prompt", "validator"],
    context: { network: "youtube" },
    promptValue: "long",
    allowedValues: ["auto", "short", "medium", "long", "custom"],
    note: "Контекст youtube_community выбран потому, что на части площадок mediumRange совпадает с defaultRange.",
  },
  {
    field: "customMinChars",
    default: null,
    mechanism: ["prompt", "validator"],
    base: { length: "custom" },
    promptValue: 640,
    allowedValues: [150, 300, 640],
    note: "Работает только при length=custom; производное умолчание — 300.",
  },
  {
    field: "customMaxChars",
    default: null,
    mechanism: ["prompt", "validator"],
    base: { length: "custom" },
    promptValue: 1900,
    allowedValues: [900, 1200, 1900],
    note: "Работает только при length=custom; производное умолчание — 1200.",
  },
  {
    field: "formality",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "formal",
    allowedValues: ["auto", "casual", "neutral", "formal"],
  },
  { field: "energy", default: "auto", mechanism: ["prompt"], promptValue: "high", allowedValues: ["auto", "calm", "balanced", "high"] },
  { field: "humor", default: "auto", mechanism: ["prompt"], promptValue: "bold", allowedValues: ["auto", "none", "light", "bold"] },
  {
    field: "profanityMode",
    default: "auto",
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: "required_direct",
    allowedValues: ["auto", "forbid", "allow", "masked", "required_direct"],
  },
  {
    field: "address",
    default: "auto",
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: "вы",
    allowedValues: ["auto", "ты", "вы", "neutral"],
  },
  {
    field: "emojiMode",
    default: "auto",
    mechanism: ["prompt", "finalize", "validator", "quality-gate"],
    promptValue: "many",
    allowedValues: ["auto", "none", "few", "moderate", "many", "custom"],
  },
  {
    field: "emojiMax",
    default: null,
    mechanism: ["prompt", "finalize", "validator", "quality-gate"],
    base: { emojiMode: "custom" },
    promptValue: 7,
    allowedValues: [0, 3, 7, 20],
    note: "Работает только при emojiMode=custom; производное умолчание — 3.",
  },
  {
    field: "emojiPlacement",
    default: "auto",
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: "line_end",
    allowedValues: ["auto", "inline", "line_end", "bullets"],
  },
  {
    field: "allowedEmojis",
    default: [],
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: ["✨", "✅"],
    note: "Нормализация обнуляет список при emojiMode=none.",
  },
  {
    field: "forbiddenEmojis",
    default: [],
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: ["🔥"],
  },
  {
    field: "hook",
    default: "auto",
    mechanism: ["prompt", "quality-gate"],
    promptValue: "question",
    allowedValues: ["auto", "insight", "benefit", "problem", "story", "fact", "question", "contrast", "none"],
  },
  {
    field: "structure",
    default: "auto",
    mechanism: ["prompt", "validator"],
    promptValue: "story",
    allowedValues: ["auto", "free", "explainer", "problem_solution", "story", "list", "news", "announcement"],
  },
  {
    field: "paragraphs",
    default: "auto",
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: "medium",
    allowedValues: ["auto", "short", "medium"],
  },
  {
    field: "lists",
    default: "auto",
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: "required",
    allowedValues: ["auto", "avoid", "prefer", "required"],
  },
  {
    field: "cta",
    default: "auto",
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: "buy",
    allowedValues: CTA_VALUES,
  },
  { field: "ctaWording", default: "", mechanism: ["prompt", "validator"], promptValue: "Напишите «разбор» в комментариях" },
  { field: "ctaDestination", default: "", mechanism: ["prompt", "validator"], promptValue: "https://aurora.example/razbor" },
  { field: "ctaOutcome", default: "", mechanism: ["prompt"], promptValue: "Пришлём чек-лист по договору" },
  { field: "ctaCodeword", default: "", mechanism: ["prompt", "validator"], promptValue: "ДОГОВОР" },
  {
    field: "secondaryCta",
    default: "none",
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: "subscribe",
    allowedValues: CTA_VALUES,
  },
  {
    field: "ctaRepeats",
    default: 1,
    mechanism: ["prompt", "validator"],
    promptValue: 2,
    allowedValues: [1, 2],
  },
  { field: "ctaAddReason", default: false, mechanism: ["prompt"], promptValue: true, allowedValues: [true, false] },
  { field: "ctaNextStep", default: true, mechanism: ["prompt"], promptValue: false, allowedValues: [true, false] },
  {
    field: "ctaStrength",
    default: "soft",
    mechanism: ["prompt"],
    promptValue: "direct",
    allowedValues: ["soft", "neutral", "direct"],
  },
  {
    field: "ctaPlacement",
    default: "natural",
    mechanism: ["prompt", "validator"],
    promptValue: "end",
    allowedValues: ["natural", "end"],
  },
  {
    field: "hashtags",
    default: "auto",
    mechanism: ["prompt", "finalize", "validator", "quality-gate"],
    context: { network: "vk" },
    promptValue: "custom",
    allowedValues: ["auto", "none", "custom"],
    note: "Контекст VK: у Telegram defaultHashtagMax=0, поэтому auto и none там дают одинаковый промпт.",
  },
  {
    field: "hashtagCount",
    default: null,
    mechanism: ["prompt", "finalize", "validator", "quality-gate"],
    base: { hashtags: "custom" },
    promptValue: 7,
    allowedValues: [0, 3, 7],
    note: "Работает только при hashtags=custom; производное умолчание — 3.",
  },
  {
    field: "keywords",
    default: [],
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: ["договор", "юрист"],
  },
  { field: "mentions", default: [], mechanism: ["prompt", "validator"], promptValue: ["@aurora_legal"] },
  { field: "links", default: [], mechanism: ["prompt", "validator"], promptValue: ["https://aurora.example/guide"] },
  {
    field: "requiredFacts",
    default: [],
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: ["Цена — 9 900 ₽"],
  },
  {
    field: "forbiddenWords",
    default: [],
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: ["бесплатно"],
  },
  {
    field: "forbiddenTopics",
    default: [],
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: ["политика"],
  },
  {
    field: "creativity",
    default: "balanced",
    mechanism: ["prompt", "conflicts"],
    promptValue: "high",
    allowedValues: ["low", "balanced", "high"],
  },
  {
    field: "proofs",
    default: [],
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: [PROOF],
  },
  {
    field: "factStrictness",
    default: "off",
    mechanism: ["prompt", "quality-gate", "conflicts"],
    promptValue: "verified",
    allowedValues: ["off", "verified", "verified_inference", "general", "creative_no_new_facts"],
  },
  {
    field: "missingFactsMode",
    default: "omit",
    mechanism: ["prompt"],
    promptValue: "placeholder",
    allowedValues: ["ask", "omit", "neutral", "placeholder"],
  },
  {
    field: "salesAngle",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "personal_story",
    allowedValues: [
      "auto", "problem", "desired_result", "mistake", "lost_opportunity", "saving", "speed", "simplicity",
      "safety", "status", "novelty", "comparison", "case", "objection", "demo", "personal_story",
    ],
  },
  {
    field: "persuasionFormula",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "demo_benefit_action",
    allowedValues: [
      "auto", "aida", "pas", "problem_consequence_solution", "before_after_bridge", "story_insight_offer",
      "objection_proof_offer", "mistake_approach_product", "result_mechanism_cta", "alternatives", "demo_benefit_action",
    ],
  },
  { field: "objectionToHandle", default: "", mechanism: ["prompt"], promptValue: "Дорого для маленькой фирмы" },
  {
    field: "proofCount",
    default: "auto",
    mechanism: ["prompt"],
    base: { proofs: [PROOF] },
    promptValue: "3_plus",
    allowedValues: PROOF_COUNT_VALUES,
    note: "Строка промпта появляется только при proofs.length > 0.",
  },
  {
    field: "priceMode",
    default: "auto",
    mechanism: ["prompt", "validator", "conflicts"],
    base: { price: PRICE },
    promptValue: "never",
    allowedValues: ["auto", "required", "never"],
    allPromptValuesDistinct: false,
    note: "auto и required дают одну строку «цена: …»; разницу (обязательность) держат conflicts/validator.",
  },
  {
    field: "salesPressure",
    default: "soft",
    mechanism: ["prompt"],
    promptValue: "direct",
    allowedValues: ["soft", "neutral", "direct"],
  },
  {
    field: "scarcity",
    default: "none",
    mechanism: ["prompt", "validator", "conflicts"],
    base: { urgencyReason: "осталось 4 места" },
    promptValue: "real_quantity",
    allowedValues: ["none", "real_quantity"],
    note: "Основание дефицита берётся из urgencyReason.",
  },
  {
    field: "urgency",
    default: "none",
    mechanism: ["prompt", "validator", "conflicts"],
    base: { urgencyReason: "до 30 сентября" },
    promptValue: "deadline",
    allowedValues: ["none", "deadline", "event", "price_increase", "enrollment_end"],
  },
  {
    field: "urgencyReason",
    default: "",
    mechanism: ["prompt", "validator", "conflicts"],
    base: { urgency: "deadline" },
    promptValue: "до 30 сентября",
    note: "Сам по себе не влияет на промпт: нужна urgency != none или scarcity=real_quantity.",
  },
  {
    field: "riskReducer",
    default: "none",
    mechanism: ["prompt"],
    promptValue: "guarantee",
    allowedValues: ["none", "guarantee", "trial", "consultation", "refund", "demo"],
  },
  {
    field: "trafficType",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "paid",
    allowedValues: ["auto", "organic", "paid"],
  },
  {
    field: "audienceTemperature",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "hot",
    allowedValues: ["auto", "cold", "warm", "hot"],
  },
  {
    field: "funnelStage",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "close",
    allowedValues: ["auto", "awareness", "problem", "solution", "trust", "objection", "offer", "close"],
  },
  {
    field: "touchType",
    default: "auto",
    mechanism: ["prompt"],
    promptValue: "final",
    allowedValues: ["auto", "first", "repeat", "final"],
  },
  { field: "campaign", default: "", mechanism: ["prompt"], promptValue: "Запуск курса, осень 2026" },
  {
    field: "seriesStage",
    default: "none",
    mechanism: ["prompt"],
    promptValue: "finish",
    allowedValues: ["none", "start", "middle", "finish"],
  },
  { field: "previousPost", default: "", mechanism: ["prompt"], promptValue: "Разбирали типовые ошибки в договорах" },
  { field: "nextPost", default: "", mechanism: ["prompt"], promptValue: "Покажем чек-лист проверки договора" },
  { field: "audienceKnows", default: "", mechanism: ["prompt"], promptValue: "Уже знает, что договор можно проверить" },
  { field: "confidential", default: "", mechanism: ["prompt"], promptValue: "Название клиента и сумма сделки" },
  {
    field: "eventDate",
    default: "",
    mechanism: ["prompt", "validator", "conflicts"],
    promptValue: "30 сентября",
  },
  {
    field: "relevance",
    default: "evergreen",
    mechanism: ["prompt"],
    promptValue: "news",
    allowedValues: ["evergreen", "temporary", "news"],
  },
  {
    field: "originalityDepth",
    default: "10",
    mechanism: ["prompt"],
    promptValue: "all",
    allowedValues: ["10", "30", "100", "all"],
    note: "Живёт внутри блока оригинальности (requireNewAngle=true).",
  },
  {
    field: "avoidRepetitions",
    default: ["hooks", "cta", "structure", "phrases"],
    mechanism: ["prompt"],
    promptValue: [],
    note: "Живёт внутри блока оригинальности (requireNewAngle=true).",
  },
  {
    field: "similarityLevel",
    default: "moderate",
    mechanism: ["prompt", "validator"],
    promptValue: "strict",
    allowedValues: ["strict", "moderate", "allow"],
    note: "В промпте — внутри блока оригинальности; порог похожести validator применяет при requireNewAngle.",
  },
  {
    field: "blockAiCliches",
    default: true,
    mechanism: ["validator", "quality-gate"],
    noPromptValues: [true, false],
    note: "В промпт не попадает: работает через forbiddenPhrases quality-gate и проверку forbidden_phrase.",
  },
  {
    field: "blockGenericPhrases",
    default: true,
    mechanism: ["prompt"],
    promptValue: false,
    allowedValues: [true, false],
  },
  {
    field: "requireConcreteExample",
    default: false,
    mechanism: ["prompt", "validator"],
    promptValue: true,
    allowedValues: [true, false],
  },
  {
    field: "requireNewAngle",
    default: true,
    mechanism: ["prompt", "validator"],
    promptValue: false,
    allowedValues: [true, false],
    note: "Гейт всего блока оригинальности: avoidRepetitions, originalityDepth, similarityLevel.",
  },
  {
    field: "showSimilarPosts",
    default: false,
    mechanism: ["client-only"],
    noPromptValues: [true, false],
    note: "Читается только в src/app/app/studio/page.tsx (блок похожих постов в чате).",
  },
  { field: "goodVoiceExamples", default: [], mechanism: ["prompt"], promptValue: ["Пишу простыми словами, без канцелярита"] },
  { field: "badVoiceExamples", default: [], mechanism: ["prompt"], promptValue: ["В современном мире важно отметить"] },
  {
    field: "signatureExpressions",
    default: [],
    mechanism: ["prompt", "validator"],
    promptValue: ["Проверено на практике"],
  },
  {
    field: "bannedExpressions",
    default: [],
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: ["уникальное предложение"],
  },
  {
    field: "sentenceLength",
    default: "auto",
    mechanism: ["prompt", "validator"],
    promptValue: "short",
    allowedValues: ["auto", "short", "mixed", "long"],
  },
  { field: "slangLevel", default: "low", mechanism: ["prompt"], promptValue: "high", allowedValues: VOICE_VALUES },
  { field: "metaphorLevel", default: "low", mechanism: ["prompt"], promptValue: "none", allowedValues: VOICE_VALUES },
  { field: "anglicisms", default: "low", mechanism: ["prompt"], promptValue: "none", allowedValues: VOICE_VALUES },
  {
    field: "rhetoricalQuestions",
    default: "low",
    mechanism: ["prompt", "validator"],
    promptValue: "high",
    allowedValues: VOICE_VALUES,
  },
  { field: "punctuationNotes", default: "", mechanism: ["prompt"], promptValue: "Тире вместо дефиса" },
  {
    field: "capitalsAllowed",
    default: false,
    mechanism: ["prompt", "finalize", "validator"],
    promptValue: true,
    allowedValues: [true, false],
  },
  { field: "provocationLevel", default: "low", mechanism: ["prompt"], promptValue: "high", allowedValues: VOICE_VALUES },
  { field: "neverStart", default: [], mechanism: ["prompt", "validator"], promptValue: ["В современном мире"] },
  { field: "neverEnd", default: [], mechanism: ["prompt", "validator"], promptValue: ["Подписывайтесь на канал"] },
  {
    field: "styleMatch",
    default: "recognizable",
    mechanism: ["prompt"],
    promptValue: "maximum",
    allowedValues: ["light", "recognizable", "maximum"],
  },
  {
    field: "outputParts",
    default: ["main"],
    mechanism: ["prompt", "finalize"],
    promptValue: ["hooks"],
    note: "Нормализация всегда добавляет main первым; каждый дополнительный материал меняет промпт.",
  },
  {
    field: "variantChange",
    default: "full",
    mechanism: ["prompt"],
    promptValue: "native",
    allowedValues: ["full", "hook", "sales_angle", "structure", "emotional", "expert", "native"],
  },
  {
    field: "qualityMode",
    default: "fast",
    mechanism: ["prompt", "quality-gate"],
    promptValue: "maximum",
    allowedValues: ["fast", "balanced", "maximum"],
  },
  {
    field: "autoImprove",
    default: true,
    mechanism: ["server-behaviour"],
    noPromptValues: [true, false],
    note: "Читается в src/app/api/ai/generate/route.ts (гейт повторного прохода), промпт не меняет.",
  },
  {
    field: "qualityThreshold",
    default: 8,
    mechanism: ["prompt", "validator", "quality-gate"],
    promptValue: 9,
    allowedValues: [7, 8, 9],
  },
  {
    field: "hideCriticalResult",
    default: true,
    mechanism: ["dead"],
    noPromptValues: [true, false],
    note: "DEAD: кроме самой нормализации поле нигде не читается (в т.ч. в UI).",
  },
];

const NORMALIZED_DEFAULTS = normalizePostSettings({});
const ALL_FIELDS = Object.keys(NORMALIZED_DEFAULTS) as Array<keyof PostSettings>;
const CONTRACT_BY_FIELD = new Map(FIELD_CONTRACTS.map((entry) => [entry.field, entry]));

function promptOf(entry: FieldContract, value?: unknown): string {
  const patch: Patch = { ...(entry.base ?? {}) };
  // Значение подставляется только при явном вызове: promptOf(entry) — базовый промпт.
  if (value !== undefined) patch[entry.field as string] = value;
  return buildPostSettingsPrompt(patch, entry.context ?? {});
}

/** Первая различающаяся строка — чтобы падение называло поле и место, а не просто «строки разные». */
function explainDifference(before: string, after: string): string {
  const left = before.split("\n");
  const right = after.split("\n");
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] !== right[index]) {
      return `строка ${index + 1}: ${JSON.stringify(left[index] ?? null)} → ${JSON.stringify(right[index] ?? null)}`;
    }
  }
  return "строки совпадают, отличается только длина";
}

function collisions(values: ReadonlyArray<[string, string]>): string[] {
  const byPrompt = new Map<string, string[]>();
  for (const [value, prompt] of values) {
    const list = byPrompt.get(prompt) ?? [];
    list.push(value);
    byPrompt.set(prompt, list);
  }
  return [...byPrompt.values()].filter((group) => group.length > 1).map((group) => group.join(" ≡ "));
}

function label(value: unknown): string {
  return JSON.stringify(value);
}

const SAMPLE = "Договор можно проверить за один вечер. Напишите «разбор», и мы пришлём чек-лист.";

describe("контракт настроек: таблица покрытия", () => {
  it("таблица покрывает ровно те 128 полей, которые возвращает normalizePostSettings({})", () => {
    const covered = FIELD_CONTRACTS.map((entry) => String(entry.field));
    const duplicates = covered.filter((field, index) => covered.indexOf(field) !== index);
    const normalized = ALL_FIELDS.map(String);
    const missing = normalized.filter((field) => !covered.includes(field));
    const extra = covered.filter((field) => !normalized.includes(field));

    expect({ duplicates, missing, extra }, "таблица контракта разошлась с normalizePostSettings").toEqual({
      duplicates: [],
      missing: [],
      extra: [],
    });
    expect(ALL_FIELDS).toHaveLength(128);
  });

  it("каждое поле либо имеет prompt-значение, либо явно перечислено как не влияющее на промпт", () => {
    const broken = FIELD_CONTRACTS
      .filter((entry) => entry.promptValue === undefined && !entry.noPromptValues)
      .map(String);
    expect(broken, "поле без promptValue обязано иметь noPromptValues + объяснение").toEqual([]);

    const noPrompt = FIELD_CONTRACTS.filter((entry) => entry.promptValue === undefined).map((entry) => String(entry.field));
    expect(noPrompt, "список полей без влияния на промпт изменился — обновите отчёт и комментарий").toEqual([
      "version", "preset", "blockAiCliches", "showSimilarPosts", "autoImprove", "hideCriticalResult",
    ]);
  });

  it("каждое поле без prompt-эффекта снабжено объяснением механизма", () => {
    const undocumented = FIELD_CONTRACTS
      .filter((entry) => entry.promptValue === undefined && !entry.note)
      .map(String);
    expect(undocumented, "поле без promptValue обязано иметь note с механизмом").toEqual([]);
    const promptWithoutMechanism = FIELD_CONTRACTS
      .filter((entry) => entry.promptValue !== undefined && !entry.mechanism.includes("prompt"))
      .map(String);
    expect(promptWithoutMechanism, "promptValue без механизма prompt").toEqual([]);
  });
});

describe("контракт настроек: значения по умолчанию", () => {
  for (const entry of FIELD_CONTRACTS) {
    it(`[${String(entry.field)}] default = ${label(entry.default)}`, () => {
      expect(NORMALIZED_DEFAULTS[entry.field], `normalizePostSettings({}).${String(entry.field)}`).toEqual(entry.default);
      expect(DEFAULT_POST_SETTINGS[entry.field], `DEFAULT_POST_SETTINGS.${String(entry.field)}`).toEqual(entry.default);
    });
  }
});

describe("контракт настроек: поле доходит до промпта", () => {
  for (const entry of FIELD_CONTRACTS) {
    if (entry.promptValue === undefined) continue;
    it(`[${String(entry.field)}] ${label(entry.promptValue)} меняет buildPostSettingsPrompt`, () => {
      const baseline = promptOf(entry);
      const changed = promptOf(entry, entry.promptValue);
      expect(
        changed,
        `Поле ${String(entry.field)}=${label(entry.promptValue)} не доехало до промпта. ${explainDifference(baseline, changed)}`,
      ).not.toBe(baseline);
    });
  }
});

describe("контракт настроек: все допустимые значения enum-полей", () => {
  for (const entry of FIELD_CONTRACTS) {
    if (entry.promptValue === undefined || !entry.allowedValues) continue;
    it(`[${String(entry.field)}] значения ${entry.allowedValues.map(label).join(", ")} сохраняются и различимы`, () => {
      const prompts: Array<[string, string]> = [];
      for (const value of entry.allowedValues ?? []) {
        const normalized = normalizePostSettings({ ...(entry.base ?? {}), [entry.field]: value })[entry.field];
        expect(normalized, `normalizePostSettings потеряла ${String(entry.field)}=${label(value)}`).toEqual(value);
        prompts.push([label(value), promptOf(entry, value)]);
      }

      const first = prompts[0];
      const last = prompts[prompts.length - 1];
      expect(
        last[1],
        `Поле ${String(entry.field)}: крайние значения ${first[0]} и ${last[0]} неразличимы в промпте`,
      ).not.toBe(first[1]);

      if (entry.allPromptValuesDistinct !== false) {
        expect(
          collisions(prompts),
          `Поле ${String(entry.field)}: часть значений даёт одинаковый промпт`,
        ).toEqual([]);
      }
    });
  }
});

describe("контракт настроек: поля без влияния на промпт", () => {
  for (const entry of FIELD_CONTRACTS) {
    if (entry.promptValue !== undefined) continue;
    it(`[${String(entry.field)}] не меняет промпт ни при одном значении`, () => {
      const baseline = promptOf(entry);
      for (const value of entry.noPromptValues ?? []) {
        const normalized = normalizePostSettings({ [entry.field]: value })[entry.field];
        if (entry.field !== "version") {
          expect(normalized, `normalizePostSettings потеряла ${String(entry.field)}=${label(value)}`).toEqual(value);
        } else {
          expect(normalized, "version всегда нормализуется в 1").toBe(1);
        }
        expect(
          promptOf(entry, value),
          `Поле ${String(entry.field)}=${label(value)} неожиданно влияет на промпт — обновите контракт`,
        ).toBe(baseline);
      }
    });
  }
});

describe("контракт настроек: условная проводка", () => {
  it("emojiMax действует только при emojiMode: custom", () => {
    expect(normalizePostSettings({ emojiMode: "custom" }).emojiMax, "производное умолчание").toBe(3);
    expect(buildPostSettingsPrompt({ emojiMode: "custom", emojiMax: 7 })).toContain("эмодзи: ровно 7");

    // "none" детерминированно фиксирует 0, остальные не-custom режимы обнуляют поле в null.
    expect(normalizePostSettings({ emojiMode: "none", emojiMax: 7 }).emojiMax).toBe(0);
    for (const mode of ["auto", "few", "moderate", "many"] as const) {
      expect(
        normalizePostSettings({ emojiMode: mode, emojiMax: 7 }).emojiMax,
        `emojiMax должен обнуляться в null при emojiMode=${mode}`,
      ).toBeNull();
    }
    for (const mode of ["auto", "none", "few", "moderate", "many"] as const) {
      expect(
        buildPostSettingsPrompt({ emojiMode: mode, emojiMax: 7 }),
        `emojiMax не должен влиять на промпт при emojiMode=${mode}`,
      ).toBe(buildPostSettingsPrompt({ emojiMode: mode }));
    }
  });

  it("hashtagCount действует только при hashtags: custom", () => {
    expect(normalizePostSettings({ hashtags: "custom" }).hashtagCount, "производное умолчание").toBe(3);
    expect(buildPostSettingsPrompt({ hashtags: "custom", hashtagCount: 7 })).toContain("хэштеги: ровно 7");

    // "none" фиксирует 0, режим auto обнуляет поле в null.
    expect(normalizePostSettings({ hashtags: "none", hashtagCount: 7 }).hashtagCount).toBe(0);
    expect(normalizePostSettings({ hashtags: "auto", hashtagCount: 7 }).hashtagCount).toBeNull();
    for (const mode of ["auto", "none"] as const) {
      expect(
        buildPostSettingsPrompt({ hashtags: mode, hashtagCount: 7 }),
        `hashtagCount не должен влиять на промпт при hashtags=${mode}`,
      ).toBe(buildPostSettingsPrompt({ hashtags: mode }));
    }
  });

  it("customMinChars/customMaxChars действуют только при length: custom", () => {
    const custom = buildPostSettingsPrompt({ length: "custom", customMinChars: 111, customMaxChars: 222 });
    expect(custom).toContain(`111${EN_DASH}222`);
    expect(normalizePostSettings({ length: "custom" }).customMinChars, "производное умолчание min").toBe(300);
    expect(normalizePostSettings({ length: "custom" }).customMaxChars, "производное умолчание max").toBe(1200);

    for (const length of ["auto", "short", "medium", "long"] as const) {
      const settings = normalizePostSettings({ length, customMinChars: 111, customMaxChars: 222 });
      expect(settings.customMinChars, `customMinChars должен обнуляться при length=${length}`).toBeNull();
      expect(settings.customMaxChars, `customMaxChars должен обнуляться при length=${length}`).toBeNull();
      expect(
        buildPostSettingsPrompt({ length, customMinChars: 111, customMaxChars: 222 }),
        `точный диапазон не должен влиять на промпт при length=${length}`,
      ).toBe(buildPostSettingsPrompt({ length }));
    }
  });

  it("proofCount действует только когда proofs.length > 0", () => {
    expect(
      buildPostSettingsPrompt({ proofCount: "3_plus" }),
      "без доказательств proofCount не должен менять промпт",
    ).toBe(buildPostSettingsPrompt({}));
    expect(buildPostSettingsPrompt({ proofs: [PROOF], proofCount: "3_plus" })).toContain("3_plus");
    expect(buildPostSettingsPrompt({ proofs: [PROOF] })).toContain("по необходимости");
  });

  it("price отбрасывается при priceMode: never", () => {
    const allowed = buildPostSettingsPrompt({ price: PRICE });
    const forbidden = buildPostSettingsPrompt({ price: PRICE, priceMode: "never" });
    expect(allowed).toContain(PRICE);
    expect(forbidden).not.toContain(PRICE);
    expect(forbidden).toContain("цену не указывать");
  });

  it("весь блок оригинальности действует только при requireNewAngle: true", () => {
    const enabled = {
      avoidRepetitions: [] as string[],
      originalityDepth: "all",
      similarityLevel: "strict",
    };
    const off = buildPostSettingsPrompt({ requireNewAngle: false, ...enabled });
    expect(
      off,
      "avoidRepetitions/originalityDepth/similarityLevel не должны протекать в промпт при requireNewAngle=false",
    ).toBe(buildPostSettingsPrompt({ requireNewAngle: false }));
    expect(off).not.toContain("похожесть");
    expect(off).not.toContain("последними публикациями");

    const on = buildPostSettingsPrompt({ requireNewAngle: true, ...enabled });
    // Значения уходят в промпт человеческими подписями, а не машинными слагами:
    // «строгая» вместо «strict», «всеми доступными публикациями» вместо «all последними».
    expect(on).toContain("допустимая похожесть: строгая");
    expect(on).toContain("сравни с всеми доступными публикациями");
    expect(on).not.toContain("похожесть: strict");
    expect(on).not.toContain("all последними");
  });

  it("urgencyReason действует только при urgency != none или scarcity: real_quantity", () => {
    expect(
      buildPostSettingsPrompt({ urgencyReason: "до 30 сентября" }),
      "без срочности и дефицита причина не должна попадать в промпт",
    ).toBe(buildPostSettingsPrompt({}));
    expect(buildPostSettingsPrompt({ urgency: "deadline", urgencyReason: "до 30 сентября" })).toContain("до 30 сентября");
    expect(buildPostSettingsPrompt({ scarcity: "real_quantity", urgencyReason: "осталось 4 места" })).toContain("осталось 4 места");
  });

  it("allowedEmojis сбрасывается при emojiMode: none", () => {
    expect(normalizePostSettings({ emojiMode: "none", allowedEmojis: ["✨"] }).allowedEmojis).toEqual([]);
    expect(buildPostSettingsPrompt({ emojiMode: "none", allowedEmojis: ["✨"] })).toBe(
      buildPostSettingsPrompt({ emojiMode: "none" }),
    );
  });
});

describe("контракт настроек: крайние пары значений, названные в задании", () => {
  const PAIRS: ReadonlyArray<readonly [keyof PostSettings, unknown, unknown]> = [
    ["emojiMode", "none", "many"],
    ["hashtags", "none", "custom"],
    ["length", "short", "long"],
    ["address", "ты", "вы"],
    ["language", "ru", "en"],
    ["formality", "casual", "formal"],
    ["profanityMode", "forbid", "required_direct"],
    ["priceMode", "required", "never"],
    ["similarityLevel", "strict", "allow"],
    ["cta", "none", "buy"],
    ["hook", "none", "question"],
    ["structure", "list", "story"],
    ["lists", "avoid", "required"],
    ["urgency", "deadline", "enrollment_end"],
    ["riskReducer", "none", "guarantee"],
    ["creativity", "low", "high"],
  ];

  for (const [field, left, right] of PAIRS) {
    it(`[${String(field)}] ${label(left)} и ${label(right)} дают разный промпт`, () => {
      const entry = CONTRACT_BY_FIELD.get(field);
      expect(entry, `нет контракта для ${String(field)}`).toBeDefined();
      const contract = entry as FieldContract;
      const leftPrompt = promptOf(contract, left);
      const rightPrompt = promptOf(contract, right);
      expect(
        rightPrompt,
        `Поле ${String(field)}: ${label(left)} и ${label(right)} неразличимы. ${explainDifference(leftPrompt, rightPrompt)}`,
      ).not.toBe(leftPrompt);
    });
  }
});

describe("контракт настроек: состав outputParts", () => {
  const LABELS: ReadonlyArray<readonly [string, string]> = [
    ["hooks", "5 вариантов начала"],
    ["titles", "3 варианта заголовка"],
    ["cover", "текст на обложку"],
    ["first_comment", "первый комментарий"],
    ["pinned_comment", "закреплённый комментарий"],
    ["hashtags", "хэштеги"],
    ["alt", "описание изображения"],
    ["visual_brief", "задание для изображения"],
    ["image_idea", "идея изображения"],
    ["short_version", "короткая версия"],
    ["stories", "версия для историй"],
    ["cross_platform", "версия для другой площадки"],
    ["comment_replies", "ответы на вероятные комментарии"],
    ["utm", "ссылка с меткой"],
    ["discussion_question", "вопрос для обсуждения"],
  ];

  it("каждый дополнительный материал доезжает до промпта вместе с main", () => {
    const baseline = buildPostSettingsPrompt({ outputParts: ["main"] });
    for (const [part, expectedLabel] of LABELS) {
      const prompt = buildPostSettingsPrompt({ outputParts: ["main", part] });
      expect(prompt, `outputParts=${part} не изменил промпт`).not.toBe(baseline);
      expect(prompt, `outputParts=${part} потерял подпись «${expectedLabel}»`).toContain(expectedLabel);
    }
  });

  it("main подставляется нормализацией всегда и не дублируется", () => {
    expect(normalizePostSettings({ outputParts: ["hooks"] }).outputParts).toEqual(["main", "hooks"]);
    expect(normalizePostSettings({ outputParts: ["hooks", "main"] }).outputParts).toEqual(["main", "hooks"]);
    expect(normalizePostSettings({ outputParts: [] }).outputParts).toEqual(["main"]);
  });
});

describe("контракт настроек: контекстные и производные совпадения", () => {
  // Эти совпадения — не баги, а следствие платформенных правил и нормализации. Они
  // машинно объясняют, почему enum-тесты выше выбрали именно такие base/context.
  it("Telegram: hashtags auto и none совпадают, потому что defaultHashtagMax = 0", () => {
    expect(buildPostSettingsPrompt({ hashtags: "auto" })).toBe(buildPostSettingsPrompt({ hashtags: "none" }));
    expect(buildPostSettingsPrompt({ hashtags: "auto" })).toContain("хэштеги: ровно 0");
    expect(buildPostSettingsPrompt({ hashtags: "auto" }, { network: "vk" })).toContain("хэштеги: 0–5");
  });

  it("Telegram: length auto и medium совпадают, потому что mediumRange = defaultRange", () => {
    expect(buildPostSettingsPrompt({ length: "auto" })).toBe(buildPostSettingsPrompt({ length: "medium" }));
  });

  it("priceMode: auto и required дают одну строку промпта, разницу держат conflicts и validator", () => {
    expect(buildPostSettingsPrompt({ price: PRICE, priceMode: "auto" })).toBe(
      buildPostSettingsPrompt({ price: PRICE, priceMode: "required" }),
    );
    expect(validatePostSettingsConflicts({ priceMode: "required" }).map((item) => item.code)).toContain("required_price");
    expect(validatePostSettingsConflicts({ priceMode: "required", price: PRICE })).toEqual([]);
    expect(
      validatePostSettingsResult(SAMPLE, { priceMode: "required", price: PRICE }).violations.map((item) => item.code),
    ).toContain("price_required");
    expect(
      validatePostSettingsResult(`${SAMPLE} ${PRICE}`, { priceMode: "never", price: PRICE }).violations.map((item) => item.code),
    ).toContain("price_forbidden");
  });

  it("target: auto разрешается по сети и совпадает с явной площадкой", () => {
    expect(buildPostSettingsPrompt({ target: "auto" }, { network: "vk" })).toBe(
      buildPostSettingsPrompt({ target: "vk_community" }, { network: "vk" }),
    );
    expect(buildPostSettingsPrompt({ target: "auto" }, { network: "vk" })).not.toBe(
      buildPostSettingsPrompt({ target: "telegram_channel" }, { network: "vk" }),
    );
  });
});

describe("контракт настроек: мёртвые и расходящиеся поля", () => {
  it("hideCriticalResult — DEAD: не читается ни промптом, ни детерминированным слоем, ни валидатором", () => {
    // DEAD: единственные чтения — нормализация (src/lib/post-settings.ts:779) и реестр полей
    // (src/lib/post-settings-fields.ts:975, помечен dead: true). Ни роут, ни UI его не читают.
    // Если поле начнёт на что-то влиять, этот тест обязан упасть.
    expect(normalizePostSettings({ hideCriticalResult: false }).hideCriticalResult, "поле хотя бы хранится").toBe(false);
    expect(buildPostSettingsPrompt({ hideCriticalResult: false })).toBe(buildPostSettingsPrompt({ hideCriticalResult: true }));
    expect(finalizePostSettingsDeterministically(SAMPLE, { hideCriticalResult: false })).toBe(
      finalizePostSettingsDeterministically(SAMPLE, { hideCriticalResult: true }),
    );
    expect(postSettingsQualityOverrides({ hideCriticalResult: false })).toEqual(
      postSettingsQualityOverrides({ hideCriticalResult: true }),
    );
    expect(validatePostSettingsResult(SAMPLE, { hideCriticalResult: false }).violations).toEqual(
      validatePostSettingsResult(SAMPLE, { hideCriticalResult: true }).violations,
    );
  });

  it("showSimilarPosts — client-only: блок похожих постов в чате, генерацию не меняет", () => {
    // Читается только в src/app/app/studio/page.tsx:2433,2540 и в реестре полей.
    expect(buildPostSettingsPrompt({ showSimilarPosts: true })).toBe(buildPostSettingsPrompt({ showSimilarPosts: false }));
    expect(finalizePostSettingsDeterministically(SAMPLE, { showSimilarPosts: true })).toBe(
      finalizePostSettingsDeterministically(SAMPLE, { showSimilarPosts: false }),
    );
    expect(postSettingsQualityOverrides({ showSimilarPosts: true })).toEqual(
      postSettingsQualityOverrides({ showSimilarPosts: false }),
    );
  });

  it("preset — прямого влияния на промпт нет, работают только поля, которые он патчит", () => {
    for (const preset of POST_PRESETS) {
      expect(
        buildPostSettingsPrompt({ preset: preset.id }),
        `preset=${preset.id} не должен сам менять промпт`,
      ).toBe(buildPostSettingsPrompt({ preset: "auto" }));
    }
    expect(buildPostSettingsPrompt({ preset: "custom" })).toBe(buildPostSettingsPrompt({}));

    // Патч пресета применяет applyPostPreset — и уже эти поля доезжают до модели.
    for (const preset of POST_PRESETS) {
      expect(
        buildPostSettingsPrompt(applyPostPreset({}, preset.id)),
        `патч preset=${preset.id} обязан менять промпт через свои поля`,
      ).not.toBe(buildPostSettingsPrompt({}));
    }
  });

  it("blockAiCliches — не в промпте, но действует в quality-gate и валидаторе", () => {
    expect(buildPostSettingsPrompt({ blockAiCliches: false })).toBe(buildPostSettingsPrompt({ blockAiCliches: true }));

    const on = postSettingsQualityOverrides({ blockAiCliches: true }).forbiddenPhrases as string[];
    const off = postSettingsQualityOverrides({ blockAiCliches: false }).forbiddenPhrases as string[];
    expect(on).toContain("в современном мире");
    expect(off).not.toContain("в современном мире");
    expect(off.length).toBeLessThan(on.length);

    const text = "В современном мире важно отметить, что договор можно проверить.";
    const flagged = validatePostSettingsResult(text, { blockAiCliches: true }).violations.map((item) => item.message);
    const allowed = validatePostSettingsResult(text, { blockAiCliches: false }).violations.map((item) => item.message);
    expect(flagged.some((message) => message.includes("в современном мире"))).toBe(true);
    expect(allowed.some((message) => message.includes("в современном мире"))).toBe(false);
  });

  it("autoImprove — поведение роута, а не промпт", () => {
    // Читается в src/app/api/ai/generate/route.ts:897,1039 (гейт повторного прохода).
    // Модуль роута тянет БД и провайдеров, поэтому проверяется отсутствие влияния на
    // детерминированный слой и фиксируется фактическое место чтения.
    expect(buildPostSettingsPrompt({ autoImprove: false })).toBe(buildPostSettingsPrompt({ autoImprove: true }));
    expect(postSettingsQualityOverrides({ autoImprove: false })).toEqual(postSettingsQualityOverrides({ autoImprove: true }));
    expect(finalizePostSettingsDeterministically(SAMPLE, { autoImprove: false })).toBe(
      finalizePostSettingsDeterministically(SAMPLE, { autoImprove: true }),
    );
  });
});
