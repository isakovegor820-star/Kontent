const INTERACTION_TYPES = new Set([
  "command",
  "reply_button",
  "callback",
  "message",
  "voice",
  "attachment",
]);

function positiveId(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function safeSegment(value, fallback) {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 48);
  return normalized || fallback;
}

/**
 * Classifies a private Telegram message without retaining its text. The result is
 * intentionally bounded to a small vocabulary that is safe to show in admin telemetry.
 */
export function botMessageInteraction({
  command,
  replyAction,
  hasVoice = false,
  hasAttachment = false,
} = {}) {
  if (command) return { type: "command", action: safeSegment(command, "unknown") };
  if (replyAction) return { type: "reply_button", action: safeSegment(replyAction, "unknown") };
  if (hasVoice) return { type: "voice", action: "voice_message" };
  if (hasAttachment) return { type: "attachment", action: "media_attachment" };
  return { type: "message", action: "free_text" };
}

/** Callback payloads may contain entity ids or one-time tokens after the first two
 * segments. Persist only the public namespace and action, never the payload tail. */
export function botCallbackInteraction(data) {
  const [namespace, action] = String(data || "").split(":", 2);
  return {
    type: "callback",
    action: `${safeSegment(namespace, "unknown")}:${safeSegment(action, "open")}`,
  };
}

export async function recordBotInteraction(db, input) {
  const telegramUpdateId = Number(input?.telegramUpdateId);
  const type = String(input?.type || "");
  const action = String(input?.action || "").trim().slice(0, 100);
  if (!Number.isSafeInteger(telegramUpdateId) || telegramUpdateId < 0) return false;
  if (!INTERACTION_TYPES.has(type) || !action) return false;

  await db.query(
    `insert into bot_interaction_events
       (telegram_update_id, user_id, project_id, interaction_type, action)
     values (
       $1,
       $2,
       (select preference.selected_project_id
          from user_project_preferences preference
         where preference.user_id = $2),
       $3,
       $4
     )
     on conflict (telegram_update_id) do nothing`,
    [telegramUpdateId, positiveId(input?.userId), type, action],
  );
  return true;
}
