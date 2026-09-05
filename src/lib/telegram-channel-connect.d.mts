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
  query?(sql: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export type TelegramChannelConnectionResult =
  | { state: "access_denied" }
  | { state: "proof_required" }
  | { state: "proof_invalid" }
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
    actorId: number;
    proofId: string;
    eventId?: number;
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

export function createTelegramChannelProof(pool: TelegramChannelConnectionPool, input: {
  userId: number; projectId: number; source: "web" | "telegram"; chatId?: number;
}): Promise<{ state: "telegram_identity_required" | "connection_pending_other_project" | "access_denied" } | {
  state: "ready"; proofId: string; actorId: number; projectId: number;
}>;
export function pendingTelegramChannelProof(pool: TelegramChannelConnectionPool, input: {
  actorId: number; eventDate: number;
}): Promise<{ proof_id: string; user_id: number; project_id: number; actor_id: number } | null>;
