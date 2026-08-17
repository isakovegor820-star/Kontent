/**
 * Единый контракт настроек одной публикации.
 *
 * Модуль намеренно не импортирует React, БД или серверные зависимости: одни и те же
 * правила используют клиент, Route Handler, prompt builder и unit-тесты. Паспорт
 * канала отвечает за постоянный голос бренда и факты; этот контракт — только за
 * конкретный результат генерации.
 */

import type { AiKind } from "./ai-provider";

export type PostTarget =
  | "auto"
  | "instagram_post"
  | "instagram_reel"
  | "telegram_channel"
  | "vk_community"
  | "youtube_title"
  | "youtube_description"
  | "youtube_community";

export type PostPresetId =
  | "auto"
  | "expert"
  | "selling"
  | "engaging"
  | "informational"
  | "storytelling"
  | "news"
  | "announcement"
  | "entertaining"
  | "personal"
  | "premium"
  | "bold"
  | "minimal"
  | "custom";

export type PostGoal = "auto" | "reach" | "engagement" | "sale" | "traffic" | "education" | "announcement" | "warmup";
export type AudienceAwareness = "auto" | "unaware" | "problem_aware" | "solution_aware" | "product_aware" | "ready";
export type PostLength = "auto" | "short" | "medium" | "long" | "custom";
export type Formality = "auto" | "casual" | "neutral" | "formal";
export type Energy = "auto" | "calm" | "balanced" | "high";
export type Humor = "auto" | "none" | "light" | "bold";
export type ProfanityMode = "auto" | "forbid" | "allow" | "masked" | "required_direct";
export type Address = "auto" | "ты" | "вы" | "neutral";
export type EmojiMode = "auto" | "none" | "few" | "moderate" | "many" | "custom";
export type EmojiPlacement = "auto" | "inline" | "line_end" | "bullets";
export type HookType = "auto" | "insight" | "benefit" | "problem" | "story" | "fact" | "question" | "contrast" | "none";
export type StructureType = "auto" | "free" | "explainer" | "problem_solution" | "story" | "list" | "news" | "announcement";
export type ParagraphLength = "auto" | "short" | "medium";
export type ListMode = "auto" | "avoid" | "prefer" | "required";
export type CtaType = "auto" | "none" | "comment" | "save" | "share" | "subscribe" | "click" | "buy" | "reply" | "register" | "download";
export type CtaStrength = "soft" | "neutral" | "direct";
export type CtaPlacement = "natural" | "end";
export type HashtagMode = "auto" | "none" | "custom";
export type Creativity = "low" | "balanced" | "high";
export type PromotionType = "auto" | "product" | "service" | "event" | "personal_brand" | "lead_magnet";
export type SalesIntensity = "native" | "soft" | "confident" | "direct";
export type ProductReveal = "immediately" | "after_problem" | "near_end" | "cta_only";
export type DesiredFeeling = "auto" | "interest" | "trust" | "desire" | "urgency" | "relief" | "inspiration";
export type PrimaryMetric = "auto" | "readthrough" | "saves" | "comments" | "clicks" | "leads" | "sales";
export type MessageCount = "one" | "one_plus" | "several";
export type TrustLevel = "auto" | "cold" | "familiar" | "warm" | "customer";
export type FactStrictness = "off" | "verified" | "verified_inference" | "general" | "creative_no_new_facts";
export type MissingFactsMode = "ask" | "omit" | "neutral" | "placeholder";
export type ProofType = "number" | "statistic" | "case" | "review" | "quote" | "experience" | "research" | "certificate" | "demo" | "comparison" | "product_fact";
export type SalesAngle = "auto" | "problem" | "desired_result" | "mistake" | "lost_opportunity" | "saving" | "speed" | "simplicity" | "safety" | "status" | "novelty" | "comparison" | "case" | "objection" | "demo" | "personal_story";
export type PersuasionFormula = "auto" | "aida" | "pas" | "problem_consequence_solution" | "before_after_bridge" | "story_insight_offer" | "objection_proof_offer" | "mistake_approach_product" | "result_mechanism_cta" | "alternatives" | "demo_benefit_action";
export type ProofCount = "auto" | "0" | "1" | "2" | "3_plus";
export type PriceMode = "auto" | "required" | "never";
export type ScarcityMode = "none" | "real_quantity";
export type UrgencyMode = "none" | "deadline" | "event" | "price_increase" | "enrollment_end";
export type RiskReducer = "none" | "guarantee" | "trial" | "consultation" | "refund" | "demo";
export type TrafficType = "auto" | "organic" | "paid";
export type AudienceTemperature = "auto" | "cold" | "warm" | "hot";
export type FunnelStage = "auto" | "awareness" | "problem" | "solution" | "trust" | "objection" | "offer" | "close";
export type TouchType = "auto" | "first" | "repeat" | "final";
export type SeriesStage = "none" | "start" | "middle" | "finish";
export type Relevance = "evergreen" | "temporary" | "news";
export type HistoryDepth = "10" | "30" | "100" | "all";
export type SimilarityLevel = "strict" | "moderate" | "allow";
export type SentenceLength = "auto" | "short" | "mixed" | "long";
export type VoiceLevel = "none" | "low" | "medium" | "high";
export type StyleMatch = "light" | "recognizable" | "maximum";
export type QualityMode = "fast" | "balanced" | "maximum";
export type QualityThreshold = 7 | 8 | 9;
export type VariantChange = "full" | "hook" | "sales_angle" | "structure" | "emotional" | "expert" | "native";
export type OutputPart = "main" | "hooks" | "titles" | "cover" | "first_comment" | "pinned_comment" | "hashtags" | "alt" | "visual_brief" | "image_idea" | "short_version" | "stories" | "cross_platform" | "comment_replies" | "utm" | "discussion_question";
export type RepetitionPart = "hooks" | "cta" | "stories" | "examples" | "structure" | "phrases";

export interface PostProof {
  id: string;
  type: ProofType;
  text: string;
  source: string;
  validAt: string;
  required: boolean;
  allowClientName: boolean;
  allowParaphrase: boolean;
}

export interface PostSettings {
  version: 1;
  target: PostTarget;
  preset: PostPresetId;
  goal: PostGoal;
  mainIdea: string;
  readerUnderstanding: string;
  desiredFeeling: DesiredFeeling;
  readerAction: string;
  primaryMetric: PrimaryMetric;
  messageCount: MessageCount;
  includeConclusion: boolean;
  promotionType: PromotionType;
  promotionName: string;
  offer: string;
  mainBenefit: string;
  differentiation: string;
  price: string;
  offerDestination: string;
  salesIntensity: SalesIntensity;
  productReveal: ProductReveal;
  audience: string;
  awareness: AudienceAwareness;
  readerSituation: string;
  audienceProblem: string;
  desiredResult: string;
  emotionalDesire: string;
  primaryFear: string;
  barrier: string;
  objection: string;
  failedAttempts: string;
  currentAlternative: string;
  purchaseTrigger: string;
  choiceCriterion: string;
  trustLevel: TrustLevel;
  audienceLanguage: string;
  excludedAudience: string;
  language: "auto" | "ru" | "en";
  length: PostLength;
  customMinChars: number | null;
  customMaxChars: number | null;
  formality: Formality;
  energy: Energy;
  humor: Humor;
  profanityMode: ProfanityMode;
  address: Address;
  emojiMode: EmojiMode;
  emojiMax: number | null;
  emojiPlacement: EmojiPlacement;
  allowedEmojis: string[];
  forbiddenEmojis: string[];
  hook: HookType;
  structure: StructureType;
  paragraphs: ParagraphLength;
  lists: ListMode;
  cta: CtaType;
  ctaWording: string;
  ctaDestination: string;
  ctaOutcome: string;
  ctaCodeword: string;
  secondaryCta: CtaType;
  ctaRepeats: 1 | 2;
  ctaAddReason: boolean;
  ctaNextStep: boolean;
  ctaStrength: CtaStrength;
  ctaPlacement: CtaPlacement;
  hashtags: HashtagMode;
  hashtagCount: number | null;
  keywords: string[];
  mentions: string[];
  links: string[];
  requiredFacts: string[];
  forbiddenWords: string[];
  forbiddenTopics: string[];
  creativity: Creativity;
  proofs: PostProof[];
  factStrictness: FactStrictness;
  missingFactsMode: MissingFactsMode;
  salesAngle: SalesAngle;
  persuasionFormula: PersuasionFormula;
  objectionToHandle: string;
  proofCount: ProofCount;
  priceMode: PriceMode;
  salesPressure: CtaStrength;
  scarcity: ScarcityMode;
  urgency: UrgencyMode;
  urgencyReason: string;
  riskReducer: RiskReducer;
  trafficType: TrafficType;
  audienceTemperature: AudienceTemperature;
  funnelStage: FunnelStage;
  touchType: TouchType;
  campaign: string;
  seriesStage: SeriesStage;
  previousPost: string;
  nextPost: string;
  audienceKnows: string;
  confidential: string;
  eventDate: string;
  relevance: Relevance;
  originalityDepth: HistoryDepth;
  avoidRepetitions: RepetitionPart[];
  similarityLevel: SimilarityLevel;
  blockAiCliches: boolean;
  blockGenericPhrases: boolean;
  requireConcreteExample: boolean;
  requireNewAngle: boolean;
  showSimilarPosts: boolean;
  goodVoiceExamples: string[];
  badVoiceExamples: string[];
  signatureExpressions: string[];
  bannedExpressions: string[];
  sentenceLength: SentenceLength;
  slangLevel: VoiceLevel;
  metaphorLevel: VoiceLevel;
  anglicisms: VoiceLevel;
  rhetoricalQuestions: VoiceLevel;
  punctuationNotes: string;
  capitalsAllowed: boolean;
  provocationLevel: VoiceLevel;
  neverStart: string[];
  neverEnd: string[];
  styleMatch: StyleMatch;
  outputParts: OutputPart[];
  variantChange: VariantChange;
  qualityMode: QualityMode;
  autoImprove: boolean;
  qualityThreshold: QualityThreshold;
  hideCriticalResult: boolean;
}

export interface PlatformRule {
  id: Exclude<PostTarget, "auto">;
  platform: "instagram" | "telegram" | "vk" | "youtube";
  format: string;
  label: string;
  shortLabel: string;
  defaultRange: readonly [number, number];
  shortRange: readonly [number, number];
  mediumRange: readonly [number, number];
  longRange: readonly [number, number];
  hardLimit: number;
  hardLimitUnit: "chars" | "bytes";
  hardLimitAuthority: "platform" | "product";
  defaultEmojiMax: number;
  defaultHashtagMax: number;
  platformHashtagMax: number;
  platformMentionMax: number | null;
  guidance: readonly string[];
  source: string;
}

/**
 * Hard limits come from provider/API documentation where it exposes one. Ranges are
 * editorial product presets, deliberately not presented as universal “best length”.
 * VK and YouTube Community do not expose a stable public text cap in the official
 * references we can reliably validate, so Aurora uses a conservative product ceiling.
 */
