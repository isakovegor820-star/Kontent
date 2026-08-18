export function telegramSafeErrorDescription(value, maxLength = 500) {
  const limit = Number.isSafeInteger(Number(maxLength))
    ? Math.max(1, Number(maxLength))
    : 500;
  return String(value || "")
    .replace(/([#?&](?:token|code|secret|auth|key)=)[^&#\s'"<>]+/giu, "$1[redacted]")
    .replace(/\/bot\d+:[a-z0-9_-]+/giu, "/bot[redacted]")
    .replace(/\b\d{6,}:[a-z0-9_-]{20,}\b/giu, "[redacted-bot-token]")
    .slice(0, limit);
}
