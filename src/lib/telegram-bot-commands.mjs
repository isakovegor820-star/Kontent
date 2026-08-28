/** Commands shown by Telegram's native slash-command menu. */
export const TELEGRAM_BOT_COMMANDS = Object.freeze([
  { command: "menu", description: "Открыть главный экран" },
  { command: "status", description: "Проверить подключение" },
  { command: "connect", description: "Проверить связь и подключить канал" },
  { command: "projects", description: "Выбрать текущий проект" },
  { command: "today", description: "Публикации и задачи на сегодня" },
  { command: "create", description: "Создать новую публикацию" },
  { command: "approvals", description: "Тексты на согласовании" },
  { command: "problems", description: "Что требует внимания" },
  { command: "results", description: "Результаты последних постов" },
  { command: "calendar", description: "Ближайшие публикации" },
  { command: "stats", description: "Цифры канала за неделю" },
  { command: "notifications", description: "Настроить уведомления" },
  { command: "disconnect", description: "Отключить этот чат" },
  { command: "cancel", description: "Закрыть текущий диалог" },
  { command: "help", description: "Что я умею" },
]);

export function telegramBotCommandsReady(value) {
  if (!Array.isArray(value)) return false;
  const actual = value.map((item) => String(item?.command || "").trim());
  const expected = TELEGRAM_BOT_COMMANDS.map((item) => item.command);
  return actual.length === expected.length && expected.every((command, index) => actual[index] === command);
}
