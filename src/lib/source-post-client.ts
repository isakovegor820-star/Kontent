import { acknowledgeAiTerminal } from "./ai-client-idempotency";
import { createAiDraftProjection, projectAiDraftEvent } from "./ai-draft-projection";
import { finalizeAiClientStream, parseAiStreamBuffer, type AiStreamEvent } from "./ai-stream";
import { readAiStreamWithDeadline } from "./ai-stream-reader";
import { createServerDraft } from "./draft-client";
import type { ServerDraft } from "./draft-types";
import { legalOpportunityPostSettings, legalOpportunityVariantFromClientKey } from "./legal-opportunity-post";
import { projectFetch as fetch } from "./project-fetch";

export class SourcePostCreationError extends Error {}

/** Create a new AI draft from an immutable source; never PATCH or recover the source. */
export async function createPostFromSource(
  source: ServerDraft,
  options: { signal: AbortSignal; onProgress: (message: string) => void },
) {
  const { onProgress } = options;
  // Bound the entire operation, including settings, response headers, ACK and save.
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(310_000)]);
  const destination = source.destinations.find((item) => item.is_active);
  if (source.purpose !== "source_context" || !source.source_ref) {
    throw new SourcePostCreationError("Материал-источник недоступен. Откройте инфоповод заново.");
  }
  if (!destination) {
    throw new SourcePostCreationError("Канал отключён. Вернитесь к инфоповоду и выберите активный канал.");
  }

  onProgress("Подготавливаем факты и настройки поста…");
  const settingsResponse = await fetch("/api/settings", { cache: "no-store", signal });
  if (!settingsResponse.ok) {
    throw new SourcePostCreationError("Не удалось загрузить настройки поста. Повторите создание.");
  }
  const settings = await settingsResponse.json() as { postSettings?: unknown };
  const body = JSON.stringify({
    command: "write",
    input: "Создай отдельный оригинальный пост по фактам материала-источника.",
    surface: "composer",
    channelId: destination.channel_id,
    referenceDraftId: source.id,
    referenceDraftVersion: source.version,
    referenceIntent: "create",
    postSettings: legalOpportunityPostSettings(
      settings.postSettings,
      legalOpportunityVariantFromClientKey(source.client_key),
      destination.network,
    ),
  });
  // Refresh/retry replays the same result. Changed settings identify a new request,
  // rather than reusing an idempotency key with a different body.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const requestKey = `composer_source_${hash}`;
  signal.throwIfAborted();
  onProgress("ИИ пишет новый пост по фактам источника…");
  const response = await fetch("/api/ai/generate", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": requestKey },
    body,
    signal,
  });
  if (!response.ok || !response.body) {
    throw new SourcePostCreationError(response.status === 429
      ? "Лимит ИИ исчерпан. Повторите создание после обновления лимита."
      : response.status === 409
        ? "Не удалось продолжить этот запрос. Откройте инфоповод заново и повторите создание."
        : "ИИ сейчас недоступен. Источник сохранён — повторите создание поста.");
  }
  let projection = createAiDraftProjection();
  let buffer = "";
  let failed = false;
  let validationReceived = false;
  let doneReceived = false;
  let validationBlocked = false;
  let validationRequiresReview = false;
  let terminalGenerationResultId: number | undefined;
  const applyEvent = (event: AiStreamEvent) => {
    projection = projectAiDraftEvent(projection, event);
    if (event.type === "phase") {
      onProgress(event.phase === "editing" ? "ИИ редактирует новый пост…" : "ИИ пишет новый пост по фактам источника…");
    } else if (event.type === "validation") {
      validationReceived = true;
      validationBlocked = event.status === "blocked";
      validationRequiresReview = event.requiresReview;
    } else if (event.type === "error") {
      failed = true;
    } else if (event.type === "done") {
      doneReceived = true;
      terminalGenerationResultId = event.generationResultId;
    }
  };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  try {
    await readAiStreamWithDeadline({
      reader,
      idleTimeoutMs: 75_000,
      overallTimeoutMs: 310_000,
      onChunk: (chunk) => {
        buffer += decoder.decode(chunk, { stream: true });
        const parsed = parseAiStreamBuffer(buffer);
        buffer = parsed.rest;
        parsed.events.forEach(applyEvent);
      },
    });
    buffer += decoder.decode();
    if (buffer.trim()) parseAiStreamBuffer(`${buffer}\n`).events.forEach(applyEvent);
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const completion = finalizeAiClientStream({
    text: projection.buffer,
    failed,
    validationReceived,
    doneReceived,
    validationBlocked,
    validationRequiresReview,
  });
  if (completion.status !== "complete") {
    throw new SourcePostCreationError("ИИ не закончил пост. Источник сохранён — повторите создание.");
  }
  signal.throwIfAborted();
  onProgress("Сохраняем новый пост…");
  const acknowledged = await acknowledgeAiTerminal(requestKey, { signal });
  if (terminalGenerationResultId != null && terminalGenerationResultId !== acknowledged.generationResultId) {
    throw new SourcePostCreationError("Не удалось подтвердить результат ИИ. Повторите создание поста.");
  }
  signal.throwIfAborted();
  const result = await createServerDraft({
    clientKey: `draft_result_${requestKey}`,
    text: completion.text,
    media: null,
    scheduledAt: null,
    origin: "ai",
    sourceRef: null,
    channelIds: [destination.channel_id],
    aiValidation: null,
    generationResultId: acknowledged.generationResultId,
  }, signal);
  signal.throwIfAborted();
  return result;
}
