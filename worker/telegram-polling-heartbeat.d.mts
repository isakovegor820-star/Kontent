export const TELEGRAM_POLLING_HEARTBEAT_KEY: "aurora:worker:telegram-polling:heartbeat:v1";
export const TELEGRAM_POLLING_HEARTBEAT_TTL_SECONDS: 75;
export const TELEGRAM_POLLING_HEARTBEAT_ROLE: "telegram_polling";
export const TELEGRAM_POLLING_STATES: readonly ["up", "conflict"];

export type TelegramPollingState = "up" | "conflict";

export interface TelegramPollingConfiguration {
  mode?: string | null;
  token?: string | null;
  state?: TelegramPollingState;
}

export interface TelegramPollingHeartbeat {
  version: 1;
  role: "telegram_polling";
  state: TelegramPollingState;
  at: string;
}

export function workerModeHasTelegramPolling(mode?: string | null): boolean;
export function telegramPollingEnabled(input: TelegramPollingConfiguration): boolean;
export function telegramPollingHeartbeatPayload(
  atMs?: number,
  state?: TelegramPollingState,
): TelegramPollingHeartbeat;
export function telegramPollingHeartbeatWrite(
  input: TelegramPollingConfiguration,
  atMs?: number,
): { key: typeof TELEGRAM_POLLING_HEARTBEAT_KEY; value: string; ttlSeconds: 75 } | null;
export function parseTelegramPollingHeartbeat(
  raw: unknown,
  options?: { nowMs?: number; maxAgeMs?: number },
): TelegramPollingHeartbeat | null;
