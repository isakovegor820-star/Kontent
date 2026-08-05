import { createHash } from "node:crypto";

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

export function normalizeIdempotencyKey(value: unknown): string | null {
  const key = String(value ?? "").trim();
  return IDEMPOTENCY_KEY.test(key) ? key : null;
}

/**
 * Один серверный draft создаёт не больше одного queue-post на destination. Ключ намеренно
 * не зависит от редактируемых текста/даты: после partial success повтор должен вернуть уже
 * принятый destination, а не создать там второй пост с новой ревизией.
 */
export function draftDestinationIdempotencyKey(draftId: number, channelId: number): string {
  if (
    !Number.isSafeInteger(draftId) || draftId <= 0 ||
    !Number.isSafeInteger(channelId) || channelId <= 0
  ) {
    throw new TypeError("invalid draft destination");
  }
  return `draft:${draftId}:destination:${channelId}`;
}

export function publicationFingerprint(input: {
  userId: number;
  channelId: number;
  text: string;
  scheduledAt: string;
  media: string | null;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.userId,
        input.channelId,
        input.text,
        input.scheduledAt,
        input.media,
      ]),
    )
    .digest("hex");
}

export function retryJobSuffix(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 20);
}
