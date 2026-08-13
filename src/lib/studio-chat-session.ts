import type { AiCommand } from "./ai";
import type { ConversationTurn } from "./ai-provider";
import type { DraftAiValidation } from "./draft-types";
import type { Post } from "./types";
import { stripAiReasoning } from "./ai-visible-content.mjs";
import { normalizePostSettings, type PostSettings, type PostSettingsValidation } from "./post-settings";

export type StudioChatMessage = {
  id: string;
  role: "user" | "ai";
  text: string;
  streaming?: boolean;
  postable?: boolean;
  /** Complete terminal result that may be copied/regenerated even when review is required. */
  reviewable?: boolean;
  requiresReview?: boolean;
  quality?: PostSettingsValidation;
  aiValidation?: DraftAiValidation;
  /** Visible recovery context; generated text remains separate and copyable. */
  errorMessage?: string;
  /** Calm user-initiated state, kept separate from actual failures. */
  statusMessage?: string;
  /** Technical phase is separate from the draft body, so progress never replaces text. */
  progressLabel?: string;
  requestId?: string;
  retryable?: boolean;
  interrupted?: boolean;
  requestedEngine?: string;
  effectiveEngine?: string;
  fallbackUsed?: boolean;
  replayed?: boolean;
  generationResultId?: number;
};

export type StudioChatGeneration = {
  cmd: AiCommand;
  input: string;
  variant: number;
  history: ConversationTurn[];
  requestKey?: string;
  /** Недоверенный библиотечный образец формы; сервер не включает его в factual ledger. */
  referenceText?: string;
  referenceSource?: string;
  sourceRef?: Post["sourceRef"];
  referenceDraftId?: number;
  referenceDraftVersion?: number;
  referenceIntent?: "create" | "discuss";
  channelId?: number | null;
  postSettings?: PostSettings;
};

export type StudioChatSession = {
  messages: StudioChatMessage[];
  draft: string;
  workspaceMode: "chat" | "studio";
  generations: Array<[string, StudioChatGeneration]>;
};

/**
 * Объединяет серверный снимок с изменениями активной вкладки при конфликте revision.
 * Одинаковое сообщение берём из активной вкладки, а уникальные сообщения не теряем.
 */
export function mergeStudioChatSessions(
  remote: StudioChatSession,
  local: StudioChatSession,
): StudioChatSession {
  const messageOrder: string[] = [];
  const messages = new Map<string, StudioChatMessage>();
  for (const message of [...remote.messages, ...local.messages]) {
    if (!messages.has(message.id)) messageOrder.push(message.id);
    messages.set(message.id, message);
  }
  const generations = new Map<string, StudioChatGeneration>(remote.generations);
  for (const [id, generation] of local.generations) generations.set(id, generation);
  const mergedMessages = messageOrder.map((id) => messages.get(id)).filter((message): message is StudioChatMessage => Boolean(message));
  const messageIds = new Set(mergedMessages.map((message) => message.id));
  return {
    messages: mergedMessages,
    // При восстановлении важнее не потерять набранный текст: пустой локальный снимок мог
    // появиться до загрузки более свежей серверной версии после Fast Refresh.
    draft: local.draft || remote.draft,
    workspaceMode: local.workspaceMode,
    generations: [...generations].filter(([id]) => messageIds.has(id)),
  };
}

const VERSION = 2;
const MAX_MESSAGES = 60;
const MAX_MESSAGE_LENGTH = 100_000;
const MAX_DRAFT_LENGTH = 20_000;
const MAX_HISTORY_TURNS = 8;
const INTERRUPTED_PLACEHOLDERS = new Set([
  "Разбираю задачу…",
  "Собираю сильный черновик…",
  "Редактирую и убираю ИИ-шаблоны…",
  "Пишу ответ…",
]);

export function isStudioGenerationPlaceholder(text: string): boolean {
  return INTERRUPTED_PLACEHOLDERS.has(text.trim());
}

const STOPPED_STATUS = "Генерация остановлена. Черновик сохранён — его можно скопировать или повторить запрос.";

/**
 * Finalizes the visible client state immediately after a user cancellation.
 * The stream owner is invalidated separately, so late chunks cannot overwrite it.
 */
export function stopStudioStreamingMessages(messages: StudioChatMessage[]): StudioChatMessage[] {
  return messages.map((message) => message.streaming ? {
    ...message,
    text: isStudioGenerationPlaceholder(message.text) ? "" : message.text,
    streaming: false,
    progressLabel: undefined,
    postable: false,
    reviewable: false,
    requiresReview: false,
    quality: undefined,
    aiValidation: undefined,
    errorMessage: undefined,
    statusMessage: STOPPED_STATUS,
    interrupted: true,
    retryable: true,
  } : message);
}
const COMMANDS = new Set<AiCommand>([
  "write",
  "rewrite",
  "shorten",
  "plan",
  "script",
  "image",
  "poll",
  "longread",
]);

