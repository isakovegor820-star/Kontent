// Единый контракт качества постов. Этот файл намеренно без зависимостей и TypeScript:
// его используют и Next.js, и отдельный node-worker. Правила существуют не только в
// промпте — validatePostQuality программно закрывает публикацию, если модель вышла за рамки.

const clean = (value, max = 500) => String(value ?? "").trim().slice(0, max);
const list = (value, limit, itemMax) =>
  Array.isArray(value)
    ? [...new Set(value.map((x) => clean(x, itemMax)).filter(Boolean))].slice(0, limit)
    : [];
const oneOf = (value, allowed, fallback) => (allowed.includes(value) ? value : fallback);
const clamp = (value, min, max, fallback) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export const QUALITY_PRESETS = {
  expert: {
    id: "expert",
    label: "Экспертный канал",
    description: "Спокойно, предметно и без рекламного шума.",
    quality: {
      version: 1,
      preset: "expert",
      tone: "Спокойный, уверенный, экспертно-разговорный",
      energy: "Сдержанная: без истерики, кликбейта и лишних восклицаний",
      persona: "Практикующий эксперт, который объясняет сложное понятным языком",
      address: "вы",
      humor: "light",
      profanity: "forbid",
      languageLevel: "Понятный литературный русский без канцелярита и нейросетевых клише",
      minChars: 900,
      maxChars: 1800,
      hookRequired: true,
      hookMaxChars: 80,
      maxParagraphSentences: 3,
      requireConclusion: true,
      listPolicy: "when_useful",
      boldPolicy: "restrained",
      directSpeech: "avoid",
      factsPolicy: "no_unverified_specifics",
      minCitationShare: 0.7,
      disclaimerRequired: false,
      disclaimerText: "",
      ctaStyle: "soft",
      ctaEveryPosts: 5,
      salesMaxPercent: 20,
      emojiPolicy: "restrained",
      maxEmojis: 3,
      hashtagsPolicy: "none",
      maxHashtags: 0,
      competitorTopics: false,
      forbiddenPhrases: [
        "в современном мире",
        "ни для кого не секрет",
        "давайте разберемся",
        "важно отметить",
        "уникальная возможность",
        "успейте прямо сейчас",
      ],
      forbiddenTopics: [],
      styleExamples: [],
      qualityThreshold: 85,
      retryLimit: 2,
    },
  },
  legal: {
    id: "legal",
    label: "Юридический эксперт",
    description: "Только подтверждённые факты, обязательный дисклеймер и строгий тон.",
    quality: {
      version: 1,
      preset: "legal",
      tone: "Спокойный, уверенный, экспертно-разговорный",
      energy: "Ровная и сдержанная: без давления, запугивания и громких обещаний",
      persona: "Опытный юрист-практик, который бережно и понятно объясняет читателю его ситуацию",
      address: "вы",
      humor: "none",
      profanity: "forbid",
      languageLevel: "Простой грамотный русский: юридические термины только с коротким объяснением",
      minChars: 1200,
      maxChars: 1800,
      hookRequired: true,
      hookMaxChars: 80,
      maxParagraphSentences: 3,
      requireConclusion: true,
      listPolicy: "when_useful",
      boldPolicy: "restrained",
      directSpeech: "avoid",
      factsPolicy: "source_required",
      minCitationShare: 0.75,
      disclaimerRequired: true,
      disclaimerText: "Материал носит информационный характер и не является юридической консультацией.",
      ctaStyle: "soft",
      ctaEveryPosts: 5,
      salesMaxPercent: 20,
      emojiPolicy: "restrained",
      maxEmojis: 2,
      hashtagsPolicy: "none",
      maxHashtags: 0,
      competitorTopics: false,
      forbiddenPhrases: [
        "спишем все долги",
        "гарантируем результат",
        "сто процентов",
        "без последствий",
        "легко и быстро",
        "последний шанс",
        "вам срочно нужно",
        "в современном мире",
        "ни для кого не секрет",
        "давайте разберемся",
        "важно отметить",
      ],
      forbiddenTopics: [],
      styleExamples: [],
      qualityThreshold: 85,
      retryLimit: 2,
    },
  },
};

export const DEFAULT_POST_QUALITY = Object.freeze({ ...QUALITY_PRESETS.expert.quality });

export function presetQuality(id) {
  const p = QUALITY_PRESETS[id] || QUALITY_PRESETS.expert;
  return normalizePostQuality(p.quality);
}

