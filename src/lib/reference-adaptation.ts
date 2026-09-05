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
  /** Only a server-curated legal RSS item can opt into factual grounding. */
  factualGrounding?: {
    id: string;
    label: string;
    text: string;
    url?: string;
  };
  mode: "same_topic_original_post";
};

export type TopicAlignmentResult = {
  status: "passed" | "failed";
  score: number;
  topic: string;
  semanticAdapter: string;
  reasonCode: string;
};

export interface TopicAlignmentAdapter {
  /** Stable, non-secret classifier identifier. */
  readonly id: string;
  checkTopicAlignment(
    input: {
      topic: string;
      readerProblem?: string;
      semanticGoal?: string;
      text: string;
    },
    options?: { signal?: AbortSignal },
  ): Promise<{
    verdict: "aligned" | "misaligned" | "unknown";
    confidence: number;
    reasonCode: string;
  }>;
}

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
  if (!source) return "";
  const fragments = source
    .split(/\n+|(?<=[.!?])\s+/u)
    .map((fragment) => sanitizeSemanticIntent(fragment, 320))
    .filter(Boolean);
  const usable = fragments.map((candidate) => ({
    candidate,
    words: candidate.match(/[\p{L}]{2,}/gu) ?? [],
    genericHook: /^(?:а\s+)?(?:вы|ты|кто|почему|зачем|когда|что|знаете\s+ли)(?!\p{L})/iu.test(candidate),
  })).filter(({ words }) => words.length >= 2 && words.length <= 40);

  // The resolver calls this only for text reloaded from an authenticated server source.
  // Prefer the first declarative fragment, so a generic hook cannot replace the subject.
  // The result remains semantic intent: dates, names, amounts and links were removed above
  // and it is never promoted to factual evidence.
  const declarative = usable.find(({ genericHook }) => !genericHook);
  if (declarative) return declarative.candidate;
  if (usable[0]) return usable[0].candidate;

  // Long one-sentence sources still need an actionable discussion topic. Keep a bounded,
  // sanitized prefix instead of rejecting the entire server-owned card.
  const fallback = sanitizeSemanticIntent(source, 320);
  const words = fallback.match(/[\p{L}]{2,}/gu) ?? [];
  return words.length >= 2 ? fallback : "";
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

  // The source resolver must persist an explicit server-owned subject. Re-deriving it
  // later from arbitrary body sentences risks validating against a substituted topic.
  const topic = sanitizeSemanticIntent(sourceRef.topic, 320);
  if (!topic) return null;
  const readerProblem = sanitizeSemanticIntent(sourceRef.readerProblem, 500) || undefined;
  const semanticGoal = sanitizeSemanticIntent(sourceRef.semanticGoal, 500) || undefined;
  const hook = cleanText(sourceRef.hook, 600) || undefined;
  const structure = cleanText(sourceRef.structure, 1_200) || undefined;
  const whyItWorked = cleanText(sourceRef.whyItWorked, 800) || undefined;
  const factualGrounding = sourceRef.factualGrounding === "curated_legal_source"
    && sourceRef.provenance?.kind === "rss_item"
    ? {
        id: cleanText(sourceRef.provenance.id, 200) || String(draft.id),
        label: cleanText(sourceRef.provenance.label, 400) || cleanText(sourceRef.label, 400) || "Юридический источник",
        text: sourceText,
        ...(sourceRef.provenance.url?.trim()
          ? { url: sourceRef.provenance.url.trim().slice(0, 2_048) }
          : {}),
      }
    : undefined;

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
    ...(factualGrounding ? { factualGrounding } : {}),
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
    context.factualGrounding
      ? "Собери готовую публикацию: сильная первая строка или заголовок, основная часть, уместный призыв к действию и релевантные хэштеги в конце."
      : null,
    context.factualGrounding
      ? "Используй только факты, прямо указанные в проверенном источнике карточки. Переработай их своими словами, не копируй формулировки и не добавляй отсутствующие выводы, нормы, цифры или обещания."
      : "Не копируй формулировки и не переноси неподтверждённые цифры, даты, имена, ссылки, реквизиты, цены, обещания, кейсы или проверяемые выводы. Если конкретику нельзя подтвердить, обобщи её внутри той же темы.",
  ].filter(Boolean).join("\n\n");
}

const SAFE_ADAPTER_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const SAFE_REASON_CODE = /^[a-z0-9][a-z0-9._-]{0,79}$/u;

/**
 * Independent semantic guard. Topic text is intent, never factual evidence. A missing,
 * failed or malformed classifier cannot produce a publishable result.
 */
export async function validateTopicAlignment(
  text: string,
  context: Pick<ReferenceAdaptationContext, "topic" | "readerProblem" | "semanticGoal">,
  options: { adapter?: TopicAlignmentAdapter | null; signal?: AbortSignal } = {},
): Promise<TopicAlignmentResult> {
  const adapter = options.adapter ?? null;
  const adapterId = adapter && SAFE_ADAPTER_ID.test(adapter.id) ? adapter.id : "unavailable";
  const failed = (reasonCode: string): TopicAlignmentResult => ({
    status: "failed",
    score: 0,
    topic: context.topic,
    semanticAdapter: adapterId,
    reasonCode,
  });
  if (!adapter) return failed("semantic_check_unavailable");
  let result;
  try {
    result = await adapter.checkTopicAlignment({
      topic: context.topic,
      ...(context.readerProblem ? { readerProblem: context.readerProblem } : {}),
      ...(context.semanticGoal ? { semanticGoal: context.semanticGoal } : {}),
      text: cleanText(text, 16_384),
    }, { signal: options.signal });
  } catch {
    return failed("semantic_check_failed");
  }
  if (
    !result
    || !["aligned", "misaligned", "unknown"].includes(result.verdict)
    || !Number.isFinite(result.confidence)
    || result.confidence < 0
    || result.confidence > 1
    || !SAFE_REASON_CODE.test(result.reasonCode)
  ) return failed("semantic_check_malformed");
  // Unknown and low-confidence verdicts fail closed. The classifier is instructed that
  // merely pasting the topic label into unrelated text is misalignment.
  const passed = result.verdict === "aligned" && result.confidence >= 0.8;
  return {
    status: passed ? "passed" : "failed",
    score: Number(result.confidence.toFixed(3)),
    topic: context.topic,
    semanticAdapter: adapterId,
    reasonCode: result.reasonCode,
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
