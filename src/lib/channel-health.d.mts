import type { Pool } from "pg";

export type ChannelHealthStatus =
  | "active"
  | "needs_reconnect"
  | "permission_lost"
  | "revoked"
  | "disconnected";
export function safeChannelErrorCode(value: unknown, fallback?: string): string;
export function classifyTelegramChannelFailure(input: {
  providerErrorCode?: unknown;
  reason?: unknown;
}): { status: ChannelHealthStatus; errorCode: string } | null;
export function classifyVkChannelFailure(result: unknown): {
  status: ChannelHealthStatus;
  errorCode: string;
} | null;
export function classifyOAuthChannelFailure(result: unknown): {
  status: ChannelHealthStatus;
  errorCode: string;
} | null;
export function transitionChannelHealth(pool: Pool, input: {
  channelId: number;
  userId?: number | null;
  actorUserId?: number | null;
  status: ChannelHealthStatus;
  errorCode?: string | null;
  action?: string;
  requestId?: string | null;
}): Promise<{
  channelId: number;
  fromStatus: ChannelHealthStatus;
  status: ChannelHealthStatus;
  errorCode: string | null;
} | null>;
