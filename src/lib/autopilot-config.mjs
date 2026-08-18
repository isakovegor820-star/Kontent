// Pure Autopilot planning contract shared by the Next.js UI/API and worker.
// Keep this module dependency-free: worker.mjs imports it directly and the client bundles
// the public option lists.

export const AUTOPILOT_ENGINE_OPTIONS = Object.freeze([
  {
    id: "navy-deepseek-pro",
    label: "DeepSeek V4 Pro",
    note: "Лучше держит длинный план, стиль и редакционные ограничения.",
  },
  {
    id: "navy-deepseek-flash",
    label: "DeepSeek V4 Flash",
    note: "Быстрее собирает черновики и короткие форматы.",
  },
  {
    id: "navy-gpt-5-4",
    label: "GPT-5.4",
    note: "Сильнее в сложной структуре и аккуратной редактуре.",
  },
  {
    id: "navy-qwen-3-6",
    label: "Qwen 3.6 27B",
    note: "Экономный вариант для коротких постов и подборок.",
  },
  {
    id: "navy-minimax-m3",
    label: "MiniMax M3",
    note: "Подходит для длинного контекста и вариативных подач.",
  },
]);

export const DEFAULT_AUTOPILOT_ENGINE = "navy-gpt-5-4";
export const AUTOPILOT_PLANNING_MONTHS = Object.freeze([1, 2, 3]);
export const AUTOPILOT_WEEKS_PER_MONTH = 4;
export const MIN_AUTOPILOT_PLANNING_WEEKS = 1;
export const MAX_AUTOPILOT_PLANNING_WEEKS = 12;
export const DEFAULT_AUTOPILOT_PLANNING_WEEKS = 1;
export const MAX_AUTOPILOT_PLAN_POSTS = 90;
export const AUTOPILOT_SIMILARITY_THRESHOLD = 0.62;

const ENGINE_IDS = new Set(AUTOPILOT_ENGINE_OPTIONS.map((option) => option.id));
const MONTHS = new Set(AUTOPILOT_PLANNING_MONTHS);

export function isAutopilotEngine(value) {
  return typeof value === "string" && ENGINE_IDS.has(value);
}

export function normalizeAutopilotEngine(value, fallback = DEFAULT_AUTOPILOT_ENGINE) {
  return isAutopilotEngine(value) ? value : fallback;
}

export function normalizePlanningMonths(value, fallback = 1) {
  const months = Math.round(Number(value));
  return MONTHS.has(months) ? months : fallback;
}

export function planningWeeks(months) {
  return normalizePlanningMonths(months) * AUTOPILOT_WEEKS_PER_MONTH;
}

export function isAutopilotPlanningWeeks(value) {
  const weeks = Number(value);
  return Number.isInteger(weeks) &&
    weeks >= MIN_AUTOPILOT_PLANNING_WEEKS &&
    weeks <= MAX_AUTOPILOT_PLANNING_WEEKS;
}

export function normalizePlanningWeeks(value, fallback = DEFAULT_AUTOPILOT_PLANNING_WEEKS) {
  return isAutopilotPlanningWeeks(value) ? Number(value) : fallback;
}

export function plannedPostCountForWeeks(postFrequency, weeks) {
  const frequency = Math.max(1, Math.round(Number(postFrequency) || 1));
  return Math.min(MAX_AUTOPILOT_PLAN_POSTS, frequency * normalizePlanningWeeks(weeks));
}

export function planCountWasCappedForWeeks(postFrequency, weeks) {
  const frequency = Math.max(1, Math.round(Number(postFrequency) || 1));
  return frequency * normalizePlanningWeeks(weeks) > MAX_AUTOPILOT_PLAN_POSTS;
}

export function plannedPostCount(postFrequency, months) {
  const frequency = Math.max(1, Math.round(Number(postFrequency) || 1));
  return Math.min(MAX_AUTOPILOT_PLAN_POSTS, frequency * planningWeeks(months));
}

export function planCountWasCapped(postFrequency, months) {
  const frequency = Math.max(1, Math.round(Number(postFrequency) || 1));
  return frequency * planningWeeks(months) > MAX_AUTOPILOT_PLAN_POSTS;
}

const STOP_WORDS = new Set([
  "без", "был", "была", "были", "быть", "вам", "вас", "ваш", "ведь", "весь",
  "для", "его", "если", "есть", "еще", "или", "как", "когда", "который", "лишь",
  "между", "может", "над", "она", "они", "оно", "при", "про", "так", "также", "там",
  "тем", "того", "только", "уже", "чем", "что", "это", "этот", "этой", "этого",
  "материал", "носит", "информационный", "характер", "является", "юридической",
  "консультацией",
]);