export function normalizePostQuality(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const base = QUALITY_PRESETS[source.preset]?.quality || DEFAULT_POST_QUALITY;
  let minChars = clamp(source.minChars, 300, 3500, base.minChars);
  let maxChars = clamp(source.maxChars, 500, 4000, base.maxChars);
  if (maxChars < minChars) [minChars, maxChars] = [maxChars, minChars];
  const emojiPolicy = oneOf(source.emojiPolicy, ["none", "restrained", "active"], base.emojiPolicy);
  const hashtagsPolicy = oneOf(source.hashtagsPolicy, ["none", "restrained"], base.hashtagsPolicy);

  return {
    version: 1,
    preset: oneOf(source.preset, ["expert", "legal", "custom"], base.preset),
    tone: clean(source.tone || base.tone, 240),
    energy: clean(source.energy || base.energy, 240),
    persona: clean(source.persona || base.persona, 300),
    address: oneOf(source.address, ["ты", "вы", "neutral"], base.address),
    humor: oneOf(source.humor, ["none", "light", "free"], base.humor),
    profanity: oneOf(source.profanity, ["forbid", "allow"], base.profanity),
    languageLevel: clean(source.languageLevel || base.languageLevel, 300),
    minChars,
    maxChars,
    hookRequired: source.hookRequired !== false,
    hookMaxChars: clamp(source.hookMaxChars, 30, 160, base.hookMaxChars),
    maxParagraphSentences: clamp(source.maxParagraphSentences, 1, 6, base.maxParagraphSentences),
    requireConclusion: source.requireConclusion !== false,
    listPolicy: oneOf(source.listPolicy, ["when_useful", "required", "avoid"], base.listPolicy),
    boldPolicy: oneOf(source.boldPolicy, ["none", "restrained", "required"], base.boldPolicy),
    directSpeech: oneOf(source.directSpeech, ["avoid", "allowed"], base.directSpeech),
    factsPolicy: oneOf(
      source.factsPolicy,
      ["source_required", "no_unverified_specifics", "open"],
      base.factsPolicy,
    ),
    minCitationShare: Math.max(0, Math.min(1, Number(source.minCitationShare ?? base.minCitationShare))),
    disclaimerRequired: source.disclaimerRequired === true,
    disclaimerText: clean(source.disclaimerText || base.disclaimerText, 500),
    ctaStyle: oneOf(source.ctaStyle, ["none", "soft", "direct"], base.ctaStyle),
    ctaEveryPosts: clamp(source.ctaEveryPosts, 1, 20, base.ctaEveryPosts),
    salesMaxPercent: clamp(source.salesMaxPercent, 0, 100, base.salesMaxPercent),
    emojiPolicy,
    maxEmojis: emojiPolicy === "none" ? 0 : clamp(source.maxEmojis, 0, 20, base.maxEmojis),
    hashtagsPolicy,
    maxHashtags: hashtagsPolicy === "none" ? 0 : clamp(source.maxHashtags, 0, 10, base.maxHashtags),
    competitorTopics: source.competitorTopics === true,
    forbiddenPhrases: list(source.forbiddenPhrases ?? base.forbiddenPhrases, 40, 100),
    forbiddenTopics: list(source.forbiddenTopics ?? base.forbiddenTopics, 30, 120),
    styleExamples: list(source.styleExamples ?? base.styleExamples, 5, 2500),
    qualityThreshold: clamp(source.qualityThreshold, 70, 100, base.qualityThreshold),
    retryLimit: clamp(source.retryLimit, 0, 3, base.retryLimit),
  };
}

const labels = {
  ты: "строго на «ты»",
  вы: "строго на «вы»",
  neutral: "без прямого обращения к читателю",
};