export const POST_TARGET_RULES: Record<Exclude<PostTarget, "auto">, PlatformRule> = {
  instagram_post: {
    id: "instagram_post",
    platform: "instagram",
    format: "подпись к публикации",
    label: "Instagram · публикация",
    shortLabel: "Instagram пост",
    defaultRange: [500, 1200],
    shortRange: [180, 500],
    mediumRange: [500, 1200],
    longRange: [1200, 2100],
    hardLimit: 2200,
    hardLimitUnit: "chars",
    hardLimitAuthority: "platform",
    defaultEmojiMax: 3,
    defaultHashtagMax: 5,
    platformHashtagMax: 30,
    platformMentionMax: 20,
    guidance: [
      "Подпись дополняет визуал, а не пересказывает его.",
      "Смысл первой строки понятен до раскрытия подписи.",
      "Не делай необработанную ссылку главным призывом: в подписи по ней обычно неудобно переходить.",
    ],
    source: "https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api",
  },
  instagram_reel: {
    id: "instagram_reel",
    platform: "instagram",
    format: "подпись к короткому видео",
    label: "Instagram · короткое видео",
    shortLabel: "Instagram · видео",
    defaultRange: [250, 800],
    shortRange: [120, 350],
    mediumRange: [350, 900],
    longRange: [900, 2100],
    hardLimit: 2200,
    hardLimitUnit: "chars",
    hardLimitAuthority: "platform",
    defaultEmojiMax: 3,
    defaultHashtagMax: 5,
    platformHashtagMax: 30,
    platformMentionMax: 20,
    guidance: [
      "Первая строка продолжает обещание ролика и даёт контекст без пересказа кадров.",
      "Короткие абзацы подходят мобильному просмотру; призыв связан с просмотренным роликом.",
      "Не делай необработанную ссылку главным призывом.",
    ],
    source: "https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api",
  },
  telegram_channel: {
    id: "telegram_channel",
    platform: "telegram",
    format: "пост канала",
    label: "Telegram · канал",
    shortLabel: "Telegram",
    defaultRange: [700, 1600],
    shortRange: [250, 700],
    mediumRange: [700, 1600],
    longRange: [1600, 3600],
    hardLimit: 4096,
    hardLimitUnit: "chars",
    hardLimitAuthority: "platform",
    defaultEmojiMax: 2,
    defaultHashtagMax: 0,
    platformHashtagMax: 10,
    platformMentionMax: null,
    guidance: [
      "Пост читается как самостоятельное сообщение автора, без подписи интерфейса.",
      "Абзацы короткие, но ритм не механический; списки только когда упрощают смысл.",
      "Ссылку можно дать прямо в тексте, если она действительно нужна для цели.",
    ],
    source: "https://core.telegram.org/bots/api#sendmessage",
  },
  vk_community: {
    id: "vk_community",
    platform: "vk",
    format: "пост сообщества",
    label: "VK · сообщество",
    shortLabel: "VK",
    defaultRange: [700, 1800],
    shortRange: [250, 700],
    mediumRange: [700, 1800],
    longRange: [1800, 5000],
    hardLimit: 15_000,
    hardLimitUnit: "chars",
    hardLimitAuthority: "product",
    defaultEmojiMax: 3,
    defaultHashtagMax: 5,
    platformHashtagMax: 10,
    platformMentionMax: null,
    guidance: [
      "Первые абзацы дают контекст и пользу ещё до раскрытия длинного текста.",
      "Допустим более подробный разбор, но без стены одинаковых абзацев.",
      "Ссылка и вложение упоминаются естественно, без рекламной канцелярщины.",
    ],
    source: "https://github.com/VKCOM/vk-api-schema",
  },
  youtube_title: {
    id: "youtube_title",
    platform: "youtube",
    format: "заголовок видео",
    label: "YouTube · заголовок",
    shortLabel: "YouTube заголовок",
    defaultRange: [45, 70],
    shortRange: [25, 50],
    mediumRange: [45, 75],
    longRange: [70, 100],
    hardLimit: 100,
    hardLimitUnit: "chars",
    hardLimitAuthority: "platform",
    defaultEmojiMax: 0,
    defaultHashtagMax: 0,
    platformHashtagMax: 0,
    platformMentionMax: null,
    guidance: [
      "Верни одну строку без кавычек, пояснений, призыва и финальной точки.",
      "Главная тема и обещание понятны без кликбейта; важные слова стоят ближе к началу.",
      "Символы < и > запрещены технически.",
    ],
    source: "https://developers.google.com/youtube/v3/docs/videos#snippet.title",
  },
  youtube_description: {
    id: "youtube_description",
    platform: "youtube",
    format: "описание видео",
    label: "YouTube · описание",
    shortLabel: "YouTube описание",
    defaultRange: [800, 2000],
    shortRange: [300, 800],
    mediumRange: [800, 2000],
    longRange: [2000, 4500],
    hardLimit: 5000,
    hardLimitUnit: "bytes",
    hardLimitAuthority: "platform",
    defaultEmojiMax: 2,
    defaultHashtagMax: 3,
    platformHashtagMax: 15,
    platformMentionMax: null,
    guidance: [
      "Первые строки кратко объясняют ценность видео; детали, ссылки и главы идут ниже.",
      "Не выдумывай таймкоды, ссылки или участников, которых нет в исходных данных.",
      "Символы < и > запрещены технически.",
    ],
    source: "https://developers.google.com/youtube/v3/docs/videos#snippet.description",
  },
  youtube_community: {
    id: "youtube_community",
    platform: "youtube",
    format: "публикация сообщества",
    label: "YouTube · сообщество",
    shortLabel: "YouTube · сообщество",
    defaultRange: [300, 900],
    shortRange: [120, 350],
    mediumRange: [350, 900],
    longRange: [900, 1500],
    hardLimit: 1500,
    hardLimitUnit: "chars",
    hardLimitAuthority: "product",
    defaultEmojiMax: 2,
    defaultHashtagMax: 3,
    platformHashtagMax: 10,
    platformMentionMax: null,
    guidance: [
      "Пост рассчитан на диалог со зрителями канала, а не выглядит как описание видео.",
      "Вопрос, опрос или призыв должны быть естественным продолжением конкретной мысли.",
    ],
    source: "https://support.google.com/youtube/answer/9409631",
  },
};

export const POST_TARGET_OPTIONS = Object.values(POST_TARGET_RULES);

export interface PostPreset {
  id: Exclude<PostPresetId, "auto" | "custom">;
  label: string;
  description: string;
  patch: Partial<PostSettings>;
}

export const POST_PRESETS: readonly PostPreset[] = [
  { id: "expert", label: "Экспертный", description: "Конкретно, уверенно и без рекламного шума.", patch: { goal: "education", formality: "neutral", energy: "balanced", humor: "light", hook: "insight", structure: "explainer", length: "medium", cta: "auto", creativity: "balanced" } },
  { id: "selling", label: "Продающий", description: "Польза → решение → ясное действие, без ложной срочности.", patch: { goal: "sale", energy: "balanced", hook: "problem", structure: "problem_solution", cta: "buy", ctaStrength: "direct", length: "medium", creativity: "balanced" } },
  { id: "engaging", label: "Вовлекающий", description: "Одна сильная мысль и причина ответить по существу.", patch: { goal: "engagement", energy: "high", hook: "question", structure: "free", cta: "comment", ctaStrength: "soft", length: "short", creativity: "high" } },
  { id: "informational", label: "Информационный", description: "Факты и контекст без навязанной продажи.", patch: { goal: "education", energy: "calm", humor: "none", hook: "fact", structure: "explainer", cta: "none", length: "medium", creativity: "low" } },
  { id: "storytelling", label: "Сторителлинг", description: "Сцена, развитие и вывод без театрального пафоса.", patch: { goal: "engagement", formality: "casual", energy: "balanced", hook: "story", structure: "story", cta: "auto", length: "long", creativity: "high" } },
  { id: "news", label: "Новость", description: "Событие, значение и последствия — сразу к сути.", patch: { goal: "reach", formality: "neutral", energy: "balanced", humor: "none", hook: "fact", structure: "news", cta: "none", length: "short", creativity: "low" } },
  { id: "announcement", label: "Анонс", description: "Что, для кого, когда и зачем участвовать.", patch: { goal: "announcement", energy: "high", hook: "benefit", structure: "announcement", cta: "click", ctaStrength: "neutral", length: "short", creativity: "balanced" } },
  { id: "entertaining", label: "Развлекательный", description: "Живой ритм и уместная игра, но не клоунада.", patch: { goal: "reach", formality: "casual", energy: "high", humor: "bold", hook: "contrast", structure: "free", cta: "share", length: "short", creativity: "high" } },
  { id: "personal", label: "Личный", description: "Наблюдение от первого лица и честный вывод.", patch: { goal: "engagement", formality: "casual", energy: "balanced", humor: "light", address: "ты", hook: "story", structure: "story", cta: "reply", length: "medium", creativity: "high" } },
  { id: "premium", label: "Премиальный бренд", description: "Спокойная уверенность, точные слова, минимум шума.", patch: { goal: "warmup", formality: "formal", energy: "calm", humor: "none", hook: "insight", structure: "free", cta: "auto", ctaStrength: "soft", emojiMode: "none", hashtags: "none", length: "medium", creativity: "balanced" } },
  { id: "bold", label: "Дерзкий", description: "Сильная позиция без хамства, кликбейта и фальшивых обещаний.", patch: { goal: "reach", formality: "casual", energy: "high", humor: "bold", hook: "contrast", structure: "free", cta: "comment", ctaStrength: "direct", length: "short", creativity: "high" } },
  { id: "minimal", label: "Минималистичный", description: "Одна мысль, короткая форма, никаких украшательств.", patch: { goal: "education", energy: "calm", humor: "none", hook: "insight", structure: "free", cta: "none", emojiMode: "none", hashtags: "none", length: "short", creativity: "low" } },
] as const;

export const DEFAULT_POST_SETTINGS: Readonly<PostSettings> = Object.freeze({
  version: 1,
  target: "auto",
  preset: "auto",
  goal: "auto",
  mainIdea: "",
  readerUnderstanding: "",
  desiredFeeling: "auto",
  readerAction: "",
  primaryMetric: "auto",
  messageCount: "one",
  includeConclusion: true,
  promotionType: "auto",
  promotionName: "",
  offer: "",
  mainBenefit: "",
  differentiation: "",
  price: "",
  offerDestination: "",
  salesIntensity: "native",
  productReveal: "after_problem",
  audience: "",
  awareness: "auto",
  readerSituation: "",
  audienceProblem: "",
  desiredResult: "",
  emotionalDesire: "",
  primaryFear: "",
  barrier: "",
  objection: "",
  failedAttempts: "",
  currentAlternative: "",
  purchaseTrigger: "",
  choiceCriterion: "",
  trustLevel: "auto",
  audienceLanguage: "",
  excludedAudience: "",
  language: "auto",
  length: "auto",
  customMinChars: null,
  customMaxChars: null,
  formality: "auto",
  energy: "auto",
  humor: "auto",
  profanityMode: "auto",
  address: "auto",
  emojiMode: "auto",
  emojiMax: null,
  emojiPlacement: "auto",
  allowedEmojis: [],
  forbiddenEmojis: [],
  hook: "auto",
  structure: "auto",
  paragraphs: "auto",
  lists: "auto",
  cta: "auto",
  ctaWording: "",
  ctaDestination: "",
  ctaOutcome: "",
  ctaCodeword: "",
  secondaryCta: "none",
  ctaRepeats: 1,
  ctaAddReason: false,
  ctaNextStep: true,
  ctaStrength: "soft",
  ctaPlacement: "natural",
  hashtags: "auto",
  hashtagCount: null,
  keywords: [],
  mentions: [],
  links: [],
  requiredFacts: [],
  forbiddenWords: [],
  forbiddenTopics: [],
  creativity: "balanced",
  proofs: [],
  // The explicit opt-out still creates a review-required receipt; strict checks can be
  // enabled per publication when verified sources are available.
  factStrictness: "off",
  missingFactsMode: "omit",
  salesAngle: "auto",
  persuasionFormula: "auto",
  objectionToHandle: "",
  proofCount: "auto",
  priceMode: "auto",
  salesPressure: "soft",
  scarcity: "none",
  urgency: "none",
  urgencyReason: "",
  riskReducer: "none",
  trafficType: "auto",
  audienceTemperature: "auto",
  funnelStage: "auto",
  touchType: "auto",
  campaign: "",
  seriesStage: "none",
  previousPost: "",
  nextPost: "",
  audienceKnows: "",
  confidential: "",
  eventDate: "",
  relevance: "evergreen",
  originalityDepth: "10",
  avoidRepetitions: ["hooks", "cta", "structure", "phrases"] as RepetitionPart[],
  similarityLevel: "moderate",
  blockAiCliches: true,
  blockGenericPhrases: true,
  requireConcreteExample: false,
  requireNewAngle: true,
  showSimilarPosts: false,
  goodVoiceExamples: [],
  badVoiceExamples: [],
  signatureExpressions: [],
  bannedExpressions: [],
  sentenceLength: "auto",
  slangLevel: "low",
  metaphorLevel: "low",
  anglicisms: "low",
  rhetoricalQuestions: "low",
  punctuationNotes: "",
  capitalsAllowed: false,
  provocationLevel: "low",
  neverStart: [],
  neverEnd: [],
  styleMatch: "recognizable",
  outputParts: ["main"] as OutputPart[],
  variantChange: "full",
  qualityMode: "fast",
  autoImprove: false,
  qualityThreshold: 8,
  hideCriticalResult: true,
});

const clean = (value: unknown, max: number) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const uniqueList = (value: unknown, limit: number, max: number) =>
  Array.isArray(value) ? [...new Set(value.map((item) => clean(item, max)).filter(Boolean))].slice(0, limit) : [];
const oneOf = <T extends string>(value: unknown, values: readonly T[], fallback: T): T =>
  values.includes(value as T) ? (value as T) : fallback;
const int = (value: unknown, min: number, max: number, fallback: number) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
};
const bool = (value: unknown, fallback: boolean) => typeof value === "boolean" ? value : fallback;

function normalizeProofs(value: unknown): PostProof[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item, index): PostProof[] => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const source = item as Record<string, unknown>;
    const text = clean(source.text, 1200);
    const id = clean(source.id, 80);
    if (!text && !id) return [];
    return [{
      id: id || `proof-${index + 1}`,
      type: oneOf(source.type, ["number", "statistic", "case", "review", "quote", "experience", "research", "certificate", "demo", "comparison", "product_fact"] as const, "product_fact"),
      text,
      source: clean(source.source, 500),
      validAt: clean(source.validAt, 40),
      required: bool(source.required, false),
      allowClientName: bool(source.allowClientName, false),
      allowParaphrase: bool(source.allowParaphrase, true),
    }];
  }).slice(0, 20);
}

