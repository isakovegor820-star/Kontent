import { classifyTelegramDelivery } from "../src/lib/telegram-response.mjs";
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
    if (part.send_status === "sent" && Number.isSafeInteger(Number(part.external_message_id))
      && Number(part.external_message_id) > 0) {
      completed.push(part);
      continue;
    }
    // A previous process may have sent this part before losing its response. Neither a
    // retry nor a restart may cross that ambiguity without provider reconciliation.
    if (!["pending", "failed"].includes(part.send_status)) {
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
    const claimed = await markSending(part);
    if (claimed === false || claimed?.rowCount === 0) {
      return { ok: false, parts: completed, reason: "telegram_part_claim_lost", deliveryUnknown: true };
    }
    let response;
    try {
      response = part.part_type === "text"
        ? await sendText(payloadHtml)
        : await sendAsset(asset, part.part_type === "media_caption" ? payloadHtml : null);
    } catch (error) {
      await markUnknown(part, error).catch(() => null);
      return {
        ok: false,
        parts: completed,
        reason: String(error?.message || "Telegram delivery unknown"),
        deliveryUnknown: true,
      };
    }
    const outcome = classifyTelegramDelivery(response);
    if (outcome.kind === "unknown") {
      await markUnknown(part, response).catch(() => null);
      return { ok: false, parts: completed, reason: "telegram_receipt_unconfirmed", deliveryUnknown: true };
    }
    if (outcome.kind === "rejected") {
      await markFailed(part, response);
      return {
        ok: false,
        parts: completed,
        reason: response?.description || "Telegram не подтвердил часть публикации",
        providerErrorCode: outcome.providerErrorCode,
        retryAfterSeconds: outcome.retryAfterSeconds,
        deliveryUnknown: false,
      };
    }
    try {
      const receipt = await markSent(part, String(outcome.messageIds[0]));
      if (!receipt) throw new Error("telegram_receipt_persist_failed");
      completed.push(receipt);
    } catch (error) {
      // The durable sending marker survives even if the database is still unavailable.
      await markUnknown(part, error).catch(() => null);
      return { ok: false, parts: completed, reason: "telegram_receipt_persist_failed", deliveryUnknown: true };
    }
  }
  return {
    ok: true,
    externalId: Number(completed[0]?.external_message_id),
    parts: completed,
  };
}
