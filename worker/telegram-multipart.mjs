import {
  buildTelegramPayload,
  TELEGRAM_CAPTION_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  telegramEntityLength,
} from "../src/lib/telegram-payload.mjs";

export function telegramPartDefinitions({ hasAsset, text, forceSeparateMedia = false }) {
  return buildTelegramPayload({ hasAsset, text, forceSeparateMedia }).parts;
}

export async function deliverTelegramParts({
  parts,
  asset,
  sendText,
  sendAsset,
  markSending,
  markSent,
  markFailed,
  markUnknown,
}) {
  const completed = [];
  for (const part of parts) {
    if (part.send_status === "sent" && part.external_message_id) {
      completed.push(part);
      continue;
    }
    // A previous process may have sent this part before losing its response. Neither a
    // retry nor a restart may cross that ambiguity without provider reconciliation.
    if (part.send_status === "unknown" || part.send_status === "sending") {
      return {
        ok: false,
        parts: completed,
        reason: "Telegram не подтвердил ранее начатую отправку части",
        deliveryUnknown: true,
      };
    }
    const expectsText = part.part_type === "text" || part.part_type === "media_caption";
    const payloadHtml = expectsText ? String(part.payload_html || "") : null;
    const payloadLimit = part.part_type === "media_caption"
      ? TELEGRAM_CAPTION_LIMIT
      : TELEGRAM_TEXT_LIMIT;
    if (expectsText && (!payloadHtml || telegramEntityLength(payloadHtml) > payloadLimit)) {
      const response = { ok: false, description: "telegram_payload_invalid" };
      await markFailed(part, response);
      return {
        ok: false,
        parts: completed,
        reason: "telegram_payload_invalid",
        deliveryUnknown: false,
      };
    }
    await markSending(part);
    let response;
    try {
      response = part.part_type === "text"
        ? await sendText(payloadHtml)
        : await sendAsset(asset, part.part_type === "media_caption" ? payloadHtml : null);
    } catch (error) {
      await markUnknown(part, error);
      return {
        ok: false,
        parts: completed,
        reason: String(error?.message || "Telegram delivery unknown"),
        deliveryUnknown: true,
      };
    }
    const messageId = Number(response?.result?.message_id);
    if (!response?.ok || !Number.isSafeInteger(messageId) || messageId <= 0) {
      await markFailed(part, response);
      return {
        ok: false,
        parts: completed,
        reason: response?.description || "Telegram не подтвердил часть публикации",
        providerErrorCode: Number(response?.error_code) || null,
        retryAfterSeconds: Number(response?.parameters?.retry_after) || null,
        deliveryUnknown: false,
      };
    }
    completed.push(await markSent(part, String(messageId)));
  }
  return {
    ok: true,
    externalId: Number(completed[0]?.external_message_id),
    parts: completed,
  };
}