const OUTPUT_PARTS: readonly OutputPart[] = ["main", "hooks", "titles", "cover", "first_comment", "pinned_comment", "hashtags", "alt", "visual_brief", "image_idea", "short_version", "stories", "cross_platform", "comment_replies", "utm", "discussion_question"];

function normalizeOutputParts(value: unknown): OutputPart[] {
  const parts = uniqueList(value, OUTPUT_PARTS.length, 40)
    .filter((item): item is OutputPart => OUTPUT_PARTS.includes(item as OutputPart));
  return ["main", ...parts.filter((item) => item !== "main")];
}

function normalizeRepetitionParts(value: unknown): RepetitionPart[] {
  if (value === undefined || value === null) return [...DEFAULT_POST_SETTINGS.avoidRepetitions];
  return uniqueList(value, 6, 30)
    .filter((item): item is RepetitionPart => ["hooks", "cta", "stories", "examples", "structure", "phrases"].includes(item));
}

const TARGETS = ["auto", ...Object.keys(POST_TARGET_RULES)] as PostTarget[];
const PRESETS = ["auto", ...POST_PRESETS.map((item) => item.id), "custom"] as PostPresetId[];

export function normalizePostSettings(raw: unknown): PostSettings {
  const source = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const target = oneOf(source.target, TARGETS, DEFAULT_POST_SETTINGS.target);
  const length = oneOf(source.length, ["auto", "short", "medium", "long", "custom"] as const, DEFAULT_POST_SETTINGS.length);
  const emojiMode = oneOf(source.emojiMode, ["auto", "none", "few", "moderate", "many", "custom"] as const, DEFAULT_POST_SETTINGS.emojiMode);
  const hashtags = oneOf(source.hashtags, ["auto", "none", "custom"] as const, DEFAULT_POST_SETTINGS.hashtags);
  const targetHardMax = target === "auto" ? 15_000 : POST_TARGET_RULES[target].hardLimit;
  let customMinChars = length === "custom" ? int(source.customMinChars, 1, targetHardMax, 300) : null;
  let customMaxChars = length === "custom" ? int(source.customMaxChars, 1, targetHardMax, Math.min(1200, targetHardMax)) : null;
  if (customMinChars !== null && customMaxChars !== null && customMinChars > customMaxChars) {
    [customMinChars, customMaxChars] = [customMaxChars, customMinChars];
  }
  const emojiMax = emojiMode === "none" ? 0 : emojiMode === "custom" ? int(source.emojiMax, 0, 20, 3) : null;
  const hashtagCount = hashtags === "none" ? 0 : hashtags === "custom" ? int(source.hashtagCount, 0, 30, 3) : null;

  return {
    version: 1,
    target,
    preset: oneOf(source.preset, PRESETS, DEFAULT_POST_SETTINGS.preset),
    goal: oneOf(source.goal, ["auto", "reach", "engagement", "sale", "traffic", "education", "announcement", "warmup"] as const, DEFAULT_POST_SETTINGS.goal),
    mainIdea: clean(source.mainIdea, 500),
    readerUnderstanding: clean(source.readerUnderstanding, 500),
    desiredFeeling: oneOf(source.desiredFeeling, ["auto", "interest", "trust", "desire", "urgency", "relief", "inspiration"] as const, DEFAULT_POST_SETTINGS.desiredFeeling),
    readerAction: clean(source.readerAction, 300),
    primaryMetric: oneOf(source.primaryMetric, ["auto", "readthrough", "saves", "comments", "clicks", "leads", "sales"] as const, DEFAULT_POST_SETTINGS.primaryMetric),
    messageCount: oneOf(source.messageCount, ["one", "one_plus", "several"] as const, DEFAULT_POST_SETTINGS.messageCount),
    includeConclusion: bool(source.includeConclusion, DEFAULT_POST_SETTINGS.includeConclusion),
    promotionType: oneOf(source.promotionType, ["auto", "product", "service", "event", "personal_brand", "lead_magnet"] as const, DEFAULT_POST_SETTINGS.promotionType),
    promotionName: clean(source.promotionName, 300),
    offer: clean(source.offer, 700),
    mainBenefit: clean(source.mainBenefit, 500),
    differentiation: clean(source.differentiation, 500),
    price: clean(source.price, 120),
    offerDestination: clean(source.offerDestination, 500),
    salesIntensity: oneOf(source.salesIntensity, ["native", "soft", "confident", "direct"] as const, DEFAULT_POST_SETTINGS.salesIntensity),
    productReveal: oneOf(source.productReveal, ["immediately", "after_problem", "near_end", "cta_only"] as const, DEFAULT_POST_SETTINGS.productReveal),
    audience: clean(source.audience, 300),
    awareness: oneOf(source.awareness, ["auto", "unaware", "problem_aware", "solution_aware", "product_aware", "ready"] as const, DEFAULT_POST_SETTINGS.awareness),
    readerSituation: clean(source.readerSituation, 600),
    audienceProblem: clean(source.audienceProblem, 500),
    desiredResult: clean(source.desiredResult, 500),
    emotionalDesire: clean(source.emotionalDesire, 300),
    primaryFear: clean(source.primaryFear, 400),
    barrier: clean(source.barrier, 500),
    objection: clean(source.objection, 500),
    failedAttempts: clean(source.failedAttempts, 600),
    currentAlternative: clean(source.currentAlternative, 400),
    purchaseTrigger: clean(source.purchaseTrigger, 500),
    choiceCriterion: clean(source.choiceCriterion, 300),
    trustLevel: oneOf(source.trustLevel, ["auto", "cold", "familiar", "warm", "customer"] as const, DEFAULT_POST_SETTINGS.trustLevel),
    audienceLanguage: clean(source.audienceLanguage, 900),
    excludedAudience: clean(source.excludedAudience, 500),
    language: oneOf(source.language, ["auto", "ru", "en"] as const, DEFAULT_POST_SETTINGS.language),
    length,
    customMinChars,
    customMaxChars,
    formality: oneOf(source.formality, ["auto", "casual", "neutral", "formal"] as const, DEFAULT_POST_SETTINGS.formality),
    energy: oneOf(source.energy, ["auto", "calm", "balanced", "high"] as const, DEFAULT_POST_SETTINGS.energy),
    humor: oneOf(source.humor, ["auto", "none", "light", "bold"] as const, DEFAULT_POST_SETTINGS.humor),
    profanityMode: oneOf(source.profanityMode, ["auto", "forbid", "allow", "masked", "required_direct"] as const, DEFAULT_POST_SETTINGS.profanityMode),
    address: oneOf(source.address, ["auto", "ты", "вы", "neutral"] as const, DEFAULT_POST_SETTINGS.address),
    emojiMode,
    emojiMax,
    emojiPlacement: oneOf(source.emojiPlacement, ["auto", "inline", "line_end", "bullets"] as const, DEFAULT_POST_SETTINGS.emojiPlacement),
    allowedEmojis: emojiMode === "none" ? [] : uniqueList(source.allowedEmojis, 20, 16),
    forbiddenEmojis: uniqueList(source.forbiddenEmojis, 20, 16),
    hook: oneOf(source.hook, ["auto", "insight", "benefit", "problem", "story", "fact", "question", "contrast", "none"] as const, DEFAULT_POST_SETTINGS.hook),
    structure: oneOf(source.structure, ["auto", "free", "explainer", "problem_solution", "story", "list", "news", "announcement"] as const, DEFAULT_POST_SETTINGS.structure),
    paragraphs: oneOf(source.paragraphs, ["auto", "short", "medium"] as const, DEFAULT_POST_SETTINGS.paragraphs),
    lists: oneOf(source.lists, ["auto", "avoid", "prefer", "required"] as const, DEFAULT_POST_SETTINGS.lists),
    cta: oneOf(source.cta, ["auto", "none", "comment", "save", "share", "subscribe", "click", "buy", "reply", "register", "download"] as const, DEFAULT_POST_SETTINGS.cta),
    ctaWording: clean(source.ctaWording, 300),
    ctaDestination: clean(source.ctaDestination, 500),
    ctaOutcome: clean(source.ctaOutcome, 400),
    ctaCodeword: clean(source.ctaCodeword, 80),
    secondaryCta: oneOf(source.secondaryCta, ["auto", "none", "comment", "save", "share", "subscribe", "click", "buy", "reply", "register", "download"] as const, DEFAULT_POST_SETTINGS.secondaryCta),
    ctaRepeats: int(source.ctaRepeats, 1, 2, DEFAULT_POST_SETTINGS.ctaRepeats) as 1 | 2,
    ctaAddReason: bool(source.ctaAddReason, DEFAULT_POST_SETTINGS.ctaAddReason),
    ctaNextStep: bool(source.ctaNextStep, DEFAULT_POST_SETTINGS.ctaNextStep),
    ctaStrength: oneOf(source.ctaStrength, ["soft", "neutral", "direct"] as const, DEFAULT_POST_SETTINGS.ctaStrength),
    ctaPlacement: oneOf(source.ctaPlacement, ["natural", "end"] as const, DEFAULT_POST_SETTINGS.ctaPlacement),
    hashtags,
    hashtagCount,
    keywords: uniqueList(source.keywords, 20, 80),
    mentions: uniqueList(source.mentions, 20, 80),
    links: uniqueList(source.links, 10, 500),
    requiredFacts: uniqueList(source.requiredFacts, 20, 500),
    forbiddenWords: uniqueList(source.forbiddenWords, 40, 100),
    forbiddenTopics: uniqueList(source.forbiddenTopics, 30, 160),
    creativity: oneOf(source.creativity, ["low", "balanced", "high"] as const, DEFAULT_POST_SETTINGS.creativity),
    proofs: normalizeProofs(source.proofs),
    factStrictness: oneOf(source.factStrictness, ["off", "verified", "verified_inference", "general", "creative_no_new_facts"] as const, DEFAULT_POST_SETTINGS.factStrictness),
    missingFactsMode: oneOf(source.missingFactsMode, ["ask", "omit", "neutral", "placeholder"] as const, DEFAULT_POST_SETTINGS.missingFactsMode),
    salesAngle: oneOf(source.salesAngle, ["auto", "problem", "desired_result", "mistake", "lost_opportunity", "saving", "speed", "simplicity", "safety", "status", "novelty", "comparison", "case", "objection", "demo", "personal_story"] as const, DEFAULT_POST_SETTINGS.salesAngle),
    persuasionFormula: oneOf(source.persuasionFormula, ["auto", "aida", "pas", "problem_consequence_solution", "before_after_bridge", "story_insight_offer", "objection_proof_offer", "mistake_approach_product", "result_mechanism_cta", "alternatives", "demo_benefit_action"] as const, DEFAULT_POST_SETTINGS.persuasionFormula),
    objectionToHandle: clean(source.objectionToHandle, 500),
    proofCount: oneOf(source.proofCount, ["auto", "0", "1", "2", "3_plus"] as const, DEFAULT_POST_SETTINGS.proofCount),
    priceMode: oneOf(source.priceMode, ["auto", "required", "never"] as const, DEFAULT_POST_SETTINGS.priceMode),
    salesPressure: oneOf(source.salesPressure, ["soft", "neutral", "direct"] as const, DEFAULT_POST_SETTINGS.salesPressure),
    scarcity: oneOf(source.scarcity, ["none", "real_quantity"] as const, DEFAULT_POST_SETTINGS.scarcity),
    urgency: oneOf(source.urgency, ["none", "deadline", "event", "price_increase", "enrollment_end"] as const, DEFAULT_POST_SETTINGS.urgency),
    urgencyReason: clean(source.urgencyReason, 400),
    riskReducer: oneOf(source.riskReducer, ["none", "guarantee", "trial", "consultation", "refund", "demo"] as const, DEFAULT_POST_SETTINGS.riskReducer),
    trafficType: oneOf(source.trafficType, ["auto", "organic", "paid"] as const, DEFAULT_POST_SETTINGS.trafficType),
    audienceTemperature: oneOf(source.audienceTemperature, ["auto", "cold", "warm", "hot"] as const, DEFAULT_POST_SETTINGS.audienceTemperature),
    funnelStage: oneOf(source.funnelStage, ["auto", "awareness", "problem", "solution", "trust", "objection", "offer", "close"] as const, DEFAULT_POST_SETTINGS.funnelStage),
    touchType: oneOf(source.touchType, ["auto", "first", "repeat", "final"] as const, DEFAULT_POST_SETTINGS.touchType),
    campaign: clean(source.campaign, 200),
    seriesStage: oneOf(source.seriesStage, ["none", "start", "middle", "finish"] as const, DEFAULT_POST_SETTINGS.seriesStage),
    previousPost: clean(source.previousPost, 2000),
    nextPost: clean(source.nextPost, 800),
    audienceKnows: clean(source.audienceKnows, 800),
    confidential: clean(source.confidential, 800),
    eventDate: clean(source.eventDate, 80),
    relevance: oneOf(source.relevance, ["evergreen", "temporary", "news"] as const, DEFAULT_POST_SETTINGS.relevance),
    originalityDepth: oneOf(source.originalityDepth, ["10", "30", "100", "all"] as const, DEFAULT_POST_SETTINGS.originalityDepth),
    avoidRepetitions: normalizeRepetitionParts(source.avoidRepetitions),
    similarityLevel: oneOf(source.similarityLevel, ["strict", "moderate", "allow"] as const, DEFAULT_POST_SETTINGS.similarityLevel),
    blockAiCliches: bool(source.blockAiCliches, DEFAULT_POST_SETTINGS.blockAiCliches),
    blockGenericPhrases: bool(source.blockGenericPhrases, DEFAULT_POST_SETTINGS.blockGenericPhrases),
    requireConcreteExample: bool(source.requireConcreteExample, DEFAULT_POST_SETTINGS.requireConcreteExample),
    requireNewAngle: bool(source.requireNewAngle, DEFAULT_POST_SETTINGS.requireNewAngle),
    showSimilarPosts: bool(source.showSimilarPosts, DEFAULT_POST_SETTINGS.showSimilarPosts),
    goodVoiceExamples: uniqueList(source.goodVoiceExamples, 10, 1200),
    badVoiceExamples: uniqueList(source.badVoiceExamples, 10, 1200),
    signatureExpressions: uniqueList(source.signatureExpressions, 30, 120),
    bannedExpressions: uniqueList(source.bannedExpressions, 40, 120),
    sentenceLength: oneOf(source.sentenceLength, ["auto", "short", "mixed", "long"] as const, DEFAULT_POST_SETTINGS.sentenceLength),
    slangLevel: oneOf(source.slangLevel, ["none", "low", "medium", "high"] as const, DEFAULT_POST_SETTINGS.slangLevel),
    metaphorLevel: oneOf(source.metaphorLevel, ["none", "low", "medium", "high"] as const, DEFAULT_POST_SETTINGS.metaphorLevel),
    anglicisms: oneOf(source.anglicisms, ["none", "low", "medium", "high"] as const, DEFAULT_POST_SETTINGS.anglicisms),
    rhetoricalQuestions: oneOf(source.rhetoricalQuestions, ["none", "low", "medium", "high"] as const, DEFAULT_POST_SETTINGS.rhetoricalQuestions),
    punctuationNotes: clean(source.punctuationNotes, 500),
    capitalsAllowed: bool(source.capitalsAllowed, DEFAULT_POST_SETTINGS.capitalsAllowed),
    provocationLevel: oneOf(source.provocationLevel, ["none", "low", "medium", "high"] as const, DEFAULT_POST_SETTINGS.provocationLevel),
    neverStart: uniqueList(source.neverStart, 20, 200),
    neverEnd: uniqueList(source.neverEnd, 20, 200),
    styleMatch: oneOf(source.styleMatch, ["light", "recognizable", "maximum"] as const, DEFAULT_POST_SETTINGS.styleMatch),
    outputParts: normalizeOutputParts(source.outputParts),
    variantChange: oneOf(source.variantChange, ["full", "hook", "sales_angle", "structure", "emotional", "expert", "native"] as const, DEFAULT_POST_SETTINGS.variantChange),
    qualityMode: oneOf(source.qualityMode, ["fast", "balanced", "maximum"] as const, DEFAULT_POST_SETTINGS.qualityMode),
    autoImprove: bool(source.autoImprove, DEFAULT_POST_SETTINGS.autoImprove),
    qualityThreshold: int(source.qualityThreshold, 7, 9, DEFAULT_POST_SETTINGS.qualityThreshold) as QualityThreshold,
    hideCriticalResult: bool(source.hideCriticalResult, DEFAULT_POST_SETTINGS.hideCriticalResult),
  };
}

