export const TELEGRAM_UPDATE_MAX_ATTEMPTS = 3;

export function nextTelegramUpdateFailure(previousAttempts, maxAttempts = TELEGRAM_UPDATE_MAX_ATTEMPTS) {
  const previous = Number.isSafeInteger(Number(previousAttempts))
    ? Math.max(0, Number(previousAttempts))
    : 0;
  const limit = Number.isSafeInteger(Number(maxAttempts))
    ? Math.max(1, Number(maxAttempts))
    : TELEGRAM_UPDATE_MAX_ATTEMPTS;
  const attempts = previous + 1;
  return {
    attempts,
    retry: attempts < limit,
    exhausted: attempts >= limit,
  };
}

export function telegramRetryAfterMs(response) {
  if (response?.ok === true) return null;
  const errorCode = Number(response?.error_code);
  if (errorCode !== 429 && (errorCode < 500 || errorCode > 599)) return null;
  const retryAfterSeconds = Number(response?.parameters?.retry_after);
  return Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
    ? Math.min(30_000, Math.ceil(retryAfterSeconds * 1_000))
    : 1_500;
}
