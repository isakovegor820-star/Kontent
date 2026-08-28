export interface BotLinkStatus {
  linked: boolean;
  bot: string | null;
  channelConnectUrl: string | null;
  botStatus: "up" | "down" | "not_configured" | "conflict";
}

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