/** Сохраняем только отличия от Auto: в jsonb нет пустых декоративных значений. */
export function compactPostSettings(raw: unknown): Record<string, unknown> {
  const value = normalizePostSettings(raw);
  const compact: Record<string, unknown> = { version: 1 };
  for (const key of Object.keys(value) as (keyof PostSettings)[]) {
    if (key === "version") continue;
    const current = value[key];
    const fallback = DEFAULT_POST_SETTINGS[key];
    if (Array.isArray(current)) {
      const compactArray = key === "proofs"
        ? (current as PostProof[]).filter((proof) => proof.text.trim())
        : current;
      if (JSON.stringify(compactArray) !== JSON.stringify(fallback)) compact[key] = compactArray;
    } else if (current !== fallback && current !== null && current !== "") {
      compact[key] = current;
    }
  }
  return compact;
}

export function applyPostPreset(raw: unknown, presetId: PostPreset["id"]): PostSettings {
  const current = normalizePostSettings(raw);
  const preset = POST_PRESETS.find((item) => item.id === presetId);
  if (!preset) return current;
  return normalizePostSettings({ ...current, ...preset.patch, preset: preset.id });
}

export function patchPostSettings(raw: unknown, patch: Partial<PostSettings>): PostSettings {
  const current = normalizePostSettings(raw);
  return normalizePostSettings({ ...current, ...patch, preset: patch.preset ?? "custom" });
}

export function targetForNetwork(network?: string | null, kind?: AiKind): Exclude<PostTarget, "auto"> {
  if (network === "instagram") return kind === "script" ? "instagram_reel" : "instagram_post";
  if (network === "youtube") return "youtube_community";
  if (network === "vk") return "vk_community";
  return "telegram_channel";
}

export function resolvePostTarget(raw: unknown, network?: string | null, kind?: AiKind): Exclude<PostTarget, "auto"> {
  const settings = normalizePostSettings(raw);
  return settings.target === "auto" ? targetForNetwork(network, kind) : settings.target;
}

export function postLengthRange(raw: unknown, network?: string | null, kind?: AiKind): readonly [number, number] {
  const settings = normalizePostSettings(raw);
  const rule = POST_TARGET_RULES[resolvePostTarget(settings, network, kind)];
  if (settings.length === "custom" && settings.customMinChars !== null && settings.customMaxChars !== null) {
    return [settings.customMinChars, Math.min(settings.customMaxChars, rule.hardLimit)];
  }
  if (settings.length === "short") return rule.shortRange;
  if (settings.length === "medium") return rule.mediumRange;
  if (settings.length === "long") return rule.longRange;
  // Команды чата «Короче» и «Лонгрид» — прямое намерение пользователя. В Auto
  // они важнее редакционного диапазона площадки, иначе валидатор спорил бы с самим
  // запросом и мог бы списать генерацию без полезного результата.
  if (kind === "shorten") return rule.shortRange;
  if (kind === "longread") return rule.longRange;
  return rule.defaultRange;
}

function explicitTaskLength(
  task: string | undefined,
  fallback: readonly [number, number],
  hardLimit: number,
): readonly [number, number] {
  const value = String(task ?? "").toLocaleLowerCase("ru").replace(/\s+/g, " ");
  if (!value) return fallback;
  const number = (raw: string) => Math.min(hardLimit, Math.max(1, Number(raw.replace(/\s/g, ""))));
  const range = value.match(/(?:от\s*)?(\d[\d\s]{0,5})\s*(?:[–—-]|до)\s*(\d[\d\s]{0,5})\s*(?:знак|символ)/u);
  if (range) {
    const first = number(range[1]);
    const second = number(range[2]);
    return first <= second ? [first, second] : [second, first];
  }
  const upper = value.match(/(?:до|не\s+больше|максимум)\s*(\d[\d\s]{0,5})\s*(?:знак|символ)/u);
  if (upper) return [1, number(upper[1])];
  const lower = value.match(/(?:от|не\s+меньше|минимум)\s*(\d[\d\s]{0,5})\s*(?:знак|символ)/u);
  if (lower) return [number(lower[1]), hardLimit];
  const exact = value.match(/(?:на|ровно|примерно|около)\s*(\d[\d\s]{0,5})\s*(?:знак|символ)/u);
  if (exact) {
    const target = number(exact[1]);
    return [Math.max(1, Math.floor(target * 0.85)), Math.min(hardLimit, Math.ceil(target * 1.15))];
  }
  return fallback;
}

function emojiRange(settings: PostSettings, rule: PlatformRule): readonly [number, number] {
  if (settings.emojiMode === "none") return [0, 0];
  if (settings.emojiMode === "few") return [1, 1];
  if (settings.emojiMode === "moderate") return [2, 3];
  if (settings.emojiMode === "many") return [4, 8];
  if (settings.emojiMode === "custom") {
    const exact = Math.min(settings.emojiMax ?? 0, 20);
    return [exact, exact];
  }
  return [0, rule.defaultEmojiMax];
}

function hashtagRange(settings: PostSettings, rule: PlatformRule): readonly [number, number] {
  if (settings.hashtags === "none") return [0, 0];
  if (settings.hashtags === "custom") {
    const exact = Math.min(settings.hashtagCount ?? 0, rule.platformHashtagMax);
    return [exact, exact];
  }
  return [0, Math.min(rule.defaultHashtagMax, rule.platformHashtagMax)];
}

function effectiveLengthRange(
  settings: PostSettings,
  rule: PlatformRule,
  context: { network?: string | null; kind?: AiKind; task?: string },
): readonly [number, number] {
  const selected = postLengthRange(settings, context.network, context.kind);
  return settings.length === "auto"
    ? explicitTaskLength(context.task, selected, rule.hardLimit)
    : selected;
}

/**
 * В режиме Auto прямое пожелание из текущего запроса важнее постоянного голоса
 * канала. Явно выбранный режим публикации при этом не переопределяем текстом.
 */
export function resolvePostProfanityMode(raw: unknown, task?: string): ProfanityMode {
  const settings = normalizePostSettings(raw);
  if (settings.profanityMode !== "auto") return settings.profanityMode;

  const value = String(task ?? "").toLocaleLowerCase("ru").replace(/\s+/g, " ").trim();
  if (!value) return "auto";
  if (
    /(?:без|никакого)\s+мата/u.test(value)
    || /не\s+(?:используй|добавляй|пиши)(?:\s+\p{L}+){0,3}\s+мат/u.test(value)
    || /мат\s+(?:запрещ[её]н|нельзя)/u.test(value)
  ) return "forbid";
  if (
    /(?:мат|ругательств\p{L}*)\s+со\s+зв[её]здочк/u.test(value)
    || /(?:цензурированн\p{L}*\s+мат|запика(?:й|нн)\p{L}*)/u.test(value)
  ) return "masked";
  if (
    /мат(?:ом|а)?\s+(?:допустим\p{L}*|разреш[её]н\p{L}*|не\s+обязател\p{L}*)/u.test(value)
    || /(?:можно|можешь)\s+(?:писать|сделать|использовать|добавить)?\s*(?:с\s+)?мат(?:ом|а)?(?!\p{L})/u.test(value)
  ) return "allow";
  if (
    /(?:без\s+цензур\p{L}*|не\s+(?:цензурируй|маскируй)(?:\s+\p{L}+){0,3}\s+мат)/u.test(value)
    || /(?:с|добавь|используй)\s+мат(?:ом|а)?(?!\p{L})/u.test(value)
    || /(?:много|побольше|больше)\s+мата/u.test(value)
    || /мат(?:ом|а)?\s+без\s+(?:цензур\p{L}*|ограничен\p{L}*|лимит\p{L}*)/u.test(value)
    || /(?:прям\p{L}*\s+мат|матерн\p{L}*\s+(?:пост|лексик\p{L}*|слов\p{L}*))/u.test(value)
  ) return "required_direct";
  return "auto";
}

const LABELS = {
  goal: { auto: "определи по задаче", reach: "охват", engagement: "вовлечение", sale: "продажа", traffic: "переходы", education: "обучение", announcement: "анонс", warmup: "прогрев" },
  awareness: { auto: "определи по контексту", unaware: "не знает о проблеме", problem_aware: "понимает проблему", solution_aware: "ищет решение", product_aware: "знает продукт", ready: "готова действовать" },
  formality: { auto: "возьми из голоса бренда", casual: "разговорно", neutral: "нейтрально", formal: "формально" },
  energy: { auto: "по теме", calm: "спокойная", balanced: "сбалансированная", high: "высокая" },
  humor: { auto: "только если уместно", none: "без юмора", light: "лёгкий", bold: "смелый, без унижения" },
  address: { auto: "как в голосе бренда", ты: "на «ты»", вы: "на «вы»", neutral: "без прямого обращения" },
  hook: { auto: "выбери содержательный", insight: "наблюдение или инсайт", benefit: "конкретная польза", problem: "узнаваемая проблема", story: "сцена из истории", fact: "подтверждённый факт", question: "содержательный вопрос", contrast: "честный контраст", none: "без отдельного хука" },
  structure: { auto: "выбери по материалу", free: "свободная", explainer: "тезис → объяснение → вывод", problem_solution: "проблема → решение → действие", story: "сцена → развитие → вывод", list: "короткое введение → список → вывод", news: "событие → значение → последствия", announcement: "что → для кого → когда → действие" },
  paragraphs: { auto: "нативно площадке", short: "1–2 предложения", medium: "2–4 предложения" },
  lists: { auto: "только когда полезно", avoid: "не использовать", prefer: "предпочитать для шагов", required: "обязателен один список" },
  cta: { auto: "только если нужен цели", none: "без призыва", comment: "оставить комментарий", save: "сохранить", share: "поделиться", subscribe: "подписаться", click: "перейти по ссылке", buy: "купить или оставить заявку", reply: "написать автору", register: "зарегистрироваться", download: "скачать материал" },
  strength: { soft: "мягкая", neutral: "ясная", direct: "прямая без давления" },
  placement: { natural: "в естественном месте", end: "в конце" },
  creativity: { low: "низкая: точность важнее необычности", balanced: "сбалансированная", high: "высокая: небанальный угол без выдумки" },
} as const;

