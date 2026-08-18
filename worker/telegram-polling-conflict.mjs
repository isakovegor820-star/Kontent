const TELEGRAM_POLLING_CONFLICT_DELAYS_MS = Object.freeze([
  1_000,
  2_000,
  5_000,
  10_000,
]);

export function telegramPollingConflictCooldownMs(consecutiveConflicts) {
  const count = Number.isSafeInteger(Number(consecutiveConflicts))
    ? Math.max(1, Number(consecutiveConflicts))
    : 1;
  return TELEGRAM_POLLING_CONFLICT_DELAYS_MS[
    Math.min(count, TELEGRAM_POLLING_CONFLICT_DELAYS_MS.length) - 1
  ];
}
