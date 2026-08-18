export type TelegramBotCommand = Readonly<{ command: string; description: string }>;
export const TELEGRAM_BOT_COMMANDS: readonly TelegramBotCommand[];
export function telegramBotCommandsReady(value: unknown): boolean;