function tokens(value) {
  return String(value || "")
    .toLocaleLowerCase("ru-RU")
    .replace(/https?:\/\/\S+/gu, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function jaccard(left, right) {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function bigrams(values) {
  const out = [];
  for (let index = 0; index < values.length - 1; index++) {
    out.push(`${values[index]} ${values[index + 1]}`);
  }
  return out;
}

export function autopilotTextSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  const words = jaccard(a, b);
  const phrases = jaccard(bigrams(a), bigrams(b));
  return Math.max(0, Math.min(1, words * 0.45 + phrases * 0.55));
}

export function autopilotTopicSimilarity(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (!a.length || !b.length) return 0;
  return jaccard(a, b);
}

export function findAutopilotNearDuplicate(candidate, existing, threshold = AUTOPILOT_SIMILARITY_THRESHOLD) {
  let best = null;
  for (let index = 0; index < existing.length; index++) {
    const other = existing[index];
    const topicScore = autopilotTopicSimilarity(candidate?.topic, other?.topic);
    const textScore = autopilotTextSimilarity(candidate?.draft, other?.draft);
    const score = Math.max(topicScore, textScore);
    if (score >= threshold && (!best || score > best.score)) {
      best = { index, score, topicScore, textScore };
    }
  }
  return best;
}

const PRESENTATIONS = Object.freeze([
  ["объяснение", "тезис → короткое объяснение → практический вывод", "от наблюдения"],
  ["чек-лист", "короткое введение → список проверок → вывод", "с конкретного действия"],
  ["вопрос — ответ", "вопрос читателя → прямой ответ → важный нюанс", "с вопроса"],
  ["миф и факт", "распространённое заблуждение → подтверждённый факт → вывод", "с контраста"],
  ["памятка", "короткая рамка → 3–5 опорных пунктов → итог", "с обещания пользы"],
  ["разбор ошибки", "ошибка без выдуманного кейса → почему возникает → как проверить себя", "с ошибки"],
  ["сравнение", "два подтверждённых подхода → различия → когда смотреть каждый", "с различия"],
  ["пошаговый разбор", "исходная ситуация → последовательность шагов → результат", "с первого шага"],
  ["короткая заметка", "одна сильная мысль → один факт → один вопрос", "с короткого тезиса"],
  ["редакторская колонка", "позиция автора → подтверждение → спокойный вывод", "с позиции"],
  ["подборка", "контекст → несколько самостоятельных пунктов → общий вывод", "с числа пунктов"],
  ["диалог с читателем", "вопрос → объяснение простыми словами → приглашение ответить", "с реплики читателя"],
]);

function allowedDecoration(quality, key, countKey) {
  return quality?.[key] !== "none" && Number(quality?.[countKey] || 0) > 0;
}

export function autopilotPresentationVariant(index, quality = {}) {
  const presentation = PRESENTATIONS[Math.abs(Number(index) || 0) % PRESENTATIONS.length];
  const emojisAllowed = allowedDecoration(quality, "emojiPolicy", "maxEmojis");
  const hashtagsAllowed = allowedDecoration(quality, "hashtagsPolicy", "maxHashtags");
  const emojiMode = emojisAllowed && index % 3 !== 0 ? "one" : "none";
  const hashtagsMode = hashtagsAllowed && index % 5 === 4 ? "one_or_two" : "none";
  return {
    key: `${Math.abs(Number(index) || 0) % PRESENTATIONS.length}-${emojiMode}-${hashtagsMode}`,
    name: presentation[0],
    structure: presentation[1],
    hook: presentation[2],
    emojiMode,
    hashtagsMode,
  };
}

export function presentationVariantPrompt(variant) {
  return [
    "УНИКАЛЬНАЯ ПОДАЧА ЭТОГО ПОСТА:",
    `— форма: ${variant.name};`,
    `— структура: ${variant.structure};`,
    `— начни ${variant.hook};`,
    variant.emojiMode === "one"
      ? "— используй ровно один уместный эмодзи, не превращай текст в украшение;"
      : "— не используй эмодзи;",
    variant.hashtagsMode === "one_or_two"
      ? "— заверши одним или двумя предметными хэштегами;"
      : "— не добавляй хэштеги;",
    "— не копируй хук, порядок блоков и финальный вопрос из других постов плана.",
  ].join("\n");
}

function fallbackEmoji(quality, index) {
  const configured = String(quality?.allowedEmoji || "")
    .match(/\p{Extended_Pictographic}/gu);
  const pool = configured?.length ? configured : ["📌", "💡", "✅", "🔎", "🧭"];
  return pool[Math.abs(Number(index) || 0) % pool.length];
}

function hashtagsFromBrief(brief, quality, limit) {
  const branded = String(quality?.brandedHashtags || "").match(/#[\p{L}\p{N}_]+/gu) || [];
  const generated = tokens(`${brief?.niche || ""} ${brief?.audience || ""}`)
    .filter((token) => /^[\p{L}\p{N}_]+$/u.test(token))
    .map((token) => `#${token}`);
  return [...new Set([...branded, ...generated])].slice(0, limit);
}

export function applyAutopilotPresentation(draft, variant, quality = {}, brief = {}, index = 0) {
  let value = String(draft || "").trim();
  if (!value) return value;
  if (variant.emojiMode === "one" && !/\p{Extended_Pictographic}/u.test(value)) {
    value = `${fallbackEmoji(quality, index)} ${value}`;
  }
  if (variant.hashtagsMode === "one_or_two" && !/(^|\s)#[\p{L}\p{N}_]+/u.test(value)) {
    const limit = Math.max(0, Math.min(2, Number(quality?.maxHashtags || 0)));
    const hashtags = hashtagsFromBrief(brief, quality, limit);
    if (hashtags.length) value += `\n\n${hashtags.join(" ")}`;
  }
  return value;
}
