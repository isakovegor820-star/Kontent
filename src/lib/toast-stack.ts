export const MAX_VISIBLE_TOASTS = 3;

export type ToastStackItem = {
  id: string;
  kind: "success" | "danger" | "fire" | "info";
  title: string;
  body?: string;
  dedupeKey: string;
};

export function stableToastDedupeKey(input: {
  kind: ToastStackItem["kind"];
  title: string;
  body?: string;
  dedupeKey?: string;
}): string {
  const explicit = input.dedupeKey?.trim();
  return explicit || JSON.stringify([input.kind, input.title.trim(), input.body?.trim() ?? ""]);
}

/** Adds at most one active semantic notification and keeps the visible stack bounded. */
export function appendToastStack<T extends ToastStackItem>(
  current: readonly T[],
  incoming: T,
  limit = MAX_VISIBLE_TOASTS,
): T[] {
  if (current.some((toast) => toast.dedupeKey === incoming.dedupeKey)) return [...current];
  const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : MAX_VISIBLE_TOASTS;
  if (current.length < safeLimit) return [...current, incoming];

  // Routine feedback must not displace a screenful of unresolved critical failures.
  const routineIndex = current.findIndex((toast) => toast.kind !== "danger");
  if (incoming.kind !== "danger" && routineIndex === -1) return [...current];
  const removeAt = routineIndex === -1 ? 0 : routineIndex;
  return current.filter((_, index) => index !== removeAt).concat(incoming).slice(-safeLimit);
}
