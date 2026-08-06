import type { ServerDraft } from "./draft-types";

export type ReferenceAdaptationKind = "trend" | "idea" | "reference";

export type ReferenceAdaptationContext = {
  draftId: number;
  version: number;
  kind: ReferenceAdaptationKind;
  sourceLabel: string;
  /** Full, untrusted source. It is semantic/mechanical context, never factual evidence. */
  sourceText: string;
  /** Required semantic subject of the new post, stripped of obvious factual specifics. */
  topic: string;
  readerProblem?: string;
  semanticGoal?: string;
  mechanics?: {
    hook?: string;
    structure?: string;
    whyItWorked?: string;
  };
  mode: "same_topic_original_post";
};

export type TopicAlignmentResult = {
  status: "passed" | "failed";
  score: number;
  topic: string;
  anchorTokens: string[];
  matchedTokens: string[];
};

const TOPIC_STOP_WORDS = new Set([
  "аврора", "авторы", "будет", "были", "быть", "вашего", "выбранного", "данные",
  "для", "если", "есть", "или", "как", "который", "материал", "можно", "нового",
  "новый", "поста", "пост", "публикация", "свой", "создай", "создать", "тема", "этого",
  "этой", "это", "про", "при", "что", "чтобы", "читателя", "канала", "источник",
]);

function cleanText(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(/\u0000/gu, "").replace(/[ \t]+/gu, " ").trim().slice(0, max)
    : "";
}

/**
 * Removes obvious claims while retaining the subject vocabulary. This is deliberately
 * conservative: the result remains semantic intent and is never inserted into fact evidence.
 */
export function sanitizeSemanticIntent(value: unknown, max = 320): string {
  return cleanText(value, 2_000)
    .replace(/https?:\/\/\S+|www\.\S+/giu, " ")
    .replace(/[\w.+-]+@[\w.-]+\.[\p{L}]{2,}/giu, " ")
    .replace(/(?:^|\s)@[\p{L}\p{N}_-]+/gu, " ")
    .replace(/\b\d{1,2}[./-]\d{1,2}(?:[./-]\d{2,4})?\b/gu, " ")
    .replace(/\b(?:19|20)\d{2}\b/gu, " ")
    .replace(/\b\d+(?:[.,]\d+)?(?:\s?(?:%|₽|руб(?:\.|лей)?|доллар(?:ов|а)?|€|\$))?\b/giu, " ")
    // A capitalized first/last-name pair is a likely factual entity, not the topic.
    .replace(/(?<!\p{L})[А-ЯЁ][а-яё]{2,}\s+[А-ЯЁ][а-яё]{2,}(?!\p{L})/gu, " ")
    .replace(/[ \t]+/gu, " ")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .trim()
    .slice(0, max);
}

export function topicFromSourceText(value: unknown): string {
  const source = cleanText(value, 4_000);
  const candidates = source
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((part) => sanitizeSemanticIntent(part, 320))
    .filter((part) => part.match(/[\p{L}]{3,}/u))
    .slice(0, 8);
  const ranked = candidates.map((candidate, index) => {
    const terms = new Set(
      (candidate.match(/[\p{L}]{4,}/gu) ?? [])
        .map((word) => word.toLocaleLowerCase("ru").replace(/ё/gu, "е"))
        .filter((word) => !TOPIC_STOP_WORDS.has(word)),
    );
    const genericQuestion = /^(?:а\s+)?(?:вы|ты|кто|почему|зачем|когда|что)(?!\p{L})/iu.test(candidate);
    return { candidate, index, score: terms.size - (genericQuestion ? 2 : 0) };
  });
  ranked.sort((left, right) => right.score - left.score || left.index - right.index);
  return ranked[0]?.candidate || "Тема выбранного материала";
}

function adaptationKind(draft: ServerDraft): ReferenceAdaptationKind | null {
  if (draft.origin === "trend" || draft.source_ref?.kind === "trend") return "trend";
  if (draft.origin === "idea" || draft.source_ref?.kind === "idea") return "idea";
  if (
    draft.origin === "competitor"
    || draft.origin === "rss"
    || draft.source_ref?.kind === "competitor"
    || draft.source_ref?.kind === "reference"
    || draft.source_ref?.kind === "rss"
  ) return "reference";
  return null;
}

/** Builds the adaptation contract exclusively from authenticated server draft data. */
export function referenceAdaptationContextFromDraft(draft: ServerDraft): ReferenceAdaptationContext | null {
  const kind = adaptationKind(draft);
  const sourceText = cleanText(draft.text, 16_384);
  const sourceRef = draft.source_ref;
  if (!kind || !sourceText || !sourceRef) return null;

  const explicitTopic = sanitizeSemanticIntent(sourceRef.topic, 320);
  const topic = explicitTopic || topicFromSourceText(sourceText);
  const readerProblem = sanitizeSemanticIntent(sourceRef.readerProblem, 500) || undefined;
  const semanticGoal = sanitizeSemanticIntent(sourceRef.semanticGoal, 500) || undefined;
  const hook = cleanText(sourceRef.hook, 600) || undefined;
  const structure = cleanText(sourceRef.structure, 1_200) || undefined;
  const whyItWorked = cleanText(sourceRef.whyItWorked, 800) || undefined;

  return {
    draftId: draft.id,
    version: draft.version,
    kind,
    sourceLabel: cleanText(sourceRef.label, 400) || "Выбранный материал",
    sourceText,
    topic,
    ...(readerProblem ? { readerProblem } : {}),
    ...(semanticGoal ? { semanticGoal } : {}),
    ...(hook || structure || whyItWorked
      ? { mechanics: { ...(hook ? { hook } : {}), ...(structure ? { structure } : {}), ...(whyItWorked ? { whyItWorked } : {}) } }
      : {}),
    mode: "same_topic_original_post",
  };
}

