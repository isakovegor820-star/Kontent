export const TELEGRAM_CHANNEL_ADMIN_RIGHTS: readonly string[];

export interface TelegramChannelChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
  linked_chat_id?: number;
}

export interface TelegramChannelMembership {
  chat: TelegramChannelChat;
  from?: { id?: number };
  new_chat_member?: {
    status?: string;
    can_post_messages?: boolean;
  };
}

export interface TelegramChannelConnectionClient {
  query(sql: string, values?: readonly unknown[]): Promise<{
    rows: Array<Record<string, unknown>>;
    rowCount?: number;
  }>;
  release(): void;
}

export interface TelegramChannelConnectionPool {
  connect(): Promise<TelegramChannelConnectionClient>;
}

export type TelegramChannelConnectionResult =
  | { state: "access_denied" }
  | { state: "taken" }
  | {
      state: "connected" | "reconnected" | "already_connected";
      channelId: number;
      projectId: number;
      title: string | null;
      username: string | null;
    };

export function telegramChannelAdminUrl(value: unknown): string | null;

export function telegramChannelMembershipChange(value: unknown):
  | { state: "ignored" }
  | { state: "ready" | "revoked" | "permission_lost"; membership: TelegramChannelMembership };

export function saveVerifiedTelegramChannel(
  pool: TelegramChannelConnectionPool,
  input: {
    userId: number;
    projectId: number;
    chat: TelegramChannelChat;
    requestId?: string;
  },
): Promise<TelegramChannelConnectionResult>;

export function markTelegramChannelUnavailable(
  pool: TelegramChannelConnectionPool,
  input: {
    chatId: number;
    status: "revoked" | "permission_lost";
    actorUserId?: number | null;
    requestId?: string;
  },
): Promise<
  | { state: "not_connected" }
  | {
      state: "revoked" | "permission_lost";
      channelId: number;
      projectId: number;
      errorCode: string;
    }
>;
