import { readTelegramResponse } from "./telegram-response.mjs";
/** Read-only Telegram connection checks share one deadline, including response bodies. */
export const TELEGRAM_CONNECT_DEADLINE_MS = 8_000;
export class TelegramConnectError extends Error {
  constructor(code, status, retryAfter = null) {
    super(code);
    this.name = "TelegramConnectError";
    this.code = code;
    this.status = status;
    this.retryAfter = retryAfter;
  }
}

export async function verifyTelegramChannelActor(input) {
  const { token, actorId, chatRef, signal, fetcher = fetch } = input;
  if (!/^\d+:.+$/u.test(String(token || ""))) throw new TelegramConnectError("bot_not_configured", 503);
  if (!Number.isSafeInteger(Number(actorId)) || Number(actorId) <= 0) {
    throw new TelegramConnectError("telegram_identity_required", 403);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort("deadline"), input.deadlineMs ?? TELEGRAM_CONNECT_DEADLINE_MS);
  const cancel = () => controller.abort("cancelled");
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) cancel();
  const cancelled = new Promise((_, reject) => {
    const abort = () => reject(new TelegramConnectError(controller.signal.reason === "deadline" ? "provider_timeout" : "request_cancelled", controller.signal.reason === "deadline" ? 504 : 408));
    controller.signal.addEventListener("abort", abort, { once: true });
    if (controller.signal.aborted) abort();
  });
  const tg = async (method, params) => {
    const response = await fetcher(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", cache: "no-store", signal: controller.signal,
      headers: { "content-type": "application/json" }, body: JSON.stringify(params),
    });
    let body;
    try { body = await readTelegramResponse(response); } catch { throw new TelegramConnectError("provider_invalid_response", 502); }
    if (response.status === 429 || body?.error_code === 429) {
      const seconds = Number(body?.parameters?.retry_after);
      throw new TelegramConnectError("provider_rate_limited", 429, Number.isSafeInteger(seconds) && seconds > 0 ? seconds : 30);
    }
    if (response.status >= 500 || Number(body?.error_code) >= 500) throw new TelegramConnectError("provider_unavailable", 503);
    if (response.status === 401 || body?.error_code === 401) throw new TelegramConnectError("bot_credentials_invalid", 503);
    if (body?.ok !== true) {
      if (body?.error_code === 400 || body?.error_code === 403) throw new TelegramConnectError("no_access", 422);
      throw new TelegramConnectError("provider_invalid_response", 502);
    }
    if (!response.ok || !body.result || typeof body.result !== "object") throw new TelegramConnectError("provider_invalid_response", 502);
    return body.result;
  };
  try {
    return await Promise.race([cancelled, (async () => {
      const chat = await tg("getChat", { chat_id: chatRef });
      if (chat.type !== "channel" || !Number.isSafeInteger(chat.id) || chat.id >= 0) throw new TelegramConnectError("not_channel", 422);
      const bot = await tg("getChatMember", { chat_id: chat.id, user_id: Number(token.split(":")[0]) });
      if (bot.status !== "administrator" || bot.can_post_messages !== true) throw new TelegramConnectError("not_admin", 422);
      const actor = await tg("getChatMember", { chat_id: chat.id, user_id: Number(actorId) });
      if (actor.status !== "creator" && !(actor.status === "administrator" && actor.can_post_messages === true)) {
        throw new TelegramConnectError("telegram_actor_not_admin", 403);
      }
      return chat;
    })()]);
  } catch (error) {
    if (error instanceof TelegramConnectError) throw error;
    throw new TelegramConnectError("provider_unavailable", 503);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
  }
}