const BRIEF_LABELS = {
  feeling: { auto: "определи по задаче", interest: "интерес", trust: "доверие", desire: "желание", urgency: "обоснованную срочность", relief: "облегчение", inspiration: "вдохновение" },
  metric: { auto: "определи по цели", readthrough: "дочитывания", saves: "сохранения", comments: "комментарии", clicks: "переходы", leads: "заявки", sales: "продажи" },
  messages: { one: "один основной смысл", one_plus: "один основной и один дополнительный", several: "несколько смыслов" },
  trust: { auto: "определи по контексту", cold: "холодная", familiar: "знакомая", warm: "тёплая", customer: "действующий клиент" },
  promotion: { auto: "определи по предложению", product: "продукт", service: "услуга", event: "мероприятие", personal_brand: "личный бренд", lead_magnet: "бесплатный материал" },
  salesIntensity: { native: "нативная", soft: "мягкая", confident: "уверенная", direct: "прямая" },
  productReveal: { immediately: "сразу", after_problem: "после проблемы", near_end: "ближе к концу", cta_only: "только в призыве" },
  strictness: { off: "автоматическая проверка отключена; факты проверяются вручную", verified: "только подтверждённые факты", verified_inference: "факты и осторожные выводы", general: "допустимы общие рассуждения", creative_no_new_facts: "свободные формулировки без новых фактов" },
  missing: { ask: "задать уточняющий вопрос", omit: "не использовать утверждение", neutral: "сформулировать нейтрально", placeholder: "пометить место для ручного заполнения" },
  quality: { fast: "быстро: один проход и минимальная проверка", balanced: "сбалансированно: черновик, проверка и редактура", maximum: "максимальное качество: три концепции, выбор лучшей и финальная редактура" },
} as const;

const OUTPUT_LABELS: Record<OutputPart, string> = {
  main: "основной текст",
  hooks: "5 вариантов начала",
  titles: "3 варианта заголовка",
  cover: "текст на обложку",
  first_comment: "первый комментарий",
  pinned_comment: "закреплённый комментарий",
  hashtags: "хэштеги",
  alt: "описание изображения",
  visual_brief: "задание для изображения",
  image_idea: "идея изображения",
  short_version: "короткая версия",
  stories: "версия для историй",
  cross_platform: "версия для другой площадки",
  comment_replies: "ответы на вероятные комментарии",
  utm: "ссылка с меткой",
  discussion_question: "вопрос для обсуждения",
};

export function buildPostSettingsPrompt(raw: unknown, context: { network?: string | null; kind?: AiKind; task?: string } = {}): string {
  const settings = normalizePostSettings(raw);
  const profanityMode = resolvePostProfanityMode(settings, context.task);
  const target = resolvePostTarget(settings, context.network, context.kind);
  const rule = POST_TARGET_RULES[target];
  const [minChars, maxChars] = effectiveLengthRange(settings, rule, context);
  const [minEmojis, maxEmojis] = emojiRange(settings, rule);
  const [minHashtags, maxHashtags] = hashtagRange(settings, rule);
  const lines = [
    "КОНТРАКТ КОНКРЕТНОЙ ПУБЛИКАЦИИ. Применяй разделы строго в указанном порядке: нижний раздел не может отменить верхний.",
  ];
  const section = (title: string, values: Array<string | false | null | undefined>) => {
    const present = values.filter((item): item is string => typeof item === "string" && Boolean(item.trim()));
    if (present.length) lines.push("", title, ...present.map((item) => `— ${item}`));
  };

  section("1. ЖЁСТКИЕ ОГРАНИЧЕНИЯ И ДОСТОВЕРНОСТЬ", [
    `объём основного текста: ${minChars}–${maxChars} знаков с пробелами${rule.hardLimitUnit === "bytes" ? `; технический предел — ${rule.hardLimit} байт UTF-8` : ""}`,
    `режим фактов: ${BRIEF_LABELS.strictness[settings.factStrictness]}`,
    `если данных не хватает: ${BRIEF_LABELS.missing[settings.missingFactsMode]}`,
    settings.requiredFacts.length ? `обязательные факты без искажения: ${settings.requiredFacts.join(" | ")}` : null,
    settings.forbiddenWords.length || settings.bannedExpressions.length ? `запрещённые слова и выражения: ${[...settings.forbiddenWords, ...settings.bannedExpressions].join("; ")}` : null,
    settings.forbiddenTopics.length ? `запрещённые темы: ${settings.forbiddenTopics.join("; ")}` : null,
    settings.confidential ? `не раскрывать: ${settings.confidential}` : null,
    "никогда не придумывай отзывы, цифры, исследования, клиентов, награды, сроки, гарантии, скидки или характеристики продукта",
  ]);

  section("2. ЗАДАЧА ПУБЛИКАЦИИ", [
    `цель: ${LABELS.goal[settings.goal]}`,
    settings.mainIdea ? `главная мысль: ${settings.mainIdea}` : null,
    settings.readerUnderstanding ? `читатель должен понять: ${settings.readerUnderstanding}` : null,
    `читатель должен почувствовать: ${BRIEF_LABELS.feeling[settings.desiredFeeling]}`,
    settings.readerAction ? `одно основное действие читателя: ${settings.readerAction}` : null,
    `главная метрика: ${BRIEF_LABELS.metric[settings.primaryMetric]}`,
    `количество смыслов: ${BRIEF_LABELS.messages[settings.messageCount]}`,
    settings.includeConclusion ? "нужен содержательный вывод" : "не добавляй отдельный вывод",
  ]);

  section("3. ПРОДУКТ И ОФФЕР", [
    `тип продвижения: ${BRIEF_LABELS.promotion[settings.promotionType]}`,
    settings.promotionName ? `что продвигаем: ${settings.promotionName}` : null,
    settings.offer ? `конкретное предложение: ${settings.offer}` : null,
    settings.mainBenefit ? `главная выгода: ${settings.mainBenefit}` : null,
    settings.differentiation ? `главное отличие: ${settings.differentiation}` : null,
    settings.priceMode === "never" ? "цену не указывать" : settings.price ? `цена: ${settings.price}` : null,
    settings.offerDestination ? `место обращения: ${settings.offerDestination}` : null,
    `интенсивность продажи: ${BRIEF_LABELS.salesIntensity[settings.salesIntensity]}`,
    `показать продукт: ${BRIEF_LABELS.productReveal[settings.productReveal]}`,
  ]);

  section("4. МОТИВАЦИЯ АУДИТОРИИ", [
    settings.audience ? `сегмент: ${settings.audience}` : "сегмент возьми из паспорта выбранного канала",
    `осведомлённость: ${LABELS.awareness[settings.awareness]}; доверие: ${BRIEF_LABELS.trust[settings.trustLevel]}`,
    settings.readerSituation ? `ситуация: ${settings.readerSituation}` : null,
    settings.audienceProblem ? `проблема: ${settings.audienceProblem}` : null,
    settings.desiredResult ? `желаемый результат: ${settings.desiredResult}` : null,
    settings.emotionalDesire ? `эмоциональное желание: ${settings.emotionalDesire}` : null,
    settings.primaryFear ? `главный страх: ${settings.primaryFear}` : null,
    settings.barrier ? `барьер: ${settings.barrier}` : null,
    settings.objection ? `основное возражение: ${settings.objection}` : null,
    settings.failedAttempts ? `неудачные попытки: ${settings.failedAttempts}` : null,
    settings.currentAlternative ? `текущая альтернатива: ${settings.currentAlternative}` : null,
    settings.purchaseTrigger ? `триггер покупки: ${settings.purchaseTrigger}` : null,
    settings.choiceCriterion ? `критерий выбора: ${settings.choiceCriterion}` : null,
    settings.audienceLanguage ? `лексика аудитории: ${settings.audienceLanguage}` : null,
    settings.excludedAudience ? `не наша аудитория: ${settings.excludedAudience}` : null,
  ]);

  section("5. ДОКАЗАТЕЛЬСТВА И МЕХАНИКА УБЕЖДЕНИЯ", [
    settings.proofs.length ? `используй доказательств: ${settings.proofCount === "auto" ? "по необходимости" : settings.proofCount}` : "не имитируй доказательства, если они не переданы",
    ...settings.proofs.filter((proof) => proof.text).map((proof) => `${proof.required ? "обязательно" : "по возможности"} [${proof.type}]: ${proof.text}${proof.source ? `; источник ${proof.source}` : ""}${proof.validAt ? `; актуально ${proof.validAt}` : ""}; ${proof.allowParaphrase ? "можно аккуратно перефразировать" : "используй дословно"}; ${proof.allowClientName ? "имя разрешено" : "имя клиента не раскрывать"}`),
    `угол подачи: ${settings.salesAngle}`,
    `формула убеждения: ${settings.persuasionFormula}`,
    settings.objectionToHandle ? `закрыть возражение: ${settings.objectionToHandle}` : null,
    `давление: ${LABELS.strength[settings.salesPressure]}`,
    settings.scarcity === "real_quantity" ? `дефицит допустим только на основании: ${settings.urgencyReason}` : "дефицит не использовать",
    settings.urgency !== "none" ? `срочность ${settings.urgency}; реальная причина: ${settings.urgencyReason || settings.eventDate}` : "срочность не использовать",
    settings.riskReducer !== "none" ? `снижение риска: ${settings.riskReducer}; не выдумывай условия` : null,
  ]);

  section("6. КОНТЕКСТ КАМПАНИИ И ПЛОЩАДКА", [
    `площадка и формат: ${rule.label} (${rule.format})`,
    `трафик: ${settings.trafficType}; температура: ${settings.audienceTemperature}; этап воронки: ${settings.funnelStage}; касание: ${settings.touchType}`,
    settings.campaign ? `кампания: ${settings.campaign}` : null,
    settings.seriesStage !== "none" ? `серия: ${settings.seriesStage}` : null,
    settings.previousPost ? `до этого было: ${settings.previousPost}; не повторяй его объяснение` : null,
    settings.nextPost ? `дальше будет: ${settings.nextPost}` : null,
    settings.audienceKnows ? `аудитория уже знает: ${settings.audienceKnows}` : null,
    settings.eventDate ? `дата или событие: ${settings.eventDate}` : null,
    `актуальность: ${settings.relevance}`,
    ...rule.guidance,
  ]);

  section("7. СТИЛЬ И ОРИГИНАЛЬНОСТЬ", [
    `язык: ${settings.language === "ru" ? "русский" : settings.language === "en" ? "английский" : "язык задачи и канала"}`,
    `формальность: ${LABELS.formality[settings.formality]}; энергия: ${LABELS.energy[settings.energy]}; юмор: ${LABELS.humor[settings.humor]}; обращение: ${LABELS.address[settings.address]}`,
    profanityMode === "auto"
      ? "мат регулируется постоянной настройкой выбранного канала; если она отсутствует и пользователь прямо не просил мат, не добавляй его"
      : profanityMode === "forbid"
      ? "мат и замаскированная обсценная лексика полностью запрещены"
      : profanityMode === "allow"
        ? "мат допустим, но не обязателен: используй его только если он естественно усиливает конкретную мысль или сохраняет авторскую подачу; не добавляй мат механически ради настройки, не искажай юридический факт, название или цитату и не оскорбляй читателя"
      : profanityMode === "masked"
        ? "ОБЯЗАТЕЛЬНО используй ровно одно уместное матерное выражение с частичной цензурой звёздочками; прямой мат запрещён; не оскорбляй читателя"
        : "ОБЯЗАТЕЛЬНО используй в готовом посте минимум одно прямое матерное выражение без цензуры; верхнего количественного лимита нет. Мат должен усиливать конкретную мысль: из того же предложения должно быть понятно, какой риск, ошибка, абсурд, польза или эмоция автора так оценивается и почему. Не вставляй отдельную дежурную фразу ради выполнения правила, не искажай матерным словом юридический факт, название или цитату, не оскорбляй читателя и не заменяй мат звёздочками или нейтральными эвфемизмами",
    `начало: ${LABELS.hook[settings.hook]}; структура: ${LABELS.structure[settings.structure]}; абзацы: ${LABELS.paragraphs[settings.paragraphs]}; списки: ${LABELS.lists[settings.lists]}`,
    `эмодзи: ${minEmojis === maxEmojis ? `ровно ${maxEmojis}` : `${minEmojis}–${maxEmojis}`}; расположение: ${settings.emojiPlacement}; хэштеги: ${minHashtags === maxHashtags ? `ровно ${maxHashtags}` : `${minHashtags}–${maxHashtags}`}; креативность: ${LABELS.creativity[settings.creativity]}`,
    settings.allowedEmojis.length ? `только допустимые эмодзи: ${settings.allowedEmojis.join(" ")}` : null,
    settings.forbiddenEmojis.length ? `запрещённые эмодзи: ${settings.forbiddenEmojis.join(" ")}` : null,
    settings.keywords.length ? `ключевые слова: ${settings.keywords.join(", ")}` : null,
    settings.signatureExpressions.length ? `фирменные выражения: ${settings.signatureExpressions.join("; ")}` : null,
    settings.goodVoiceExamples.length ? `пиши примерно так: ${settings.goodVoiceExamples.join(" | ")}` : null,
    settings.badVoiceExamples.length ? `никогда не пиши так: ${settings.badVoiceExamples.join(" | ")}` : null,
    settings.neverStart.length ? `никогда не начинай: ${settings.neverStart.join("; ")}` : null,
    settings.neverEnd.length ? `никогда не заканчивай: ${settings.neverEnd.join("; ")}` : null,
    settings.punctuationNotes ? `пунктуация: ${settings.punctuationNotes}` : null,
    settings.capitalsAllowed ? "заглавные слова допустимы как редкий смысловой акцент" : "не используй слова целиком ЗАГЛАВНЫМИ буквами, кроме общепринятых аббревиатур",
    `если создаёшь ещё один вариант, измени его так: ${settings.variantChange}`,
    `сходство с голосом: ${settings.styleMatch}; длина предложений: ${settings.sentenceLength}; сленг ${settings.slangLevel}; метафоры ${settings.metaphorLevel}; англицизмы ${settings.anglicisms}; риторические вопросы ${settings.rhetoricalQuestions}; провокация ${settings.provocationLevel}`,
    settings.requireNewAngle ? `найди новый угол и не повторяй ${settings.avoidRepetitions.join(", ") || "прошлые публикации"}; сравни с ${settings.originalityDepth} последними публикациями; допустимая похожесть: ${settings.similarityLevel}` : null,
    settings.blockGenericPhrases ? "убери общие фразы, которые не добавляют факта, примера или полезного вывода" : null,
    settings.requireConcreteExample ? "добавь минимум один конкретный пример только из переданных данных" : null,
  ]);

  section("8. CTA И ФОРМАТ ОТВЕТА", [
    `основной CTA: ${LABELS.cta[settings.cta]}, сила ${LABELS.strength[settings.ctaStrength]}, расположение ${LABELS.placement[settings.ctaPlacement]}, повторить ${settings.ctaRepeats} раз(а)`,
    settings.ctaWording ? `точная формулировка CTA: ${settings.ctaWording}` : null,
    settings.ctaDestination ? `куда ведём: ${settings.ctaDestination}` : null,
    settings.ctaOutcome ? `что будет после действия: ${settings.ctaOutcome}` : null,
    settings.ctaCodeword ? `кодовое слово: ${settings.ctaCodeword}` : null,
    settings.secondaryCta !== "none" ? `второй CTA: ${LABELS.cta[settings.secondaryCta]}` : "второй CTA отключён",
    settings.ctaAddReason ? "добавь конкретную честную причину действовать" : null,
    settings.ctaNextStep ? "объясни следующий шаг после CTA" : null,
    settings.mentions.length ? `обязательные упоминания: ${settings.mentions.join(", ")}` : null,
    settings.links.length ? `используй только эти ссылки: ${settings.links.join(", ")}` : null,
    `комплектация: ${settings.outputParts.map((part) => OUTPUT_LABELS[part]).join(", ")}`,
    `режим качества: ${BRIEF_LABELS.quality[settings.qualityMode]}`,
    `внутренний редакционный порог: не ниже ${settings.qualityThreshold}/10 по ясности мысли, конкретности, офферу, CTA, голосу и нативности; не показывай самооценку в ответе`,
    settings.qualityMode === "maximum" ? "мысленно создай три разные концепции, сравни их по цели, фактам, голосу и площадке, затем покажи только лучшую" : null,
    settings.outputParts.length === 1 ? "верни только готовую публикацию без анализа, кавычек и служебных меток" : "сначала верни готовую публикацию; затем поставь отдельную строку --- и выдай выбранные дополнительные материалы с понятными заголовками",
    "не имитируй шрифт Unicode-символами",
  ]);
  return lines.join("\n");
}