export function buildQualityPrompt(rawQuality, options = {}) {
  const q = normalizePostQuality(rawQuality);
  const ctaDue = q.ctaStyle !== "none" && Number(options.postIndex) % q.ctaEveryPosts === q.ctaEveryPosts - 1;
  const lines = [
    "РЕДАКЦИОННЫЙ СТАНДАРТ КАНАЛА — не нарушай ни одного пункта:",
    `— голос: ${q.persona};`,
    `— тон: ${q.tone};`,
    `— энергия: ${q.energy};`,
    `— обращение: ${labels[q.address]};`,
    `— язык: ${q.languageLevel};`,
    `— объём готового текста: ${q.minChars}–${q.maxChars} знаков с пробелами;`,
    q.hookRequired
      ? `— первая строка — содержательный хук до ${q.hookMaxChars} знаков, без кликбейта;`
      : "— отдельный хук не обязателен;",
    `— абзацы по 1–${q.maxParagraphSentences} предложения, между ними пустая строка;`,
    q.requireConclusion ? "— в конце отдельный содержательный вывод;" : "— отдельный вывод необязателен;",
    q.listPolicy === "required"
      ? "— обязательно используй короткий список;"
      : q.listPolicy === "avoid"
        ? "— не используй списки;"
        : "— список используй только когда он действительно упрощает чтение;",
    q.boldPolicy === "required"
      ? "— выдели **жирным** одну ключевую мысль;"
      : q.boldPolicy === "none"
        ? "— не используй жирное выделение;"
        : "— не более двух коротких выделений **жирным**;",
    q.humor === "none" ? "— без юмора, иронии и сарказма;" : "— юмор только уместный и доброжелательный;",
    q.profanity === "forbid" ? "— мат, грубость и унижение запрещены;" : "— грубость в адрес читателя запрещена;",
    q.directSpeech === "avoid" ? "— не выдумывай диалоги и цитаты людей;" : "— прямую речь используй только при необходимости;",
    `— не больше ${q.maxEmojis} эмодзи; не больше ${q.maxHashtags} хэштегов;`,
    `— продажи — максимум ${q.salesMaxPercent}% текста, остальное практическая польза;`,
    ctaDue
      ? `— сегодня нужен ${q.ctaStyle === "soft" ? "мягкий" : "прямой"} призыв к действию без давления;`
      : "— в этом посте не добавляй продажный призыв: читатель должен получить чистую пользу;",
  ];
  if (q.factsPolicy === "source_required")
    lines.push("— каждое фактическое утверждение бери только из приложенных источников; без источника пост не создавай;");
  else if (q.factsPolicy === "no_unverified_specifics")
    lines.push("— не добавляй неподтверждённые цифры, даты, имена, кейсы, законы и обещания результата;");
  if (q.disclaimerRequired && q.disclaimerText)
    lines.push(`— последней строкой дословно поставь дисклеймер: «${q.disclaimerText}»;`);
  if (q.forbiddenPhrases.length) lines.push(`— запрещённые формулировки: ${q.forbiddenPhrases.join("; ")};`);
  if (q.forbiddenTopics.length) lines.push(`— запрещённые темы: ${q.forbiddenTopics.join("; ")};`);
  lines.push("— никаких заголовков-разметок «Хук:», «Основная часть:», «Вывод:», «CTA:».");
  return lines.join("\n");
}

// JS \b понимает только ASCII-слова и молча пропускает русские границы, поэтому здесь
// явные Unicode-буквы: «ты» ловится, а часть слова «событие» — нет.
const profanity =
  /(?:^|[^\p{L}])(?:хуй|хуе\p{L}*|пизд\p{L}*|еба\p{L}*|ебл\p{L}*|бля(?:д\p{L}*)?|мудак\p{L}*|долбоеб\p{L}*)(?!\p{L})/iu;
const informal =
  /(?:^|[^\p{L}])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|твоего|твоей|твою|твоим|твоих)(?!\p{L})/iu;
const emoji = /\p{Extended_Pictographic}/gu;
const hashtag = /(^|\s)#[\p{L}\p{N}_]+/gu;

