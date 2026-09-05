import { projectFetch as fetch } from "@/lib/project-fetch";
export interface BotLinkStatus {
  linked: boolean;
  bot: string | null;
  channelConnectUrl: string | null;
  botStatus: "up" | "down" | "not_configured" | "conflict";
}

export interface TelegramChannelConnectionLaunch {
  url: string;
  bot: string;
  linkingAccount: boolean;
}

type TelegramChannelState = {
  id: number;
  network: string;
  is_active: boolean;
  status?: string;
  updated_at?: string | null;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function responseBody(response: Response): Promise<unknown> {
  return response.json().catch(() => null);
}

export async function parseBotLinkStatusResponse(response: Response): Promise<BotLinkStatus> {
  const body = await responseBody(response);
  if (!response.ok || !isRecord(body) || typeof body.linked !== "boolean") {
    throw new Error("bot_link_status_unavailable");
  }
  if (body.bot != null && typeof body.bot !== "string") {
    throw new Error("bot_link_status_invalid");
  }
  if (body.channelConnectUrl != null && typeof body.channelConnectUrl !== "string") {
    throw new Error("bot_link_status_invalid");
  }
  if (
    typeof body.botStatus !== "string"
    || !new Set(["up", "down", "not_configured", "conflict"]).has(body.botStatus)
  ) {
    throw new Error("bot_link_status_invalid");
  }
  return {
    linked: body.linked,
    bot: body.bot ?? null,
    channelConnectUrl: body.channelConnectUrl ?? null,
    botStatus: body.botStatus as BotLinkStatus["botStatus"],
  };
}

export async function requireBotUnlinkSuccess(response: Response): Promise<void> {
  const body = await responseBody(response);
  if (!response.ok || !isRecord(body) || body.ok !== true) {
    throw new Error("bot_unlink_failed");
  }
}

/**
 * Resolves one continuous account → channel Telegram journey.
 *
 * Every launch uses the one-time /start handshake, capturing its Aurora project.
 * The bot then opens the native picker against that immutable short-lived intent.
 */
export async function requestTelegramChannelConnection(
  fetcher: typeof fetch = fetch,
): Promise<TelegramChannelConnectionLaunch> {
  const status = await parseBotLinkStatusResponse(
    await fetcher("/api/bot/link", { cache: "no-store", signal: AbortSignal.timeout(8_000) }),
  );
  if (status.botStatus !== "up") throw new Error(`bot_${status.botStatus}`);
  if (!status.bot) throw new Error("bot_not_configured");

  const response = await fetcher("/api/bot/link", {
    method: "POST",
    signal: AbortSignal.timeout(8_000),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ intent: "channel" }),
  });
  const body = await responseBody(response);
  if (!response.ok || !isRecord(body) || body.ok !== true || typeof body.url !== "string") {
    throw new Error(isRecord(body) && typeof body.error === "string" ? body.error : "bot_link_failed");
  }
  return { url: body.url, bot: status.bot, linkingAccount: !status.linked };
}

/** A reconnect changes updated_at even when Telegram confirms the same channel id. */
export function telegramChannelConnectionSnapshot(channels: TelegramChannelState[]): string {
  return channels
    .filter((channel) => channel.network === "tg")
    .map((channel) => [
      Number(channel.id),
      channel.is_active ? "1" : "0",
      String(channel.status || ""),
      String(channel.updated_at || ""),
    ].join(":"))
    .sort()
    .join("|");
}