export interface PostSettingsConflict {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  fields: string[];
}

export function validatePostSettingsConflicts(raw: unknown): PostSettingsConflict[] {
  const settings = normalizePostSettings(raw);
  const conflicts: PostSettingsConflict[] = [];
  const add = (code: string, message: string, severity: PostSettingsConflict["severity"], fields: string[]) =>
    conflicts.push({ code, message, severity, fields });
  if (settings.goal === "sale") {
    const missing = [
      !settings.promotionName && "что продвигаем",
      !settings.offer && "конкретное предложение",
      !settings.mainBenefit && "главная выгода",
      settings.cta === "auto" && !settings.readerAction && "целевое действие",
    ].filter(Boolean);
    if (missing.length) add("incomplete_offer", `Оффер заполнен не полностью (${missing.join(", ")}). Пост получится скорее информационным, чем продающим.`, "warning", ["promotionName", "offer", "mainBenefit", "cta"]);
  }
  if (settings.cta === "none" && ["leads", "sales", "clicks"].includes(settings.primaryMetric)) {
    add("cta_metric", "Выбранный показатель требует действия, но призыв отключён.", "error", ["cta", "primaryMetric"]);
  }
  if (settings.creativity === "high" && settings.factStrictness === "verified") {
    add("creative_facts", "Высокая креативность применяется только к формулировкам; факты остаются строго подтверждёнными.", "info", ["creativity", "factStrictness"]);
  }
  if (settings.urgency !== "none" && !settings.urgencyReason && !settings.eventDate) {
    add("urgency_reason", "Для срочности нужна реальная причина или дата.", "error", ["urgency", "urgencyReason", "eventDate"]);
  }
  if (settings.scarcity === "real_quantity" && !settings.urgencyReason) {
    add("scarcity_reason", "Реальный дефицит требует подтверждённого ограничения количества.", "error", ["scarcity", "urgencyReason"]);
  }
  if (settings.priceMode === "required" && !settings.price) {
    add("required_price", "Цена обязательна, но поле цены не заполнено.", "error", ["priceMode", "price"]);
  }
  const requiredMaterial = settings.requiredFacts.length + settings.proofs.filter((proof) => proof.required).length;
  if (settings.length === "short" && requiredMaterial > 4) {
    add("short_with_facts", "Для короткого поста слишком много обязательных фактов. Увеличь длину или сократи материал.", "warning", ["length", "requiredFacts", "proofs"]);
  }
  if (settings.goal === "sale" && settings.secondaryCta !== "none") {
    add("multiple_sales_cta", "В продающем посте лучше оставить одно основное действие.", "warning", ["cta", "secondaryCta"]);
  }
  return conflicts;
}

export function buildPostSettingsSummary(raw: unknown, network?: string | null): string {
  const settings = normalizePostSettings(raw);
  const target = POST_TARGET_RULES[resolvePostTarget(settings, network)];
  const parts = [
    `${LABELS.goal[settings.goal][0].toLocaleUpperCase("ru")}${LABELS.goal[settings.goal].slice(1)} материал для ${settings.audience || "аудитории выбранного канала"}.`,
    settings.promotionName ? `Продвигаем: ${settings.promotionName}${settings.price && settings.priceMode !== "never" ? ` (${settings.price})` : ""}.` : "",
    settings.mainBenefit ? `Главная выгода: ${settings.mainBenefit}.` : "",
    settings.audienceProblem ? `Проблема: ${settings.audienceProblem}.` : "",
    settings.objection ? `Закрываем возражение: ${settings.objection}.` : "",
    settings.proofs.length ? `Используем доказательств: ${settings.proofs.length}.` : "",
    `Формат: ${target.label}.`,
    `Мат: ${settings.profanityMode === "auto" ? "по настройке канала или прямому запросу" : settings.profanityMode === "forbid" ? "запрещён" : settings.profanityMode === "allow" ? "допустим, но не обязателен" : settings.profanityMode === "masked" ? "одно обязательное выражение со звёздочками" : "обязателен без цензуры и лимита"}.`,
    `Действие: ${settings.readerAction || LABELS.cta[settings.cta]}.`,
    `Качество: ${settings.qualityMode === "fast" ? "быстро" : settings.qualityMode === "maximum" ? "максимальное" : "сбалансированно"}.`,
  ].filter(Boolean);
  return parts.join(" ");
}

/** Основной текст отделён от дополнительных материалов единым разделителем. */
export function postSettingsPrimaryText(text: string, raw: unknown): string {
  const settings = normalizePostSettings(raw);
  const value = String(text ?? "").trim();
  return settings.outputParts.length > 1 ? value.split(/\n\s*---\s*\n/u)[0].trim() : value;
}

/**
 * Настройки одной публикации имеют приоритет над постоянным профилем канала.
 * Возвращаем только поля, которые умеет детерминированно проверить общий quality-gate.
 */
export function postSettingsQualityOverrides(
  raw: unknown,
  context: { network?: string | null; kind?: AiKind; task?: string } = {},
): Record<string, unknown> {
  const settings = normalizePostSettings(raw);
  const profanityMode = resolvePostProfanityMode(settings, context.task);
  const target = resolvePostTarget(settings, context.network, context.kind);
  const rule = POST_TARGET_RULES[target];
  const [minChars, maxChars] = effectiveLengthRange(settings, rule, context);
  const [, maxEmojis] = emojiRange(settings, rule);
  const [, maxHashtags] = hashtagRange(settings, rule);
  return {
    minChars,
    maxChars,
    hookRequired: settings.hook !== "none",
    hookMaxChars: target === "youtube_title" ? rule.hardLimit : 120,
    maxParagraphSentences: settings.paragraphs === "short" ? 2 : settings.paragraphs === "medium" ? 4 : 3,
    requireConclusion: settings.includeConclusion,
    listPolicy: settings.lists === "required" ? "required" : settings.lists === "avoid" ? "avoid" : "when_useful",
    ...(settings.address === "auto" ? {} : { address: settings.address }),
    ...(profanityMode === "auto"
      ? {}
      : {
          profanity: profanityMode === "forbid" ? "forbid" : "allow",
          profanityLevel: profanityMode === "forbid" ? 0 : profanityMode === "allow" ? 70 : profanityMode === "masked" ? 50 : 100,
        }),
    emojiPolicy: settings.emojiMode === "none" ? "none" : "restrained",
    maxEmojis,
    hashtagsPolicy: settings.hashtags === "none" ? "none" : "restrained",
    maxHashtags,
    factsPolicy: settings.factStrictness === "verified"
      ? "source_required"
      : settings.factStrictness === "off" || settings.factStrictness === "general"
        ? "open"
        : "no_unverified_specifics",
    forbiddenPhrases: [...(settings.blockAiCliches ? AI_CLICHES : []), ...settings.forbiddenWords, ...settings.bannedExpressions],
    forbiddenTopics: settings.forbiddenTopics,
    qualityThreshold: settings.qualityThreshold * 10,
    retryLimit: settings.qualityMode === "fast" ? 1 : settings.qualityMode === "maximum" ? 3 : 2,
  };
}

export interface PostSettingsViolation {
  code: string;
  message: string;
  blocker: boolean;
}

export interface PostSettingsValidation {
  passed: boolean;
  violations: PostSettingsViolation[];
  metrics: {
    chars: number;
    bytes: number;
    emojis: number;
    hashtags: number;
    mentions: number;
    qualityScore: number;
    maxSimilarity: number | null;
  };
  target: Exclude<PostTarget, "auto">;
}

const emojiPattern = /\p{Extended_Pictographic}/gu;
const hashtagPattern = /(^|\s)#[\p{L}\p{N}_]+/gu;
const hashtagTokenPattern = /#[\p{L}\p{N}_]+/gu;
const mentionPattern = /(^|\s)@[\p{L}\p{N}_.]+/gu;
// Unicode-lookaround не ловит корни внутри обычных слов вроде «страхуй».
const directProfanityWordPattern = /(?<!\p{L})(?:(?:на|по|о|за|до|вы|при)?ху(?:й|е|ё|я|и)\p{L}*|пизд\p{L}*|(?:за|до|по|на|вы|при|под)?(?:еб|ёб)\p{L}*|бля(?:д\p{L}*)?|мудак\p{L}*|долбоеб\p{L}*)(?!\p{L})/giu;
const maskedProfanityWordPattern = /(?<!\p{L})(?:х[\p{L}]*\*+[\p{L}]*|п[\p{L}]*\*+[\p{L}]*|[её][\p{L}]*\*+[\p{L}]*|бл[\p{L}]*\*+[\p{L}]*|муд[\p{L}]*\*+[\p{L}]*|долбо[\p{L}]*\*+[\p{L}]*)(?!\p{L})/giu;
const listPattern = /(?:^|\n)\s*(?:[-—•]|\d+[.)])\s+/mu;
const informalAddressPattern = /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твою|твоим|твоих)(?!\p{L})/iu;
const formalAddressPattern = /(?:^|[^\p{L}])(?:вы|вас|вам|вами|ваш|ваша|ваше|ваши|вашего|вашей|вашу|вашим|ваших)(?!\p{L})/iu;
const uppercaseWordPattern = /(?:^|[^\p{L}\p{N}])([\p{Lu}Ё]{3,})(?![\p{L}\p{N}])/gu;
const COMMON_UPPERCASE = new Set(["AI", "ИИ", "IT", "ИТ", "CTA", "API", "VK", "ВК", "FAQ", "B2B", "B2C", "SEO", "SMM", "URL", "UTM", "PDF"]);
const AI_CLICHES = [
  "в современном мире",
  "ни для кого не секрет",
  "давайте разберемся",
  "давайте разберёмся",
  "важно отметить",
  "готовы узнать секрет",
  "уникальная возможность",
];

