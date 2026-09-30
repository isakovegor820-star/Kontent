// Единая очистка Telegram-бота credential перед отправкой событий в Sentry.
// Общий бот живёт в path API-запросов (/bot<id>:<token>/<method>); SDK сохраняет
// этот URL в breadcrumbs/errors, а sendDefaultPii не вычищает path-сегмент.
// Радиус утечки — все каналы этого бота, поэтому credential обязан удаляться
// до формирования envelope во всех рантаймах (worker/server/edge).
//
// Модуль намеренно без зависимостей: его импортируют конфиги Sentry во всех
// рантаймах, включая edge-бандл.

// Запрещено только соседство с другой цифрой: в URL токен следует сразу за
// "bot" (буквы), а в тексте ошибки может начинать строку.
export const TG_BOT_CREDENTIAL_PATTERN = /(?<![0-9])([0-9]{6,10}:[A-Za-z0-9_-]{20,60})\b/g;

/** Удаляет credential из строки. */
export function redactBotCredential(value) {
  return typeof value === "string"
    ? value.replace(TG_BOT_CREDENTIAL_PATTERN, "[tg-credential-redacted]")
    : value;
}

/**
 * Рекурсивно заменяет credential в строковых полях объекта/массива (in place),
 * с защитой от циклов. Возвращает тот же объект.
 */
export function redactBotCredentialsDeep(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (typeof item === "string") value[index] = redactBotCredential(item);
      else redactBotCredentialsDeep(item, seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    const item = value[key];
    if (typeof item === "string") value[key] = redactBotCredential(item);
    else redactBotCredentialsDeep(item, seen);
  }
  return value;
}