type StoredSession = StudioChatSession & {
  version: typeof VERSION;
  owner: number;
  savedAt: string;
};

function normalizedOwner(owner: number): number {
  if (!Number.isSafeInteger(owner) || owner <= 0) throw new TypeError("invalid studio chat owner");
  return owner;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeQuality(value: unknown): PostSettingsValidation | undefined {
  if (!isRecord(value) || typeof value.passed !== "boolean" || !Array.isArray(value.violations)) return undefined;
  if (!isRecord(value.metrics) || typeof value.target !== "string") return undefined;
  const metrics = value.metrics;
  if (![metrics.chars, metrics.bytes, metrics.emojis, metrics.hashtags, metrics.mentions].every(Number.isFinite)) {
    return undefined;
  }
  const violations = value.violations.filter(
    (item): item is { code: string; message: string; blocker: boolean } =>
      isRecord(item) &&
      typeof item.code === "string" &&
      typeof item.message === "string" &&
      typeof item.blocker === "boolean",
  );
  if (violations.length !== value.violations.length) return undefined;
  return value as unknown as PostSettingsValidation;
}

function safeMessage(value: unknown): StudioChatMessage | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || (value.role !== "user" && value.role !== "ai") || typeof value.text !== "string") {
    return null;
  }

  const wasStreaming = value.streaming === true;
  const visible = value.role === "ai" ? stripAiReasoning(value.text) : { text: value.text, reasoningDetected: false };
  const text = visible.text.slice(0, MAX_MESSAGE_LENGTH);
  if (value.role === "ai" && visible.reasoningDetected && !text.trim()) return null;
  const interruptedPlaceholder = wasStreaming && isStudioGenerationPlaceholder(text);
  return {
    id: value.id,
    role: value.role,
    text: interruptedPlaceholder ? "Генерация прервалась. Запусти ещё один вариант — история диалога сохранена." : text,
    streaming: false,
    postable: interruptedPlaceholder ? false : value.postable === true && !wasStreaming,
    reviewable:
      !interruptedPlaceholder &&
      !wasStreaming &&
      (value.reviewable === true || value.postable === true || value.requiresReview === true),
    requiresReview: !interruptedPlaceholder && value.requiresReview === true,
    quality: safeQuality(value.quality),
    aiValidation: isRecord(value.aiValidation) && value.aiValidation.version === 1
      ? value.aiValidation as unknown as DraftAiValidation
      : undefined,
    errorMessage: typeof value.errorMessage === "string"
      ? value.errorMessage.slice(0, 2000)
      : wasStreaming
        ? "Генерация прервалась до подтверждения результата. Повтори запрос — черновик и ключ сохранены."
        : undefined,
    statusMessage: typeof value.statusMessage === "string"
      ? value.statusMessage.slice(0, 500)
      : undefined,
    progressLabel: wasStreaming
      ? undefined
      : typeof value.progressLabel === "string"
        ? value.progressLabel.slice(0, 200)
        : undefined,
    requestId: typeof value.requestId === "string" ? value.requestId.slice(0, 100) : undefined,
    retryable: wasStreaming || value.retryable === true,
    interrupted: wasStreaming || value.interrupted === true,
    requestedEngine: typeof value.requestedEngine === "string" ? value.requestedEngine.slice(0, 80) : undefined,
    effectiveEngine: typeof value.effectiveEngine === "string" ? value.effectiveEngine.slice(0, 80) : undefined,
    fallbackUsed: value.fallbackUsed === true,
    replayed: value.replayed === true,
    generationResultId: Number.isSafeInteger(value.generationResultId) && Number(value.generationResultId) > 0
      ? Number(value.generationResultId)
      : undefined,
  };
}

function safeTurn(value: unknown): ConversationTurn | null {
  if (!isRecord(value)) return null;
  if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return null;
  const visible = value.role === "assistant"
    ? stripAiReasoning(value.content)
    : { text: value.content, reasoningDetected: false };
  if (value.role === "assistant" && visible.reasoningDetected && !visible.text.trim()) return null;
  return { role: value.role, content: visible.text.slice(0, MAX_MESSAGE_LENGTH) };
}

