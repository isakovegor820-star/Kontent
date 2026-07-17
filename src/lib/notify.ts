// Уведомления владельцу в Telegram-бот (тот же бот, что принимает заявки).
// Никогда не бросает исключение — уведомление не критично, важные данные уже в базе.

/**
 * Отправка владельцу. Возвращает true ТОЛЬКО если Telegram реально принял сообщение
 * (ok:true) — честный флаг доставки (надёжность из ТЗ). При сбое сети или ok:false —
 * одна повторная попытка, потом честно логируем ошибку и возвращаем false.
 * Здесь путь запроса, поэтому повтор короткий, чтобы не тормозить ответ.
 * Никогда не бросает: важные данные уже в базе, уведомление вторично.
 */
export async function notifyOwner(text: string): Promise<boolean> {
  const token = process.env.TG_BOT_TOKEN;
  const chatId = process.env.TG_CHAT_ID;
  if (!token || !chatId) return false; // бот не настроен — молча пропускаем

  const delays = [0, 1500]; // 2 попытки
  let lastErr = "";
  for (let attempt = 1; attempt <= delays.length; attempt++) {
    if (delays[attempt - 1]) await new Promise((r) => setTimeout(r, delays[attempt - 1]));
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: boolean; description?: string }
        | null;
      if (data?.ok) return true;
      lastErr = data?.description || `HTTP ${res.status}`;
    } catch (err) {
      lastErr = String((err as Error)?.message || err);
    }
  }
  console.error(`[notify] уведомление владельцу НЕ доставлено (${delays.length} попыток): ${lastErr}`);
  return false;
}

/** Московское время строкой — для уведомлений владельцу. */
export function nowMoscow(): string {
  return new Date().toLocaleString("ru-RU", { timeZone: "Europe/Moscow" });
}