function containsPhrase(text: string, phrase: string): boolean {
  return text.toLocaleLowerCase("ru").includes(phrase.toLocaleLowerCase("ru"));
}

function ctaPattern(type: CtaType): RegExp | null {
  const patterns: Partial<Record<CtaType, RegExp>> = {
    comment: /(?:напиш|расскаж|поделит|ответ)\p{L}*(?:\s.{0,30})?(?:комментар|мнение|опыт)/iu,
    save: /сохран\p{L}*/iu,
    share: /подел\p{L}*|отправ\p{L}*\s+(?:друг|коллег)/iu,
    subscribe: /подпиш\p{L}*/iu,
    click: /перейд\p{L}*|по\s+ссылке|ссылка\s+(?:в|ниже|выше)/iu,
    buy: /куп\p{L}*|закаж\p{L}*|остав\p{L}*\s+заявк|запиш\p{L}*/iu,
    reply: /ответ\p{L}*|напиш\p{L}*\s+(?:мне|нам|в\s+личн)/iu,
    register: /зарегистр\p{L}*|регистрац\p{L}*/iu,
    download: /скача\p{L}*|получи\p{L}*\s+(?:файл|гайд|материал|чек)/iu,
  };
  return patterns[type] ?? null;
}

function ctaPresent(text: string, type: CtaType): boolean {
  return type === "auto" || type === "none" || Boolean(ctaPattern(type)?.test(text));
}

