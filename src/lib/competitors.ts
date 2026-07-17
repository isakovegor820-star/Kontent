// Разведка конкурентов (Д.6). Только открытые Telegram-каналы. Лимит — 20 на пользователя.

export const MAX_COMPETITORS = 20;

/**
 * Достаёт @username публичного канала из ссылки/строки. Отсекает приватные ссылки
 * (joinchat, t.me/+hash) — по ним открытых данных нет. Возвращает handle или код ошибки.
 */
export function parseHandle(input: string): { handle?: string; error?: string } {
  let s = String(input ?? "").trim();
  if (!s) return { error: "empty" };

  s = s.replace(/^https?:\/\//i, "").replace(/^(t\.me|telegram\.me)\//i, "");
  s = s.replace(/^s\//i, ""); // t.me/s/<канал> — превью-ссылка
  s = s.replace(/^@/, "");
  s = s.split(/[/?#]/)[0].trim().toLowerCase();

  if (!s || s.startsWith("+") || s === "joinchat") return { error: "private" };
  if (!/^[a-z][a-z0-9_]{3,31}$/.test(s)) return { error: "bad" };
  return { handle: s };
}

/** Человеческий текст ошибки разбора ссылки — для интерфейса. */
export function handleErrorText(error?: string): string {
  switch (error) {
    case "empty":
      return "Вставь ссылку на Telegram-канал — например, t.me/durov или @durov.";
    case "private":
      return "Это приватная ссылка. Досье собирается только по публичным каналам — их видно без вступления.";
    case "bad":
      return "Не похоже на адрес канала. Проверь ссылку: t.me/имя_канала или @имя_канала.";
    default:
      return "Не получилось разобрать ссылку. Попробуй ещё раз.";
  }
}
