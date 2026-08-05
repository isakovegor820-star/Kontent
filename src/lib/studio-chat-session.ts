import type { AiCommand } from "./ai";
import type { ConversationTurn } from "./ai-provider";
import type { DraftAiValidation } from "./draft-types";
import type { Post } from "./types";
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
  /** Technical phase is separate from the draft body, so progress never replaces text. */
  progressLabel?: string;
  requestId?: string;
  retryable?: boolean;
  interrupted?: boolean;
  requestedEngine?: string;
  effectiveEngine?: string;
  fallbackUsed?: boolean;
  replayed?: boolean;
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
  channelId?: number | null;
  postSettings?: PostSettings;
};

export type StudioChatSession = {
  messages: StudioChatMessage[];
  draft: string;
  workspaceMode: "chat" | "studio";
  generations: Array<[string, StudioChatGeneration]>;
};

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
  const text = value.text.slice(0, MAX_MESSAGE_LENGTH);
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
  };
}

function safeTurn(value: unknown): ConversationTurn | null {
  if (!isRecord(value)) return null;
  if ((value.role !== "user" && value.role !== "assistant") || typeof value.content !== "string") return null;
  return { role: value.role, content: value.content.slice(0, MAX_MESSAGE_LENGTH) };
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
    sourceRef: isRecord(value.sourceRef)
      && (value.sourceRef.kind === "competitor" || value.sourceRef.kind === "trend")
      && typeof value.sourceRef.id === "string"
      && typeof value.sourceRef.label === "string"
      ? {
          kind: value.sourceRef.kind,
          id: value.sourceRef.id.slice(0, 160),
          label: value.sourceRef.label.slice(0, 300),
        }
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
