import {
  buildTelegramCarouselParts,
  TELEGRAM_CAPTION_LIMIT,
  telegramEntityLength,
} from "../src/lib/telegram-payload.mjs";
import { deliverTelegramParts } from "./telegram-multipart.mjs";

export function telegramCarouselPartDefinitions({ assets, text }) {
  if (!Array.isArray(assets)) throw new Error("telegram_carousel_asset_count_invalid");
  return buildTelegramCarouselParts({ assetCount: assets.length, text });
}

export async function deliverTelegramCarousel({
  parts,
  assets,
  sendGroup,
  sendText,
  markSending,
  markSent,
  markFailed,
  markUnknown,
}) {
  const mediaParts = parts.filter((part) => part.part_type === "media");
  const textParts = parts.filter((part) => part.part_type === "text");
  if (mediaParts.length !== assets.length || mediaParts.length < 3 || mediaParts.length > 7) {
    return { ok: false, reason: "telegram_carousel_plan_invalid", deliveryUnknown: false };
  }
  const completedMedia = mediaParts.filter((part) => part.send_status === "sent" && part.external_message_id);
  const ambiguous = mediaParts.some((part) => part.send_status === "sending" || part.send_status === "unknown")
    || (completedMedia.length > 0 && completedMedia.length !== mediaParts.length);
  if (ambiguous) {
    return {
      ok: false,
      reason: "Telegram не подтвердил ранее начатую отправку карусели",
      deliveryUnknown: true,
      parts: completedMedia,
    };
  }
  let completed = completedMedia;
  if (completedMedia.length === 0) {
    const caption = mediaParts[0]?.payload_html ? String(mediaParts[0].payload_html) : null;
    if (caption && telegramEntityLength(caption) > TELEGRAM_CAPTION_LIMIT) {
      await Promise.all(mediaParts.map((part) => markFailed(part, { description: "telegram_payload_invalid" })));
      return { ok: false, reason: "telegram_payload_invalid", deliveryUnknown: false, parts: [] };
    }
    await Promise.all(mediaParts.map((part) => markSending(part)));
    let response;
    try {
      response = await sendGroup(assets, caption);
    } catch (error) {
      await Promise.all(mediaParts.map((part) => markUnknown(part, error).catch(() => null)));
      return {
        ok: false,
        reason: String(error?.message || "Telegram delivery unknown"),
        deliveryUnknown: true,
        parts: [],
      };
    }
    const messages = Array.isArray(response?.result) ? response.result : [];
    const messageIds = messages.map((message) => Number(message?.message_id));
    if (!response?.ok || messageIds.length !== mediaParts.length
      || messageIds.some((messageId) => !Number.isSafeInteger(messageId) || messageId <= 0)) {
      await Promise.all(mediaParts.map((part) => markFailed(part, response)));
      return {
        ok: false,
        reason: response?.description || "Telegram не подтвердил карусель",
        providerErrorCode: Number(response?.error_code) || null,
        retryAfterSeconds: Number(response?.parameters?.retry_after) || null,
        deliveryUnknown: false,
        parts: [],
      };
    }
    try {
      completed = [];
      for (let index = 0; index < mediaParts.length; index += 1) {
        completed.push(await markSent(mediaParts[index], String(messageIds[index])));
      }
    } catch (error) {
      return {
        ok: false,
        reason: String(error?.message || "carousel_receipt_persist_failed"),
        deliveryUnknown: true,
        parts: completed,
      };
    }
  }

  const textResult = await deliverTelegramParts({
    parts: textParts,
    asset: null,
    sendText,
    sendAsset: async () => ({ ok: false, description: "unexpected_media_part" }),
    markSending,
    markSent,
    markFailed,
    markUnknown,
  });
  if (!textResult.ok) return { ...textResult, parts: [...completed, ...(textResult.parts || [])] };
  return {
    ok: true,
    externalId: Number(completed[0]?.external_message_id),
    parts: [...completed, ...(textResult.parts || [])],
  };
}
