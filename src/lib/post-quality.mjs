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

export const POST_QUALITY_RULES = Object.freeze({
  id: "aurora-post-quality",
  version: 1,
});

const QUALITY_CHECK_TRIGGERS = new Set(["direct", "generation", "rewrite", "edit_recheck"]);

function isoTimestamp(value) {
  const parsed = value == null ? Date.now() : new Date(value).getTime();
  return new Date(Number.isFinite(parsed) ? parsed : Date.now()).toISOString();
}

function isCanonicalIsoTimestamp(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

export function hasVerifiedQualityMetadata(result) {
  const metadata = result?.metadata;
  const rules = metadata?.rules;
  const provenance = metadata?.provenance;
  return Boolean(
    isCanonicalIsoTimestamp(metadata?.checkedAt) &&
      rules?.id === POST_QUALITY_RULES.id &&
      rules?.version === POST_QUALITY_RULES.version &&
      rules?.profileVersion === 1 &&
      provenance?.kind === "deterministic" &&
      provenance?.validator === "validatePostQuality" &&
      QUALITY_CHECK_TRIGGERS.has(provenance?.trigger),
  );
}

/** A legacy `qualityOrigin` string is not an attestation. Require explicit actor + time. */
export function hasHumanQualityAttestation(result) {
  if (!hasVerifiedQualityMetadata(result)) return false;
  const attestation = result.metadata.provenance.humanAttestation;
  return Boolean(
    attestation?.kind === "human_review" &&
      Number.isInteger(attestation?.userId) &&
      attestation.userId > 0 &&
      isCanonicalIsoTimestamp(attestation?.attestedAt),
  );
}

/** Persist that a specific person accepted a review-only Autopilot draft. */
export function withHumanQualityAttestation(result, { userId, attestedAt } = {}) {
  if (!hasVerifiedQualityMetadata(result)) return result;
  const id = Math.round(Number(userId));
  if (!Number.isInteger(id) || id <= 0) return result;
  return {
    ...result,
    metadata: {
      ...result.metadata,
      provenance: {
        ...result.metadata.provenance,
        humanAttestation: {
          kind: "human_review",
          userId: id,
          attestedAt: isoTimestamp(attestedAt),
        },
      },
    },
  };
}

/** Automatic publication needs claim-level semantic proof, not only citation syntax. */
export function hasAutomaticQualityApproval(result) {
  if (!hasVerifiedQualityMetadata(result) || result?.passed !== true) return false;
  const semantic = result?.semantic;
  return Boolean(
    semantic?.version === 1 &&
      semantic?.status === "passed" &&
      semantic?.passed === true &&
      semantic?.requiresReview === false &&
      Array.isArray(semantic?.claimVerdicts) &&
      semantic.claimVerdicts.length > 0 &&
      semantic.claimVerdicts.every(
        (verdict) => {
          if (verdict?.verdict === "non_factual") {
            return Array.isArray(verdict?.sourceSpans) && verdict.sourceSpans.length === 0;
          }
          return verdict?.verdict === "supported" &&
            Array.isArray(verdict?.sourceSpans) &&
            verdict.sourceSpans.length > 0 &&
            verdict.sourceSpans.every(
              (span) =>
                typeof span?.sourceId === "string" && span.sourceId.length > 0 &&
                Number.isInteger(span?.start) && Number.isInteger(span?.end) && span.end > span.start,
            );
        },
      ) &&
      semantic?.provenance?.validatorVersion === "semantic-publication-v1" &&
      isCanonicalIsoTimestamp(semantic?.provenance?.checkedAt) &&
      semantic?.provenance?.terminalVerdict === "passed" &&
      typeof semantic?.provenance?.provider === "string" &&
      semantic.provenance.provider !== "unavailable",
  );
}

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
      energyLevel: 42,
      warmth: 62,
      inspiration: 45,
      provocation: 24,
      formality: 58,
      expertise: 78,
      authorVoice: 1,
      persona: "Практикующий эксперт, который объясняет сложное понятным языком",
      address: "вы",
      humor: "light",
      humorLevel: 20,
      opinionSharpness: 34,
      profanity: "forbid",
      profanityLevel: 0,
      languageLevel: "Понятный литературный русский без канцелярита и нейросетевых клише",
      languageComplexity: 52,
      originality: 78,
      minChars: 900,
      maxChars: 1800,
      hookRequired: true,
      hookMaxChars: 80,
      maxParagraphSentences: 3,
      sentenceRhythm: 48,
      requireConclusion: true,
      listPolicy: "when_useful",
      listIntensity: 42,
      boldPolicy: "restrained",
      boldIntensity: 25,
      formatStyle: 2,
      directSpeech: "avoid",
      hookStyle: 3,
      hookIntensity: 58,
      quoteIntensity: 12,
      sceneIntensity: 22,
      readerDialogue: 42,
      factsPolicy: "no_unverified_specifics",
      factShare: 68,
      minCitationShare: 0.7,
      personalStoryShare: 32,
      trendFocus: 48,
      audienceExpertise: 42,
      postGoal: 3,
      disclaimerRequired: false,
      disclaimerText: "",
      ctaStyle: "soft",
      ctaIntensity: 30,
      ctaEveryPosts: 5,
      interactivity: 38,
      salesMaxPercent: 20,
      emojiPolicy: "restrained",
      maxEmojis: 3,
      hashtagsPolicy: "none",
      maxHashtags: 0,
      allowedEmoji: "",
      brandedHashtags: "",
      sourceLinkIntensity: 55,
      mentionIntensity: 10,
      visualIntensity: 45,
      visualDetail: 58,
      linkRules: "",
      visualDirection: "",
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
      energyLevel: 34,
      warmth: 70,
      inspiration: 45,
      provocation: 18,
      formality: 68,
      expertise: 90,
      authorVoice: 1,
      persona: "Опытный юрист-практик, который бережно и понятно объясняет читателю его ситуацию",
      address: "вы",
      humor: "none",
      humorLevel: 8,
      opinionSharpness: 38,
      profanity: "forbid",
      profanityLevel: 0,
      languageLevel: "Простой грамотный русский: юридические термины только с коротким объяснением",
      languageComplexity: 48,
      originality: 82,
      minChars: 1200,
      maxChars: 1800,
      hookRequired: true,
      hookMaxChars: 80,
      maxParagraphSentences: 3,
      sentenceRhythm: 44,
      requireConclusion: true,
      listPolicy: "when_useful",
      listIntensity: 50,
      boldPolicy: "restrained",
      boldIntensity: 24,
      formatStyle: 2,
      directSpeech: "avoid",
      hookStyle: 1,
      hookIntensity: 55,
      quoteIntensity: 22,
      sceneIntensity: 24,
      readerDialogue: 40,
      factsPolicy: "source_required",
      factShare: 84,
      minCitationShare: 0.75,
      personalStoryShare: 34,
      trendFocus: 55,
      audienceExpertise: 28,
      postGoal: 3,
      disclaimerRequired: true,
      disclaimerText: "Материал носит информационный характер и не является юридической консультацией.",
      ctaStyle: "soft",
      ctaIntensity: 24,
      ctaEveryPosts: 5,
      interactivity: 34,
      salesMaxPercent: 20,
      emojiPolicy: "restrained",
      maxEmojis: 2,
      hashtagsPolicy: "none",
      maxHashtags: 0,
      allowedEmoji: "✅ ❌ ⚖️ 📌",
      brandedHashtags: "",
      sourceLinkIntensity: 90,
      mentionIntensity: 5,
      visualIntensity: 52,
      visualDetail: 70,
      linkRules: "Ссылки только на первоисточники и официальные реестры",
      visualDirection: "Лаконичная юридическая инфографика, тёмный фон и один акцентный цвет",
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
  const humorLevel = clamp(
    source.humorLevel,
    0,
    100,
    source.humor === "none" ? 0 : source.humor === "free" ? 75 : base.humorLevel,
  );
  const profanityLevel = clamp(
    source.profanityLevel,
    0,
    100,
    source.profanity === "allow" ? 70 : base.profanityLevel,
  );

  return {
    version: 1,
    preset: oneOf(source.preset, ["expert", "legal", "custom"], base.preset),
    tone: clean(source.tone || base.tone, 240),
    energy: clean(source.energy || base.energy, 240),
    energyLevel: clamp(source.energyLevel, 0, 100, base.energyLevel),
    warmth: clamp(source.warmth, 0, 100, base.warmth),
    inspiration: clamp(source.inspiration, 0, 100, base.inspiration),
    provocation: clamp(source.provocation, 0, 100, base.provocation),
    formality: clamp(source.formality, 0, 100, base.formality),
    expertise: clamp(source.expertise, 0, 100, base.expertise),
    authorVoice: clamp(source.authorVoice, 0, 2, base.authorVoice),
    persona: clean(source.persona || base.persona, 300),
    address: oneOf(source.address, ["ты", "вы", "neutral"], base.address),
    humor: humorLevel <= 5 ? "none" : humorLevel < 60 ? "light" : "free",
    humorLevel,
    opinionSharpness: clamp(source.opinionSharpness, 0, 100, base.opinionSharpness),
    profanity: profanityLevel === 0 ? "forbid" : "allow",
    profanityLevel,
    languageLevel: clean(source.languageLevel || base.languageLevel, 300),
    languageComplexity: clamp(source.languageComplexity, 0, 100, base.languageComplexity),
    originality: clamp(source.originality, 0, 100, base.originality),
    minChars,
    maxChars,
    hookRequired: source.hookRequired !== false,
    hookMaxChars: clamp(source.hookMaxChars, 30, 160, base.hookMaxChars),
    maxParagraphSentences: clamp(source.maxParagraphSentences, 1, 6, base.maxParagraphSentences),
    sentenceRhythm: clamp(source.sentenceRhythm, 0, 100, base.sentenceRhythm),
    requireConclusion: source.requireConclusion !== false,
    listPolicy: oneOf(source.listPolicy, ["when_useful", "required", "avoid"], base.listPolicy),
    listIntensity: clamp(source.listIntensity, 0, 100, base.listIntensity),
    boldPolicy: oneOf(source.boldPolicy, ["none", "restrained", "required"], base.boldPolicy),
    boldIntensity: clamp(source.boldIntensity, 0, 100, base.boldIntensity),
    formatStyle: clamp(source.formatStyle, 0, 5, base.formatStyle),
    directSpeech: oneOf(source.directSpeech, ["avoid", "allowed"], base.directSpeech),
    hookStyle: clamp(source.hookStyle, 0, 4, base.hookStyle),
    hookIntensity: clamp(source.hookIntensity, 0, 100, base.hookIntensity),
    quoteIntensity: clamp(source.quoteIntensity, 0, 100, base.quoteIntensity),
    sceneIntensity: clamp(source.sceneIntensity, 0, 100, base.sceneIntensity),
    readerDialogue: clamp(source.readerDialogue, 0, 100, base.readerDialogue),
    factsPolicy: oneOf(
      source.factsPolicy,
      ["source_required", "no_unverified_specifics", "open"],
      base.factsPolicy,
    ),
    factShare: clamp(source.factShare, 0, 100, base.factShare),
    minCitationShare: Math.max(0, Math.min(1, Number(source.minCitationShare ?? base.minCitationShare))),
    personalStoryShare: clamp(source.personalStoryShare, 0, 100, base.personalStoryShare),
    trendFocus: clamp(source.trendFocus, 0, 100, base.trendFocus),
    audienceExpertise: clamp(source.audienceExpertise, 0, 100, base.audienceExpertise),
    postGoal: clamp(source.postGoal, 0, 4, base.postGoal),
    disclaimerRequired: source.disclaimerRequired === true,
    disclaimerText: clean(source.disclaimerText || base.disclaimerText, 500),
    ctaStyle: oneOf(source.ctaStyle, ["none", "soft", "direct"], base.ctaStyle),
    ctaIntensity: clamp(source.ctaIntensity, 0, 100, base.ctaIntensity),
    ctaEveryPosts: clamp(source.ctaEveryPosts, 1, 20, base.ctaEveryPosts),
    interactivity: clamp(source.interactivity, 0, 100, base.interactivity),
    salesMaxPercent: clamp(source.salesMaxPercent, 0, 100, base.salesMaxPercent),
    emojiPolicy,
    maxEmojis: emojiPolicy === "none" ? 0 : clamp(source.maxEmojis, 0, 20, base.maxEmojis),
    hashtagsPolicy,
    maxHashtags: hashtagsPolicy === "none" ? 0 : clamp(source.maxHashtags, 0, 10, base.maxHashtags),
    allowedEmoji: clean(source.allowedEmoji == null ? base.allowedEmoji : source.allowedEmoji, 120),
    brandedHashtags: clean(source.brandedHashtags == null ? base.brandedHashtags : source.brandedHashtags, 240),
    sourceLinkIntensity: clamp(source.sourceLinkIntensity, 0, 100, base.sourceLinkIntensity),
    mentionIntensity: clamp(source.mentionIntensity, 0, 100, base.mentionIntensity),
    visualIntensity: clamp(source.visualIntensity, 0, 100, base.visualIntensity),
    visualDetail: clamp(source.visualDetail, 0, 100, base.visualDetail),
    linkRules: clean(source.linkRules == null ? base.linkRules : source.linkRules, 500),
    visualDirection: clean(source.visualDirection == null ? base.visualDirection : source.visualDirection, 500),
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

const AUTHOR_VOICES = ["безличная подача", "голос от лица «мы»", "голос от первого лица «я»"];
const FORMAT_STYLES = ["сторителлинг", "список или чек-лист", "разбор кейса", "вопрос — ответ", "новость", "авторское мнение"];
const HOOK_STYLES = ["провокационный вопрос", "проверяемый факт", "конкретная цифра", "интрига", "короткая цитата"];
const POST_GOALS = ["максимальный охват", "прогрев и доверие", "продажа", "репутация эксперта", "удержание аудитории"];

function scaleWord(value, low, medium, high) {
  return value < 34 ? low : value < 67 ? medium : high;
}

function profanityInstruction(value) {
  if (value === 0) return "мат и грубая лексика полностью запрещены";
  if (value < 34) return "допустимы только лёгкие просторечия без мата";
  if (value < 67) return "редкий мат допустим только со звёздочками и без оскорблений";
  if (value < 100) return "прямой мат допустим как часть голоса бренда без обязательной цензуры";
  return "обязательно используй минимум одно прямое матерное выражение без цензуры; верхнего количественного лимита нет. Свяжи мат с конкретным риском, ошибкой, абсурдом, пользой или эмоцией автора так, чтобы из предложения было понятно, что именно и почему так оценивается; не добавляй дежурную фразу ради галочки, не искажай юридические факты и не заменяй слова звёздочками или эвфемизмами";
}

export function buildQualityPrompt(rawQuality, options = {}) {
  const q = normalizePostQuality(rawQuality);
  const ctaDue = q.ctaStyle !== "none" && Number(options.postIndex) % q.ctaEveryPosts === q.ctaEveryPosts - 1;
  const lines = [
    "РЕДАКЦИОННЫЙ СТАНДАРТ КАНАЛА — не нарушай ни одного пункта:",
    `— голос: ${q.persona};`,
    `— позиция автора: ${AUTHOR_VOICES[q.authorVoice]};`,
    `— тон: ${q.tone};`,
    `— эмоциональный профиль: энергия ${q.energyLevel}/100 (${scaleWord(q.energyLevel, "спокойная", "ровная", "высокая")}), теплота ${q.warmth}/100, вдохновение ${q.inspiration}/100, провокационность ${q.provocation}/100;`,
    `— манера: деловитость ${q.formality}/100, экспертность ${q.expertise}/100, острота позиции ${q.opinionSharpness}/100;`,
    `— обращение: ${labels[q.address]};`,
    `— язык: ${q.languageLevel};`,
    `— сложность языка ${q.languageComplexity}/100, оригинальность и анти-клише ${q.originality}/100;`,
    `— объём готового текста: ${q.minChars}–${q.maxChars} знаков с пробелами;`,
    q.hookRequired
      ? `— первая строка — хук в формате «${HOOK_STYLES[q.hookStyle]}», интенсивность ${q.hookIntensity}/100, до ${q.hookMaxChars} знаков и без кликбейта;`
      : "— отдельный хук не обязателен;",
    `— основной формат: ${FORMAT_STYLES[q.formatStyle]}; если рубрика недели требует другую форму, сохрани её смысл;`,
    `— абзацы по 1–${q.maxParagraphSentences} предложения, между ними пустая строка; ритм фраз ${q.sentenceRhythm}/100 от короткого к развёрнутому;`,
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
    `— плотность списков ${q.listIntensity}/100, жирных выделений ${q.boldIntensity}/100;`,
    `— юмор и ирония ${q.humorLevel}/100 (${scaleWord(q.humorLevel, "сухо", "лёгкая ирония", "свободно, включая мемы и сленг")});`,
    `— ${profanityInstruction(q.profanityLevel)};`,
    q.directSpeech === "avoid"
      ? "— не выдумывай диалоги и цитаты людей;"
      : `— насыщенность прямой речью и цитатами ${q.quoteIntensity}/100; реальные цитаты — только с источником, художественные явно не выдавай за факты;`,
    `— мини-сценки ${q.sceneIntensity}/100, риторические вопросы и диалог с читателем ${q.readerDialogue}/100;`,
    `— смысловой баланс: факты ${q.factShare}%, личные истории ${q.personalStoryShare}%, актуальность и тренды ${q.trendFocus}/100;`,
    `— уровень читателя ${q.audienceExpertise}/100 от новичка к профессионалу; цель поста — ${POST_GOALS[q.postGoal]};`,
    `— не больше ${q.maxEmojis} эмодзи; не больше ${q.maxHashtags} хэштегов;`,
    `— продажи — максимум ${q.salesMaxPercent}% текста, остальное практическая польза;`,
    `— интенсивность CTA ${q.ctaIntensity}/100, вовлечение и интерактив ${q.interactivity}/100;`,
    `— ссылки на источники ${q.sourceLinkIntensity}/100, @упоминания ${q.mentionIntensity}/100;`,
    `— визуальное сопровождение нужно с частотой ${q.visualIntensity}/100 и детализацией задания ${q.visualDetail}/100;`,
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
  if (q.allowedEmoji) lines.push(`— допустимый набор эмодзи: ${q.allowedEmoji};`);
  if (q.brandedHashtags) lines.push(`— фирменные хэштеги: ${q.brandedHashtags};`);
  if (q.linkRules) lines.push(`— правила ссылок и упоминаний: ${q.linkRules};`);
  if (q.visualDirection) lines.push(`— стиль визуального сопровождения: ${q.visualDirection};`);
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
  if (q.profanityLevel === 100 && !profanity.test(value))
    addViolation(
      violations,
      "profanity_required",
      "Добавь прямое матерное выражение без звёздочек в содержательное предложение: должно быть понятно, что именно и почему так оценивается. Не добавляй отдельную фразу ради проверки",
      true,
      40,
    );

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
    metadata: {
      checkedAt: isoTimestamp(context.checkedAt),
      rules: {
        id: POST_QUALITY_RULES.id,
        version: POST_QUALITY_RULES.version,
        profileVersion: q.version,
      },
      provenance: {
        kind: "deterministic",
        validator: "validatePostQuality",
        trigger: QUALITY_CHECK_TRIGGERS.has(context.trigger) ? context.trigger : "direct",
        humanAttestation: null,
      },
    },
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
    "Каждое замечание про неподтверждённое утверждение означает: удали эту мысль целиком. Не перефразируй её и не заменяй новым советом.",
    "Не добавляй определения, причинно-следственные выводы, обещания результата, обобщения, оценку пользы или риска, если источник не говорит об этом прямо.",
    "Если после удаления замечаний текст короче требуемого объёма, добирай объём только прямым содержанием фактов из системного списка и нефактическим вопросом читателю.",
    "Не дополняй текст правдоподобными объяснениями, примерами, цифрами, случаями или обещаниями.",
    "Связки, заголовки и финальный вопрос должны быть нефактическими; факты можно сократить, но нельзя расширять их смысл.",
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

/** A second grounded angle when the week needs one more post than unique source chunks. */
export function fallbackTopicVariantFromSeed(seedText) {
  const base = fallbackTopicFromSeed(seedText)
    .replace(/^Практический разбор:\s*/u, "")
    .split(/\s+/u)
    .filter(Boolean)
    .slice(0, 6)
    .join(" ")
    .replace(/[.!?…,:;—-]+$/u, "");
  return `Разбор по фактам: ${base}`.slice(0, 90);
}
