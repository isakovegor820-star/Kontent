import { createHash } from "node:crypto";

export interface PublicationOperationSnapshot {
  userId: number;
  draftId: number;
  draftVersion: number;
  text: string;
  media: unknown;
  destinationIds: number[];
  scheduledAt: string;
  timezone: string;
  options?: Record<string, unknown>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

export function normalizeOperationDestinations(values: readonly number[]): number[] {
  return [...new Set(values.map(Number).filter((value) => Number.isSafeInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

export function publicationOperationFingerprint(snapshot: PublicationOperationSnapshot): string {
  return createHash("sha256").update(JSON.stringify(canonical({
    userId: snapshot.userId,
    draftId: snapshot.draftId,
    draftVersion: snapshot.draftVersion,
    text: snapshot.text,
    media: snapshot.media ?? null,
    destinationIds: normalizeOperationDestinations(snapshot.destinationIds),
    scheduledAt: new Date(snapshot.scheduledAt).toISOString(),
    timezone: snapshot.timezone,
    options: snapshot.options ?? {},
  }))).digest("hex");
}
