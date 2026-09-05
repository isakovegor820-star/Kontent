import type { TelegramChannelChat } from "./telegram-channel-connect.mjs";
export const TELEGRAM_CONNECT_DEADLINE_MS: number;
export class TelegramConnectError extends Error {
  code: string;
  status: number;
  retryAfter: number | null;
  constructor(code: string, status: number, retryAfter?: number | null);
}
export function verifyTelegramChannelActor(input: {
  token?: string; actorId: number; chatRef: string | number; signal?: AbortSignal;
  fetcher?: typeof fetch; deadlineMs?: number;
}): Promise<TelegramChannelChat>;