function sentenceCount(text) {
  return (text.match(/[.!?…]+(?:[»”"')\]]|$)/g) || []).length || (text.trim() ? 1 : 0);
}

function addViolation(out, code, message, blocker, penalty) {
  out.push({ code, message, blocker, penalty });
}

export function validatePostQuality(text, rawQuality, context = {}) {
  const q = normalizePostQuality(rawQuality);
  const value = clean(text, 10_000);
  const violations = [];
  const chars = value.length;
  const lines = value.split("\n").map((x) => x.trim()).filter(Boolean);
  const paragraphs = value.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);

  if (!value) addViolation(violations, "empty", "Модель не вернула текст", true, 100);
  if (chars < q.minChars)
    addViolation(violations, "too_short", `Нужно минимум ${q.minChars} знаков, сейчас ${chars}`, true, 25);
  if (chars > q.maxChars)
    addViolation(violations, "too_long", `Нужно максимум ${q.maxChars} знаков, сейчас ${chars}`, true, 25);
  if (q.hookRequired && (!lines[0] || lines[0].length > q.hookMaxChars))
    addViolation(violations, "hook", `Первая строка должна быть хуком до ${q.hookMaxChars} знаков`, true, 15);
  if (q.address === "вы" && informal.test(value))
    addViolation(violations, "address", "Есть обращение на «ты», хотя канал говорит только на «вы»", true, 25);
  if (q.profanity === "forbid" && profanity.test(value))
    addViolation(violations, "profanity", "Обнаружена запрещённая грубая лексика", true, 40);

  for (const phrase of q.forbiddenPhrases) {
    if (value.toLocaleLowerCase("ru").includes(phrase.toLocaleLowerCase("ru")))
      addViolation(violations, "forbidden_phrase", `Запрещённая формулировка: «${phrase}»`, true, 20);
  }
  for (const topic of q.forbiddenTopics) {
    if (`${context.topic || ""} ${value}`.toLocaleLowerCase("ru").includes(topic.toLocaleLowerCase("ru")))
      addViolation(violations, "forbidden_topic", `Пост затрагивает стоп-тему: «${topic}»`, true, 30);
  }

  const tooDense = paragraphs.find((p) => !/^(?:[-—•]|\d+[.)])\s/m.test(p) && sentenceCount(p) > q.maxParagraphSentences);
  if (tooDense)
    addViolation(
      violations,
      "dense_paragraph",
      `В абзаце больше ${q.maxParagraphSentences} предложений — текст выглядит простынёй`,
      true,
      15,
    );
  if (q.requireConclusion && paragraphs.length < 3)
    addViolation(violations, "structure", "Нужны отдельные хук, основная часть и вывод", true, 15);
  if (q.listPolicy === "required" && !/(^|\n)\s*(?:[-—•]|\d+[.)])\s+/m.test(value))
    addViolation(violations, "list", "По настройкам в посте обязателен список", true, 10);
  if (q.listPolicy === "avoid" && /(^|\n)\s*(?:[-—•]|\d+[.)])\s+/m.test(value))
    addViolation(violations, "list", "По настройкам списки запрещены", true, 10);
  if (q.boldPolicy === "required" && !/\*\*[^*]+\*\*/.test(value))
    addViolation(violations, "bold", "Не выделена ключевая мысль", false, 7);
  if (q.boldPolicy === "none" && /\*\*[^*]+\*\*/.test(value))
    addViolation(violations, "bold", "Жирное выделение запрещено", false, 7);

  const emojiCount = (value.match(emoji) || []).length;
  const hashtagCount = (value.match(hashtag) || []).length;
  if (emojiCount > q.maxEmojis)
    addViolation(violations, "emoji", `Эмодзи ${emojiCount}, разрешено максимум ${q.maxEmojis}`, true, 10);
  if (hashtagCount > q.maxHashtags)
    addViolation(violations, "hashtags", `Хэштегов ${hashtagCount}, разрешено максимум ${q.maxHashtags}`, true, 10);
  if (q.disclaimerRequired && q.disclaimerText && !value.includes(q.disclaimerText))
    addViolation(violations, "disclaimer", "Нет обязательного дисклеймера", true, 30);
  if (/\b(?:хук|основная часть|вывод|cta|призыв к действию)\s*:/iu.test(value))
    addViolation(violations, "meta_labels", "В текст попали служебные метки промпта", true, 15);
  if (/[!?]{3,}|\.{4,}/.test(value))
    addViolation(violations, "punctuation", "Слишком много повторяющихся знаков препинания", false, 8);
  if (value && !/[.!?…»”*)\]]$/.test(value))
    addViolation(violations, "truncated", "Текст выглядит оборванным", true, 25);

  const supportCount = Number(context.supportCount || 0);
  const cited = context.citedShare == null ? null : Number(context.citedShare);
  if (q.factsPolicy === "source_required" && supportCount === 0)
    addViolation(violations, "no_sources", "Для этого канала пост без проверенного источника запрещён", true, 50);
  if (q.factsPolicy === "source_required" && supportCount > 0 && (cited == null || cited < q.minCitationShare))
    addViolation(
      violations,
      "weak_sources",
      `Недостаточно утверждений привязано к источникам: нужно ${Math.round(q.minCitationShare * 100)}%`,
      true,
      35,
    );
  if (Array.isArray(context.invented) && context.invented.length)
    addViolation(violations, "invented", `Неподтверждённая конкретика: ${context.invented.join(", ")}`, true, 50);

  const score = Math.max(0, 100 - violations.reduce((sum, x) => sum + x.penalty, 0));
  const blockers = violations.filter((x) => x.blocker);
  return {
    score,
    threshold: q.qualityThreshold,
    passed: blockers.length === 0 && score >= q.qualityThreshold,
    blockers: blockers.map((x) => x.message),
    violations,
    metrics: { chars, emojiCount, hashtagCount, supportCount, citedShare: cited },
  };
}