function safeSourceRef(value: unknown): Post["sourceRef"] | undefined {
  if (
    !isRecord(value)
    || !["competitor", "trend", "idea", "reference", "rss"].includes(String(value.kind))
    || typeof value.id !== "string"
    || typeof value.label !== "string"
  ) return undefined;
  const optional = (candidate: unknown, max: number) => (
    typeof candidate === "string" && candidate.trim() ? candidate.slice(0, max) : undefined
  );
  let provenance: NonNullable<Post["sourceRef"]>["provenance"];
  if (
    isRecord(value.provenance)
    && ["content_idea", "competitor_post", "trend", "radar_result", "saved_reference", "rss_item"].includes(String(value.provenance.kind))
  ) {
    provenance = {
      kind: value.provenance.kind as NonNullable<typeof provenance>["kind"],
      ...(optional(value.provenance.id, 200) ? { id: optional(value.provenance.id, 200) } : {}),
      ...(optional(value.provenance.label, 400) ? { label: optional(value.provenance.label, 400) } : {}),
      ...(optional(value.provenance.url, 2_048) ? { url: optional(value.provenance.url, 2_048) } : {}),
    };
  }
  return {
    kind: value.kind as NonNullable<Post["sourceRef"]>["kind"],
    id: value.id.slice(0, 200),
    label: value.label.slice(0, 400),
    ...(optional(value.topic, 500) ? { topic: optional(value.topic, 500) } : {}),
    ...(optional(value.readerProblem, 800) ? { readerProblem: optional(value.readerProblem, 800) } : {}),
    ...(optional(value.semanticGoal, 800) ? { semanticGoal: optional(value.semanticGoal, 800) } : {}),
    ...(optional(value.hook, 1_000) ? { hook: optional(value.hook, 1_000) } : {}),
    ...(optional(value.structure, 2_000) ? { structure: optional(value.structure, 2_000) } : {}),
    ...(optional(value.whyItWorked, 1_200) ? { whyItWorked: optional(value.whyItWorked, 1_200) } : {}),
    ...(provenance ? { provenance } : {}),
  };
}

function safeGeneration(value: unknown): StudioChatGeneration | null {
  if (!isRecord(value) || typeof value.cmd !== "string" || !COMMANDS.has(value.cmd as AiCommand)) return null;
  if (typeof value.input !== "string" || !Number.isInteger(value.variant) || !Array.isArray(value.history)) return null;
  const history = value.history.map(safeTurn).filter((turn): turn is ConversationTurn => turn !== null).slice(-MAX_HISTORY_TURNS);
  return {
    cmd: value.cmd as AiCommand,
    input: value.input.slice(0, MAX_MESSAGE_LENGTH),
    variant: Math.max(0, value.variant as number),
    history,
    requestKey: typeof value.requestKey === "string" && /^[A-Za-z0-9:_-]{8,96}$/u.test(value.requestKey)
      ? value.requestKey
      : undefined,
    referenceText: typeof value.referenceText === "string"
      ? value.referenceText.slice(0, 4000)
      : undefined,
    referenceSource: typeof value.referenceSource === "string"
      ? value.referenceSource.slice(0, 160)
      : undefined,
    sourceRef: safeSourceRef(value.sourceRef),
    referenceDraftId: Number.isSafeInteger(value.referenceDraftId) && Number(value.referenceDraftId) > 0
      ? Number(value.referenceDraftId)
      : undefined,
    referenceDraftVersion: Number.isSafeInteger(value.referenceDraftVersion) && Number(value.referenceDraftVersion) > 0
      ? Number(value.referenceDraftVersion)
      : undefined,
    referenceIntent: value.referenceIntent === "create" || value.referenceIntent === "discuss"
      ? value.referenceIntent
      : undefined,
    channelId: value.channelId === null
      ? null
      : Number.isSafeInteger(value.channelId) && Number(value.channelId) > 0
        ? Number(value.channelId)
        : undefined,
    postSettings: isRecord(value.postSettings) ? normalizePostSettings(value.postSettings) : undefined,
  };
}

export function studioChatStorageKey(owner: number): string {
  return `aurora:studio-chat:v${VERSION}:user-${normalizedOwner(owner)}`;
}

export function serializeStudioChatSession(owner: number, session: StudioChatSession): string {
  const messages = session.messages.slice(-MAX_MESSAGES);
  const messageIds = new Set(messages.map((message) => message.id));
  const stored: StoredSession = {
    version: VERSION,
    owner: normalizedOwner(owner),
    savedAt: new Date().toISOString(),
    messages,
    draft: session.draft.slice(0, MAX_DRAFT_LENGTH),
    workspaceMode: session.workspaceMode,
    generations: session.generations.filter(([id]) => messageIds.has(id)),
  };
  return JSON.stringify(stored);
}

export function parseStudioChatSession(raw: string | null, owner: number): StudioChatSession | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as unknown;
    if (!isRecord(value) || value.version !== VERSION || value.owner !== normalizedOwner(owner)) return null;
    if (!Array.isArray(value.messages) || typeof value.draft !== "string" || !Array.isArray(value.generations)) return null;

    const messages = value.messages.map(safeMessage).filter((message): message is StudioChatMessage => message !== null).slice(-MAX_MESSAGES);
    const messageIds = new Set(messages.map((message) => message.id));
    const generations: Array<[string, StudioChatGeneration]> = [];
    for (const entry of value.generations) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !messageIds.has(entry[0])) continue;
      const generation = safeGeneration(entry[1]);
      if (generation) generations.push([entry[0], generation]);
    }

    return {
      messages,
      draft: value.draft.slice(0, MAX_DRAFT_LENGTH),
      workspaceMode: value.workspaceMode === "studio" ? "studio" : "chat",
      generations,
    };
  } catch {
    return null;
  }
}