function ctaCount(text: string, type: CtaType, wording: string): number {
  if (wording) {
    const escaped = wording.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return (text.match(new RegExp(escaped, "giu")) ?? []).length;
  }
  const pattern = ctaPattern(type);
  if (!pattern) return 0;
  return (text.match(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`)) ?? []).length;
}

function sentenceWordCounts(text: string): number[] {
  return text
    .split(/[.!?…]+/u)
    .map((sentence) => sentence.match(/[\p{L}\p{N}]+/gu)?.length ?? 0)
    .filter(Boolean);
}

function normalizedWordSet(text: string): Set<string> {
  return new Set(
    text.toLocaleLowerCase("ru")
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => word.length >= 4) ?? [],
  );
}

function lexicalSimilarity(left: string, right: string): number {
  const a = normalizedWordSet(left);
  const b = normalizedWordSet(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const word of a) if (b.has(word)) intersection += 1;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function maxHistorySimilarity(text: string, history: readonly string[]): number | null {
  const values = history.map((item) => String(item ?? "").trim()).filter(Boolean);
  if (!values.length) return null;
  return Math.max(...values.map((item) => lexicalSimilarity(text, item)));
}

export function validatePostSettingsResult(
  text: string,
  raw: unknown,
  context: { network?: string | null; kind?: AiKind; task?: string; history?: readonly string[] } = {},
): PostSettingsValidation {
  const settings = normalizePostSettings(raw);
  const profanityMode = resolvePostProfanityMode(settings, context.task);
  const target = resolvePostTarget(settings, context.network, context.kind);
  const rule = POST_TARGET_RULES[target];
  const [minChars, maxChars] = effectiveLengthRange(settings, rule, context);
  const [minEmojis, maxEmojis] = emojiRange(settings, rule);
  const [minHashtags, maxHashtags] = hashtagRange(settings, rule);
  const value = postSettingsPrimaryText(text, settings);
  const bytes = new TextEncoder().encode(value).byteLength;
  const emojiTokens = value.match(emojiPattern) ?? [];
  const hashtagTokens = value.match(hashtagTokenPattern) ?? [];
  const maxSimilarity = maxHistorySimilarity(value, context.history ?? []);
  const metrics = {
    chars: value.length,
    bytes,
    emojis: emojiTokens.length,
    hashtags: hashtagTokens.length,
    mentions: (value.match(mentionPattern) ?? []).length,
    qualityScore: 100,
    maxSimilarity,
  };
  const violations: PostSettingsViolation[] = [];
  const add = (code: string, message: string, blocker = true) => violations.push({ code, message, blocker });
  if (!value) add("empty", "Модель не вернула готовый текст");
  if (metrics.chars < minChars) add("too_short", `Нужно ${minChars}–${maxChars} знаков, сейчас ${metrics.chars}`);
  if (metrics.chars > maxChars) add("too_long", `Нужно ${minChars}–${maxChars} знаков, сейчас ${metrics.chars}`);
  const hardValue = rule.hardLimitUnit === "bytes" ? metrics.bytes : metrics.chars;
  if (hardValue > rule.hardLimit) add("platform_limit", `Превышен предел ${rule.label}: ${rule.hardLimit} ${rule.hardLimitUnit === "bytes" ? "байт" : "знаков"}`);
  if (metrics.emojis < minEmojis || metrics.emojis > maxEmojis) {
    add("emoji", `Эмодзи должно быть ${minEmojis === maxEmojis ? `ровно ${maxEmojis}` : `${minEmojis}–${maxEmojis}`}, сейчас ${metrics.emojis}`);
  }
  if (metrics.hashtags < minHashtags || metrics.hashtags > maxHashtags) {
    add("hashtags", `Хэштегов должно быть ${minHashtags === maxHashtags ? `ровно ${maxHashtags}` : `${minHashtags}–${maxHashtags}`}, сейчас ${metrics.hashtags}`);
  }
  if (settings.allowedEmojis.length) {
    const unexpected = emojiTokens.filter((item) => !settings.allowedEmojis.includes(item));
    if (unexpected.length) add("allowed_emoji", `Используй только выбранные эмодзи: ${settings.allowedEmojis.join(" ")}`);
  }
  const forbiddenEmoji = emojiTokens.find((item) => settings.forbiddenEmojis.includes(item));
  if (forbiddenEmoji) add("forbidden_emoji", `Запрещённый эмодзи: ${forbiddenEmoji}`);
  if (metrics.emojis > 0 && settings.emojiPlacement === "line_end") {
    const misplaced = value.split("\n").some((line) => line.match(emojiPattern)?.length && !/\p{Extended_Pictographic}\s*$/u.test(line));
    if (misplaced) add("emoji_placement", "Каждый эмодзи должен стоять в конце строки");
  }
  if (metrics.emojis > 0 && settings.emojiPlacement === "bullets") {
    const misplaced = value.split("\n").some((line) => line.match(emojiPattern)?.length && !/^\s*\p{Extended_Pictographic}/u.test(line));
    if (misplaced) add("emoji_placement", "Используй эмодзи только как маркеры в начале строк");
  }
  if (metrics.emojis > 0 && settings.emojiPlacement === "inline") {
    const hasInline = value.split("\n").some((line) => /\p{Extended_Pictographic}\s+\p{L}/u.test(line));
    if (!hasInline) add("emoji_placement", "Размести эмодзи внутри строк, а не отдельными маркерами или только в финале");
  }
  if (rule.platformMentionMax !== null && metrics.mentions > rule.platformMentionMax) add("mentions", `Упоминаний ${metrics.mentions}, разрешено максимум ${rule.platformMentionMax}`);
  if (target.startsWith("youtube_") && /[<>]/.test(value)) add("youtube_chars", "YouTube не принимает символы < и > в этом поле");
  if (target === "youtube_title" && /\n/.test(value)) add("title_lines", "Заголовок YouTube должен занимать одну строку");
  if (target === "youtube_title" && /[.!?…]$/.test(value)) add("title_punctuation", "Убери финальную точку или восклицание из заголовка", false);
  const directProfanityCount = (value.match(directProfanityWordPattern) ?? []).length;
  const maskedProfanityCount = (value.match(maskedProfanityWordPattern) ?? []).length;
  if (profanityMode === "forbid" && (directProfanityCount > 0 || maskedProfanityCount > 0)) {
    add("profanity", "Мат, включая цензурированный звёздочками, запрещён настройками публикации");
  } else if (profanityMode === "masked") {
    if (directProfanityCount > 0) add("profanity_direct", "Прямой мат запрещён: оставь ровно одно выражение со звёздочками");
    if (maskedProfanityCount !== 1) add("profanity_required", `Нужно ровно одно цензурированное матерное выражение, сейчас ${maskedProfanityCount}`);
  } else if (profanityMode === "required_direct" && directProfanityCount === 0) {
    add(
      "profanity_required",
      "Добавь минимум одно прямое матерное выражение без звёздочек внутрь содержательного предложения: должно быть понятно, какой конкретный риск, ошибка, абсурд, польза или эмоция так оценивается и почему. Не добавляй отдельную дежурную фразу ради проверки",
    );
  }
  for (const phrase of [...(settings.blockAiCliches ? AI_CLICHES : []), ...settings.forbiddenWords, ...settings.bannedExpressions]) {
    if (containsPhrase(value, phrase)) add("forbidden_phrase", `Запрещённая формулировка: «${phrase}»`);
  }
  for (const topic of settings.forbiddenTopics) {
    if (containsPhrase(value, topic)) add("forbidden_topic", `Текст затрагивает запрещённую тему: «${topic}»`);
  }
  for (const fact of settings.requiredFacts) {
    if (!containsPhrase(value, fact)) add("required_fact", `Не сохранён обязательный факт: «${fact}»`);
  }
  for (const proof of settings.proofs.filter((item) => item.required && !item.allowParaphrase)) {
    if (!containsPhrase(value, proof.text)) add("required_proof", `Не использовано обязательное доказательство дословно: «${proof.text}»`);
  }
  for (const keyword of settings.keywords) {
    if (!containsPhrase(value, keyword)) add("keyword", `Нет обязательного ключевого слова: «${keyword}»`);
  }
  for (const mention of settings.mentions) {
    if (!value.includes(mention)) add("mention", `Нет обязательного упоминания: «${mention}»`);
  }
  for (const link of settings.links) {
    if (!value.includes(link)) add("link", `Нет обязательной ссылки: «${link}»`);
  }
  if (settings.ctaWording && !containsPhrase(value, settings.ctaWording)) add("cta_wording", `Нет заданной формулировки призыва: «${settings.ctaWording}»`);
  if (settings.ctaCodeword && !containsPhrase(value, settings.ctaCodeword)) add("cta_codeword", `Нет кодового слова: «${settings.ctaCodeword}»`);
  if (settings.ctaDestination && /^https?:\/\//iu.test(settings.ctaDestination) && !value.includes(settings.ctaDestination)) add("cta_destination", `Нет ссылки для призыва: «${settings.ctaDestination}»`);
  if (!ctaPresent(value, settings.cta)) add("cta", `Нет выбранного призыва: ${LABELS.cta[settings.cta]}`);
  if (!["auto", "none"].includes(settings.cta)) {
    const count = ctaCount(value, settings.cta, settings.ctaWording);
    if (count !== settings.ctaRepeats) add("cta_repeats", `Призыв должен встретиться ровно ${settings.ctaRepeats} раз(а), сейчас ${count}`);
    if (settings.ctaPlacement === "end") {
      const finalPart = value.slice(Math.floor(value.length * 0.65));
      if (!ctaPresent(finalPart, settings.cta) && !(settings.ctaWording && containsPhrase(finalPart, settings.ctaWording))) {
        add("cta_placement", "Размести основной призыв в заключительной части поста");
      }
    }
  }
  if (settings.secondaryCta !== "none" && !ctaPresent(value, settings.secondaryCta)) {
    add("secondary_cta", `Нет второго призыва: ${LABELS.cta[settings.secondaryCta]}`);
  }
  if (settings.cta === "none" && /(?:подпиш\p{L}*|переход\p{L}*\s+по\s+ссылке|остав\p{L}*\s+заявк|куп\p{L}*\s+сейчас)/iu.test(value)) {
    add("unexpected_cta", "Призыв отключён, но текст всё равно призывает к действию");
  }
  const hasList = listPattern.test(value);
  if (settings.lists === "required" && !hasList) add("list_required", "По настройкам в публикации обязателен один список");
  if (settings.lists === "avoid" && hasList) add("list_forbidden", "По настройкам списки запрещены");
  if (settings.structure === "list" && !hasList) add("structure_list", "Выбрана структура списка, но список отсутствует");
  const paragraphs = value.split(/\n\s*\n/u).map((item) => item.trim()).filter(Boolean);
  const paragraphLimit = settings.paragraphs === "short" ? 2 : settings.paragraphs === "medium" ? 4 : null;
  if (paragraphLimit !== null && paragraphs.some((paragraph) => sentenceWordCounts(paragraph).length > paragraphLimit)) {
    add("paragraphs", `В одном абзаце должно быть не больше ${paragraphLimit} предложений`);
  }
  const cyrillic = (value.match(/[А-Яа-яЁё]/g) ?? []).length;
  const latin = (value.match(/[A-Za-z]/g) ?? []).length;
  if (settings.language === "ru" && latin > Math.max(12, cyrillic * 0.22)) add("language", "Основной язык должен быть русским");
  if (settings.language === "en" && cyrillic > Math.max(8, latin * 0.12)) add("language", "Основной язык должен быть английским");
  if (settings.address === "вы" && informalAddressPattern.test(value)) add("address", "Обращайся к читателю только на «вы»");
  if (settings.address === "ты" && formalAddressPattern.test(value)) add("address", "Обращайся к читателю только на «ты»");
  if (settings.address === "neutral" && (informalAddressPattern.test(value) || formalAddressPattern.test(value))) add("address", "Пиши без прямого обращения к читателю");
  if (!settings.capitalsAllowed) {
    const requiredUppercase = new Set(
      [
        settings.ctaCodeword,
        ...settings.keywords,
        ...settings.mentions,
        ...settings.requiredFacts,
        ...settings.proofs.map((proof) => proof.text),
      ].flatMap((item) => String(item ?? "").match(/[\p{Lu}Ё]{3,}/gu) ?? []),
    );
    const uppercaseWords = [...value.matchAll(uppercaseWordPattern)]
      .map((match) => match[1])
      .filter((word) => !COMMON_UPPERCASE.has(word) && !requiredUppercase.has(word));
    if (uppercaseWords.length) add("capitals", `Не используй слова целиком заглавными буквами: ${uppercaseWords.slice(0, 3).join(", ")}`);
  }
  const sentenceLengths = sentenceWordCounts(value);
  if (settings.sentenceLength === "short" && sentenceLengths.some((count) => count > 16)) add("sentence_length", "Сократи предложения: каждое должно быть не длиннее 16 слов");
  if (settings.sentenceLength === "long" && sentenceLengths.length > 1 && sentenceLengths.reduce((sum, item) => sum + item, 0) / sentenceLengths.length < 12) add("sentence_length", "Используй более развёрнутые предложения");
  if (settings.sentenceLength === "mixed" && sentenceLengths.length >= 3 && Math.max(...sentenceLengths) - Math.min(...sentenceLengths) < 7) add("sentence_rhythm", "Сделай ритм разнообразнее: сочетай короткие и развёрнутые предложения");
  const questionCount = (value.match(/\?/g) ?? []).length;
  if (settings.rhetoricalQuestions === "none" && questionCount > 0) add("rhetorical_questions", "Риторические вопросы запрещены");
  if (settings.rhetoricalQuestions === "high" && questionCount === 0) add("rhetorical_questions", "Добавь один уместный риторический вопрос");
  for (const start of settings.neverStart) {
    if (value.toLocaleLowerCase("ru").startsWith(start.toLocaleLowerCase("ru"))) add("never_start", `Публикация не должна начинаться с «${start}»`);
  }
  for (const end of settings.neverEnd) {
    if (value.toLocaleLowerCase("ru").replace(/[.!?…\s]+$/u, "").endsWith(end.toLocaleLowerCase("ru").replace(/[.!?…\s]+$/u, ""))) add("never_end", `Публикация не должна заканчиваться на «${end}»`);
  }
  if (settings.signatureExpressions.length && !settings.signatureExpressions.some((phrase) => containsPhrase(value, phrase))) {
    add("signature_expression", `Используй хотя бы одно фирменное выражение: ${settings.signatureExpressions.join("; ")}`);
  }
  if (settings.requireConcreteExample && !/(?:например|к примеру|представьте|допустим|вот конкретный пример|случай из практики)/iu.test(value)) {
    add("concrete_example", "Добавь конкретный пример только из переданных данных");
  }
  if (settings.priceMode === "required" && settings.price && !containsPhrase(value, settings.price)) add("price_required", `Укажи выбранную цену дословно: «${settings.price}»`);
  if (settings.priceMode === "never" && settings.price && containsPhrase(value, settings.price)) add("price_forbidden", "Убери цену: для этой публикации она запрещена");
  if (settings.requireNewAngle && settings.similarityLevel !== "allow" && maxSimilarity !== null) {
    const threshold = settings.similarityLevel === "strict" ? 0.34 : 0.52;
    if (maxSimilarity >= threshold) add("similarity", `Публикация слишком похожа на историю канала (${Math.round(maxSimilarity * 100)}%); нужен другой угол, структура и формулировки`);
  }
  if (/\p{Extended_Pictographic}{3,}/u.test(value)) add("emoji_chain", "Убери цепочку из трёх и более эмодзи");
  if (/(?:^|[^\p{L}])(?:хук|основная часть|вывод|cta|призыв к действию)\s*:/iu.test(value)) add("meta_labels", "В публикацию попали служебные метки промпта");
  const words = value.toLocaleLowerCase("ru").match(/[\p{L}\p{N}]+/gu) ?? [];
  const lexicalDiversity = words.length ? new Set(words).size / words.length : 1;
  const qualityPenalty = violations.reduce((sum, item) => sum + (item.blocker ? 12 : 3), 0)
    + (words.length > 45 && lexicalDiversity < 0.46 ? 8 : 0)
    + (/(?:в целом|следует отметить|данный вопрос|осуществлять|является важным)/iu.test(value) ? 6 : 0);
  metrics.qualityScore = Math.max(0, 100 - qualityPenalty);
  const qualityThreshold = settings.qualityThreshold * 10;
  if (metrics.qualityScore < qualityThreshold) {
    add("quality_score", `Редакционная оценка ${Math.round(metrics.qualityScore / 10)}/10 — нужно минимум ${settings.qualityThreshold}/10`);
  }
  return { passed: violations.every((item) => !item.blocker), violations, metrics, target };
}

const DEFAULT_EMOJIS = ["✨", "💡", "✅", "📌", "🚀", "💬", "🔹", "🔥"] as const;
const HASHTAG_STOP_WORDS = new Set([
  "этот", "эта", "это", "эти", "того", "чтобы", "когда", "который", "которая", "после", "перед", "через",
  "если", "почему", "нужно", "можно", "будет", "пост", "текст", "аврора", "the", "and", "with", "from", "this",
]);

function appendBeforeHashtags(text: string, addition: string): string {
  const value = text.trim();
  const lines = value.split("\n");
  const hashtagStart = lines.findIndex((line) => /^\s*(?:#[\p{L}\p{N}_]+\s*)+$/u.test(line));
  if (hashtagStart < 0) return `${value}\n\n${addition}`.trim();
  lines.splice(hashtagStart, 0, addition, "");
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function normalizeRequiredProfanity(text: string, mode: ProfanityMode): string {
  let value = text;
  if (mode === "forbid") {
    return value
      .replace(directProfanityWordPattern, "чёрт")
      .replace(maskedProfanityWordPattern, "чёрт");
  }
  let kept = false;
  if (mode === "masked") {
    value = value.replace(directProfanityWordPattern, () => {
      if (!kept) {
        kept = true;
        return "бл***";
      }
      return "очень";
    });
    value = value.replace(maskedProfanityWordPattern, () => {
      if (!kept) {
        kept = true;
        return "бл***";
      }
      return "очень";
    });
    return kept ? value : appendBeforeHashtags(value, "Скажу прямо: это, бл***, действительно важно.");
  }
  // В обязательном прямом режиме наличие мата проверяет semantic repair-loop.
  // Детерминированно вставлять слово сюда нельзя: без понимания смысла оно почти наверняка
  // окажется механической припиской. В допустимом режиме также сохраняем выбор модели.
  return value;
}

function hashtagCandidates(settings: PostSettings, task: string | undefined, text: string): string[] {
  const values = [
    ...settings.keywords,
    settings.promotionName,
    settings.mainIdea,
    task ?? "",
    text,
  ];
  const words = values
    .flatMap((item) => String(item).match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((item) => item.toLocaleLowerCase("ru"))
    .filter((item) => item.length >= 4 && !HASHTAG_STOP_WORDS.has(item));
  return [...new Set(words)].map((item) => `#${item[0].toLocaleUpperCase("ru")}${item.slice(1)}`);
}

function placeMissingEmojis(text: string, emojis: readonly string[], placement: EmojiPlacement): string {
  if (!emojis.length) return text;
  const lines = text.split("\n");
  const candidates = lines
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => line.trim() && !/^\s*#/u.test(line));
  if (!candidates.length) return `${text}\n\n${emojis.join(" ")}`.trim();
  emojis.forEach((emoji, offset) => {
    const target = candidates[offset % candidates.length];
    const line = lines[target.index];
    if (placement === "bullets") lines[target.index] = `${emoji} ${line.trimStart()}`;
    else if (placement === "inline") {
      const match = line.match(/^\s*\S+/u)?.[0] ?? line;
      lines[target.index] = `${match} ${emoji}${line.slice(match.length)}`;
    } else lines[target.index] = `${line.trimEnd()} ${emoji}`;
  });
  return lines.join("\n");
}

/**
 * Последний безопасный слой для механических требований. Он не сочиняет факты и не
 * заменяет редактуру: только приводит мат, эмодзи, хэштеги и регистр к выбранному режиму.
 */
export function finalizePostSettingsDeterministically(
  text: string,
  raw: unknown,
  context: { network?: string | null; kind?: AiKind; task?: string } = {},
): string {
  const settings = normalizePostSettings(raw);
  const profanityMode = resolvePostProfanityMode(settings, context.task);
  const target = resolvePostTarget(settings, context.network, context.kind);
  const rule = POST_TARGET_RULES[target];
  const [minEmojis, maxEmojis] = emojiRange(settings, rule);
  const [minHashtags, maxHashtags] = hashtagRange(settings, rule);
  const full = String(text ?? "").trim();
  const primary = postSettingsPrimaryText(full, settings);
  const extras = settings.outputParts.length > 1 ? full.slice(primary.length).trimStart() : "";
  let value = normalizeRequiredProfanity(primary, profanityMode);

  const allowed = settings.allowedEmojis.length ? settings.allowedEmojis : [...DEFAULT_EMOJIS];
  const usable = allowed.filter((item) => !settings.forbiddenEmojis.includes(item));
  value = value.replace(emojiPattern, (item) => {
    if (settings.forbiddenEmojis.includes(item)) return "";
    if (settings.allowedEmojis.length && !settings.allowedEmojis.includes(item)) return "";
    return item;
  });
  let seenEmojis = 0;
  value = value.replace(emojiPattern, (item) => {
    seenEmojis += 1;
    return seenEmojis <= maxEmojis ? item : "";
  });
  const currentEmojiCount = (value.match(emojiPattern) ?? []).length;
  if (currentEmojiCount < minEmojis && usable.length) {
    const missing = Array.from({ length: minEmojis - currentEmojiCount }, (_, index) => usable[index % usable.length]);
    value = placeMissingEmojis(value, missing, settings.emojiPlacement);
  }

  if (settings.hashtags !== "auto") {
    const existing = value.match(hashtagTokenPattern) ?? [];
    value = value.replace(hashtagPattern, "$1").replace(/[ \t]+\n/g, "\n").trim();
    if (maxHashtags > 0) {
      const tags = [...new Set([...existing, ...hashtagCandidates(settings, context.task, value)])].slice(0, maxHashtags);
      while (tags.length < minHashtags) tags.push(`#Тема${tags.length + 1}`);
      value = `${value}\n\n${tags.join(" ")}`.trim();
    }
  }

  if (!settings.capitalsAllowed) {
    value = value.replace(uppercaseWordPattern, (match, word: string) =>
      COMMON_UPPERCASE.has(word) ? match : match.replace(word, word.toLocaleLowerCase("ru")));
  }
  return extras ? `${value}\n${extras}`.trim() : value.trim();
}

export function buildPostRepairInstructions(result: PostSettingsValidation): string[] {
  return result.violations.filter((item) => item.blocker).map((item) => item.message).slice(0, 12);
}

export function postSettingsOutputTokens(raw: unknown, network?: string | null, kind?: AiKind, task?: string): number {
  const settings = normalizePostSettings(raw);
  const rule = POST_TARGET_RULES[resolvePostTarget(settings, network, kind)];
  const [, maxChars] = effectiveLengthRange(settings, rule, { network, kind, task });
  const extrasBudget = Math.max(0, settings.outputParts.length - 1) * 180;
  return Math.min(4000, Math.max(300, Math.ceil(maxChars / 2) + extrasBudget));
}