export function buildRewritePrompt(draft, result) {
  const problems = result?.violations?.length
    ? result.violations.map((x) => `— ${x.message}`).join("\n")
    : "— Проведи строгую редактуру: убери воду, повторы, канцелярит и неестественные фразы.";
  return [
    "Перепиши черновик целиком. Исправь каждое замечание и сохрани только подтверждённый смысл.",
    "Верни ТОЛЬКО готовый пост, без объяснений и разбора.",
    "Не убирай служебные ссылки [1], [2]: после КАЖДОГО предложения с фактом должна стоять ссылка на источник.",
    "Если текста мало, добавляй только полезное объяснение уже данных фактов — не новые цифры, случаи или обещания.",
    "",
    "Замечания редактора:",
    problems,
    "",
    "Черновик:",
    draft,
  ].join("\n");
}

/** Короткая детерминированная проверка темы до того, как по ней написан целый пост. */
export function validateTopicQuality(topic, sourceText = "") {
  const value = clean(topic, 300).replace(/[.!?…]+$/, "");
  const words = value.split(/\s+/).filter(Boolean);
  const violations = [];
  if (value.length < 12 || value.length > 90)
    violations.push("Тема должна занимать 12–90 знаков");
  if (words.length < 3 || words.length > 10)
    violations.push("Тема должна содержать 3–10 слов");
  if (/(?:^|\s)(?:и|или|а|но|в|на|с|со|по|для|при|через|согласно|из|от)$/iu.test(value))
    violations.push("Тема обрывается на служебном слове");
  if (/(?:^|[^\p{L}])(?:новый способ|новые правила|успешн\p{L}*|сенсац\p{L}*|шок\p{L}*|последний шанс)(?!\p{L})/iu.test(value))
    violations.push("В теме есть кликбейт или неподтверждённая оценка");
  if (/без участия в конкурсе|стопроцент|гарантир/iu.test(value))
    violations.push("Тема искажает смысл или обещает результат");

  const source = String(sourceText || "").toLocaleLowerCase("ru");
  const meaningful = words
    .map((w) => w.toLocaleLowerCase("ru").replace(/[^\p{L}\p{N}]/gu, ""))
    .filter((w) => w.length >= 5);
  if (source && meaningful.length && !meaningful.some((w) => source.includes(w.slice(0, 5))))
    violations.push("Тема не связана с исходным фактом");
  return { passed: violations.length === 0, value, violations };
}

/**
 * Безопасный заголовок из факта. Частые юридические конструкции превращаем в полезный
 * вопрос без вызова модели; на неизвестной нише оставляем нейтральный «практический
 * разбор», а не разрешаем слабой модели изобрести событие или громкое обещание.
 */
export function fallbackTopicFromSeed(seedText) {
  const text = clean(seedText, 2000).replace(/\s+/g, " ");
  const question = text.match(/Вопрос клиента:\s*([^?]{8,80}\?)/iu)?.[1];
  if (question) return question.charAt(0).toUpperCase() + question.slice(1).replace(/[?]+$/, "");
  if (/реализац\p{L}* имущества[\s\S]*шест/iu.test(text))
    return "Сколько длится реализация имущества при банкротстве";
  if (/единственн\p{L}*[^.]{0,80}жиль[\s\S]*ипотек/iu.test(text))
    return "Когда единственное жильё могут продать при банкротстве";
  if (/внесудебн\p{L}* банкротств[\s\S]*МФЦ/iu.test(text))
    return "Кому доступно внесудебное банкротство через МФЦ";
  if (/клиент[^.]{0,120}долг[\s\S]*квартир/iu.test(text))
    return "Как списали долг и сохранили единственную квартиру";

  const first = text.split(/[.!?]/)[0].replace(/^.{0,30}:\s*/, "").trim();
  const words = first.split(/\s+/).filter(Boolean).slice(0, 7).join(" ").replace(/[,:;—-]+$/, "");
  return `Практический разбор: ${words}`.slice(0, 90);
}
