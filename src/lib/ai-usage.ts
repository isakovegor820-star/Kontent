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

/** Последние посты выбранного канала как образец стиля для ИИ (ТЗ Д.8: 5–10 постов). */
export async function styleSamplesFor(userId: number, channelId?: number | null): Promise<string[]> {
  const r = await getPool().query<{ text: string }>(
    `select text from posts
      where user_id = $1
        and ($2::bigint is null or channel_id = $2)
        and status = 'published' and length(trim(text)) > 0
      order by published_at desc nulls last
      limit 10`,
    [userId, channelId ?? null],
  );
  return r.rows.map((x) => x.text);
}

export interface ChannelAiContext {
  id: number;
  title: string;
  network: string;
  profile: string;
  facts: string[];
  styleSamples: string[];
}

/**
 * Контекст именно выбранного канала. Чужой/отключённый id не подменяем первым попавшимся:
 * это защита от смешивания голосов двух брендов в одном аккаунте.
 */
export async function channelAiContextFor(
  userId: number,
  wantedChannelId?: number | null,
): Promise<ChannelAiContext | null> {
  const pool = getPool();
  const channel = wantedChannelId
    ? (
        await pool.query<{ id: string; title: string | null; handle: string | null; network: string }>(
          `select id, title, handle, network
             from channels
            where id = $1 and user_id = $2 and is_active = true`,
          [wantedChannelId, userId],
        )
      ).rows[0]
    : (
        await pool.query<{ id: string; title: string | null; handle: string | null; network: string }>(
          `select id, title, handle, network
             from channels
            where user_id = $1 and is_active = true
            order by id
            limit 1`,
          [userId],
        )
      ).rows[0];

  if (!channel) return null;
  const channelId = Number(channel.id);
  const profile = (
    await pool.query<{ raw_text: string }>(
      `select raw_text
         from knowledge_sources
        where user_id = $1 and channel_id = $2 and kind in ('profile_edit', 'profile')
        order by case when kind = 'profile_edit' then 0 else 1 end, added_at desc
        limit 1`,
      [userId, channelId],
    )
  ).rows[0]?.raw_text;
  const facts = (
    await pool.query<{ raw_text: string }>(
      `select raw_text
         from knowledge_sources
        where user_id = $1 and channel_id = $2 and kind in ('form', 'paste') and status = 'ready'
        order by added_at desc
        limit 4`,
      [userId, channelId],
    )
  ).rows.map((row) => row.raw_text.trim()).filter(Boolean);

  return {
    id: channelId,
    title: channel.title || channel.handle || `Канал ${channelId}`,
    network: channel.network,
    profile: String(profile || "").trim().slice(0, 5000),
    facts: facts.map((fact) => fact.slice(0, 3000)),
    styleSamples: await styleSamplesFor(userId, channelId),
  };
}
