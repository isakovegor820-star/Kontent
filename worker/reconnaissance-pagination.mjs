function positiveSafeInteger(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

/**
 * Decides whether the public Telegram reader has reached the last post already stored.
 * A normal scan stays one-page-fast; only a gap larger than one page is paginated.
 */
export function telegramHistoryPageDecision({
  pagePostIds,
  added,
  exhaustive = false,
  afterPostId = null,
  seenBoundaries = new Set(),
}) {
  const ids = Array.isArray(pagePostIds)
    ? pagePostIds.map(positiveSafeInteger).filter((id) => id != null)
    : [];
  if (!ids.length || !Number.isSafeInteger(added) || added <= 0) {
    return { done: true, historyComplete: true, nextBefore: null };
  }

  const oldestId = Math.min(...ids);
  if (seenBoundaries.has(oldestId)) {
    return { done: true, historyComplete: true, nextBefore: null };
  }

  const boundary = positiveSafeInteger(afterPostId);
  if (!exhaustive && boundary == null) {
    return { done: true, historyComplete: true, nextBefore: null };
  }
  if (boundary != null && oldestId <= boundary) {
    return { done: true, historyComplete: true, nextBefore: null };
  }
  return { done: false, historyComplete: false, nextBefore: oldestId };
}
