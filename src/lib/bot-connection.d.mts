import type { Pool } from "pg";

export const BOT_CONNECTION_TOKEN_BYTES: number;
export const BOT_CONNECTION_TOKEN_PATTERN: RegExp;
export const BOT_CONNECTION_TTL_MINUTES: number;
export const LEGACY_BOT_LINK_CODE_PATTERN: RegExp;

export function createBotConnectionToken(): string;
export function hashBotConnectionToken(rawToken: unknown): string | null;
export function maskBotAccountEmail(value: unknown): string;
export function botConnectionKey(userId: number, chatId: number | string | null, revision?: number | string): string | null;
export function getBotAccountConnection(pool: Pool, userId: number): Promise<{ telegramChatId: number | null; connectionKey: string | null }>;
export function disconnectBotAccount(pool: Pool, input: {
  userId: number;
  expectedConnectionKey: unknown;
  source?: "settings" | "telegram";
}): Promise<{ state: "invalid" | "confirmation_required" | "already_disconnected" | "connection_changed" | "disconnected" }>;
export function normalizeTelegramBotUsername(value: unknown): string | null;
export function parseLegacyBotStartPayload(value: unknown): {
  code: string;
  intent: "channel" | null;
};

export function createLegacyBotLink(pool: Pool, input: {
  userId: number;
  projectId?: number | null;
}): Promise<{
  code: string;
  expiresInMinutes: number;
}>;

export function consumeLegacyBotLink(pool: Pool, input: {
  code: unknown;
  telegramChatId: number;
}): Promise<{
  state: "invalid" | "account_disabled" | "move_required" | "connected";
  userId?: number;
  telegramChatId?: number;
  moved?: boolean;
  projectId?: number | null;
}>;

export interface BotConnectionTelegramIdentity {
  userId: number;
  chatId: number;
  username: string | null;
  displayName: string;
}

export interface BotConnectionInspection {
  state: "invalid" | "pending" | "expired" | "revoked" | "confirmed";
  telegram?: BotConnectionTelegramIdentity;
  expiresAt?: string;
  confirmedByUserId?: number | null;
  moveRequired?: boolean;
  chatLinkedToAnotherAccount?: boolean;
  accountLinkedToAnotherChat?: boolean;
  accountEnabled?: boolean;
}

export function createBotConnectionSession(pool: Pool, input: {
  telegramUserId: number;
  telegramChatId: number;
  username?: string | null;
  displayName?: string | null;
}): Promise<{
  token: string;
  expiresAt: string;
  expiresInMinutes: number;
  telegram: BotConnectionTelegramIdentity;
}>;

export function inspectBotConnectionSession(pool: Pool, input: {
  token: unknown;
  userId?: number | null;
  nowMs?: number;
}): Promise<BotConnectionInspection>;

export function confirmBotConnectionSession(pool: Pool, input: {
  token: unknown;
  userId: number;
  allowMove?: boolean;
  nowMs?: number;
}): Promise<{
  state: "invalid" | "unauthorized" | "expired" | "revoked" | "used" | "account_disabled" | "move_required" | "already_confirmed" | "connected";
  telegramChatId?: number;
  moved?: boolean;
  chatLinkedToAnotherAccount?: boolean;
  accountLinkedToAnotherChat?: boolean;
}>;

export function disconnectBotChat(pool: Pool, input: {
  userId: number;
  telegramChatId: number;
  expectedConnectionKey: unknown;
}): Promise<boolean>;
