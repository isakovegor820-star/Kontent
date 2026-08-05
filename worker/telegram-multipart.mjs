export function telegramPartDefinitions({ hasAsset, formattedLength }) {
  if (!hasAsset) return [{ index: 0, type: "text" }];
  if (Number(formattedLength) <= 900) return [{ index: 0, type: "media_caption" }];
  return [{ index: 0, type: "media" }, { index: 1, type: "text" }];
}

export async function deliverTelegramParts({
  parts,
  formatted,
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
    await markSending(part);
    let response;
    try {
      response = part.part_type === "text"
        ? await sendText(formatted)
        : await sendAsset(asset, part.part_type === "media_caption" ? formatted : null);
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
