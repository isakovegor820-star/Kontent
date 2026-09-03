function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TypeError(`telegram stats channel: bad ${field}`);
  }
  return id;
}

function telegramChatId(value) {
  const normalized = String(value ?? "").trim();
  if (!/^-?\d+$/u.test(normalized) || normalized === "0") {
    throw new TypeError("telegram stats channel: bad chatId");
  }
  return normalized;
}

function telegramHandle(value) {
  return String(value || "").replace(/^@/u, "").trim().slice(0, 64) || null;
}

/**
 * Refresh the public username from Telegram before reading t.me/s/<username>.
 * Channels connected before a username was assigned (or renamed afterwards) can
 * otherwise keep a null/stale handle forever while the public feed is healthy.
 */
export async function resolveTelegramStatsHandle(db, channel, getChat) {
  const channelId = positiveId(channel?.id, "channelId");
  const projectId = positiveId(channel?.project_id, "projectId");
  const chatId = telegramChatId(channel?.tg_chat_id);
  const savedHandle = telegramHandle(channel?.handle);

  let response;
  try {
    response = await getChat(chatId);
  } catch {
    return { handle: savedHandle, refreshed: false, source: "saved" };
  }

  const liveHandle = response?.ok === true
    ? telegramHandle(response.result?.username)
    : null;
  if (!liveHandle) {
    return { handle: savedHandle, refreshed: false, source: "saved" };
  }
  if (liveHandle === savedHandle) {
    return { handle: liveHandle, refreshed: false, source: "telegram" };
  }

  await db.query(
    `update channels
        set handle = $1, updated_at = now()
      where id = $2 and project_id = $3
        and network = 'tg' and is_active = true`,
    [liveHandle, channelId, projectId],
  );
  return { handle: liveHandle, refreshed: true, source: "telegram" };
}
