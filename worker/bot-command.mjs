const TELEGRAM_COMMAND_PATTERN = /^\/([a-z0-9_]{1,32})(?:@([a-z0-9_]{5,32}))?(?:\s+([\s\S]*))?$/iu;

function normalizeUsername(value) {
  return String(value || "").replace(/^@/u, "").trim().toLowerCase();
}

/**
 * Parse a Telegram bot command without accepting prefix collisions such as
 * `/status-report`. Commands addressed to another bot are deliberately ignored.
 */
export function parseTelegramBotCommand(text, botUsername = null) {
  const source = String(text || "").trim();
  const match = TELEGRAM_COMMAND_PATTERN.exec(source);
  if (!match) return null;

  const target = normalizeUsername(match[2]);
  const configuredBot = normalizeUsername(botUsername);
  if (target && configuredBot && target !== configuredBot) return null;

  return {
    command: match[1].toLowerCase(),
    target: target || null,
    args: String(match[3] || "").trim(),
  };
}