export function buildReferenceAdaptationTask(
  context: ReferenceAdaptationContext,
  channelName = "выбранного канала",
): string {
  return [
    `Создай новый оригинальный пост для канала «${cleanText(channelName, 160) || "выбранного канала"}» строго по теме: «${context.topic}».`,
    context.readerProblem ? `Проблема читателя: ${context.readerProblem}.` : null,
    context.semanticGoal ? `Смысловая задача: ${context.semanticGoal}.` : null,
    "Сохрани предмет обсуждения и читательскую задачу выбранного материала. Не переключайся на другую тему из профиля, настроек или прошлого диалога.",
    "Не копируй формулировки и не переноси неподтверждённые цифры, даты, имена, ссылки, реквизиты, цены, обещания, кейсы или проверяемые выводы. Если конкретику нельзя подтвердить, обобщи её внутри той же темы.",
  ].filter(Boolean).join("\n\n");
}

function topicStem(word: string): string {
  const normalized = word.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  const stem = normalized.replace(
    /(?:иями|ями|ами|ого|ему|ому|ими|ыми|ая|яя|ое|ее|ие|ые|ий|ый|ой|ую|юю|ов|ев|ах|ях|ам|ям|ом|ем|а|я|ы|и|у|ю|е|о)$/u,
    "",
  );
  return stem.length >= 4 ? stem : normalized;
}

const TOPIC_CONCEPTS: Array<{ concept: string; stems: string[] }> = [
  { concept: "concept:enforcement", stems: ["исполнительск", "взыскан", "пристав", "исполнен"] },
  { concept: "concept:protection", stems: ["иммунитет", "защит", "неприкосновен", "изъят"] },
  { concept: "concept:housing", stems: ["жиль", "квартир", "дом"] },
  { concept: "concept:sole", stems: ["единственн", "един"] },
  { concept: "concept:contract", stems: ["договор", "контракт", "соглашен"] },
  { concept: "concept:supply", stems: ["поставк", "поставщ", "товар"] },
];

function topicConcept(stem: string): string {
  return TOPIC_CONCEPTS.find((group) => group.stems.some((alias) => (
    stem.startsWith(alias) || alias.startsWith(stem)
  )))?.concept ?? stem;
}

function alignmentTokens(value: string): string[] {
  const result: string[] = [];
  for (const word of value.match(/[\p{L}]{4,}/gu) ?? []) {
    const normalized = word.toLocaleLowerCase("ru").replace(/ё/gu, "е");
    if (TOPIC_STOP_WORDS.has(normalized)) continue;
    const stem = topicConcept(topicStem(normalized));
    if (!result.includes(stem)) result.push(stem);
  }
  return result.slice(0, 12);
}

/** Independent topical guard. It never reads or promotes factual claims from sourceText. */
export function validateTopicAlignment(
  text: string,
  context: ReferenceAdaptationContext,
): TopicAlignmentResult {
  const anchorTokens = alignmentTokens(context.topic);
  const outputTokens = new Set(alignmentTokens(text));
  const matchedTokens = anchorTokens.filter((anchor) => (
    outputTokens.has(anchor)
    || [...outputTokens].some((candidate) => candidate.startsWith(anchor) || anchor.startsWith(candidate))
  ));
  const score = anchorTokens.length ? matchedTokens.length / anchorTokens.length : 0;
  const minimumMatches = Math.min(2, anchorTokens.length);
  const minimumScore = anchorTokens.length >= 5 ? 0.25 : 0.4;
  const normalizedText = text.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  const normalizedTopic = context.topic.toLocaleLowerCase("ru").replace(/ё/gu, "е");
  const textWithoutExactTopic = normalizedText.includes(normalizedTopic)
    ? normalizedText.replace(normalizedTopic, " ")
    : normalizedText;
  const remainingTokens = alignmentTokens(textWithoutExactTopic);
  const remainingMatches = anchorTokens.filter((anchor) => remainingTokens.includes(anchor));
  // Appending the exact topic as a label to an unrelated post is not semantic alignment.
  // A real post must develop at least one subject concept outside that pasted phrase.
  const exactTopicIndex = normalizedText.indexOf(normalizedTopic);
  const prefixTokens = exactTopicIndex > 0
    ? alignmentTokens(normalizedText.slice(0, exactTopicIndex))
    : [];
  const exactPhraseStuffing = exactTopicIndex > 0
    && prefixTokens.length >= 3
    && remainingMatches.length === 0;
  const passed = anchorTokens.length > 0
    && matchedTokens.length >= minimumMatches
    && score >= minimumScore
    && !exactPhraseStuffing;
  return {
    status: passed ? "passed" : "failed",
    score: Number(score.toFixed(3)),
    topic: context.topic,
    anchorTokens,
    matchedTokens,
  };
}

export function buildTopicRepairInstructions(result: TopicAlignmentResult): string[] {
  if (result.status === "passed") return [];
  return [
    `Тематическое соответствие провалено. Верни весь материал к обязательной теме «${result.topic}».`,
    "Сохрани исходную проблему читателя и предмет обсуждения. Удали абзацы о посторонних темах.",
    "Не восстанавливай неподтверждённые факты из источника: обобщай конкретику, но не меняй тему.",
  ];
}
