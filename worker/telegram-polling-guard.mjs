import { createHash } from "node:crypto";

export const TELEGRAM_POLLING_GUARD_CHECK_INTERVAL_MS = 1_000;
export const TELEGRAM_POLLING_GUARD_RETRY_MS = 2_000;

const TELEGRAM_POLLING_GUARD_ORIGIN = "https://api.telegram.org";

export const TELEGRAM_POLLING_ALLOWED_UPDATES = Object.freeze([
  "message",
  "channel_post",
  "edited_channel_post",
  "message_reaction_count",
  "callback_query",
  "my_chat_member",
  "business_message",
]);

function guardDigest(token, purpose) {
  return createHash("sha256")
    .update(`aurora-telegram-polling-guard\0${purpose}\0${token}`)
    .digest("hex");
}

/**
 * Telegram does not allow webhook delivery and getUpdates at the same time. We use an
 * intentionally non-deliverable URL on Telegram's own domain as a durable queue gate:
 * forgotten pollers cannot consume commands, while Telegram retains them for our worker.
 */
export function telegramPollingGuardConfiguration(token) {
  const normalizedToken = String(token || "").trim();
  if (!normalizedToken) throw new TypeError("telegram polling guard requires a token");
  return {
    url: `${TELEGRAM_POLLING_GUARD_ORIGIN}/aurora-polling-guard-${guardDigest(normalizedToken, "path")}`,
    secret_token: guardDigest(normalizedToken, "secret"),
    max_connections: 1,
    drop_pending_updates: false,
    allowed_updates: TELEGRAM_POLLING_ALLOWED_UPDATES,
  };
}

export function telegramPollingGuardMatches(info, token) {
  if (!info || typeof info !== "object") return false;
  return String(info.url || "") === telegramPollingGuardConfiguration(token).url;
}

export function telegramPollingGuardPendingCount(info) {
  const value = Number(info?.pending_update_count);
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}
