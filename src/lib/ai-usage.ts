// Учёт генераций ИИ и дневной лимит (ТЗ Д.8, ТЗ 12 — честный лимит с видимым счётчиком).
// Лимит на пользователя в сутки. Для локального движка он щедрый, но механика та же,
// что и для платного облака — сменим движок, не трогая продукт.

import { getPool } from "./db";

export const AI_DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT || 30);

/** Сколько генераций пользователь потратил сегодня. */
export async function aiUsedToday(userId: number): Promise<number> {
  const r = await getPool().query<{ n: number }>(
    `select count(*)::int as n from ai_usage where user_id = $1 and usage_date = current_date`,
    [userId],
  );
  return r.rows[0]?.n ?? 0;
}

/** Записать факт генерации (одна строка = одна генерация). */
export async function recordAiUsage(userId: number, kind: string): Promise<void> {
  await getPool().query(`insert into ai_usage (user_id, kind) values ($1, $2)`, [userId, kind]);
}

/** Последние посты пользователя как образец стиля для ИИ (ТЗ Д.8: 5–10 прошлых постов). */
export async function styleSamplesFor(userId: number): Promise<string[]> {
  const r = await getPool().query<{ text: string }>(
    `select text from posts
      where user_id = $1 and status = 'published' and length(trim(text)) > 0
      order by published_at desc nulls last
      limit 10`,
    [userId],
  );
  return r.rows.map((x) => x.text);
}
