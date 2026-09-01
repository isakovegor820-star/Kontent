export const TELEGRAM_POLLING_GUARD_CHECK_INTERVAL_MS: 1000;
export const TELEGRAM_POLLING_GUARD_RETRY_MS: 2000;
export const TELEGRAM_POLLING_ALLOWED_UPDATES: readonly [
  "message",
  "channel_post",
  "edited_channel_post",
  "message_reaction_count",
  "callback_query",
  "my_chat_member",
  "business_message",
];

export interface TelegramPollingGuardConfiguration {
  url: string;
  secret_token: string;
  max_connections: 1;
  drop_pending_updates: false;
  allowed_updates: typeof TELEGRAM_POLLING_ALLOWED_UPDATES;
}

export interface TelegramWebhookInfo {
  url?: unknown;
  pending_update_count?: unknown;
}

export function telegramPollingGuardConfiguration(token: unknown): TelegramPollingGuardConfiguration;
export function telegramPollingGuardMatches(info: unknown, token: unknown): boolean;
export function telegramPollingGuardPendingCount(info: unknown): number;
