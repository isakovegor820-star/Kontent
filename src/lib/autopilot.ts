// Автопилот (Д.9). Общие помощники: настройки и постановка одобренного поста в ту же
// очередь публикации, что и ручные посты (Д.3) — те же надёжность, повторы, уведомления.

import { getPool } from "./db";
import { getPublishQueue, jobIdForPostRevision } from "./queue";
import { EMPTY_BRIEF, normalizeBrief, type Brief } from "./brief";

export interface AutopilotSettings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
}

/**
 * Канал, с которым сейчас работает автопилот.
 * Раньше по всему коду стояло «...is_active = true limit 1» — БЕЗ order by. При двух каналах
 * это значило: автопилот молча берёт какой-то один (какой — Postgres не обещает) и пишет туда
 * посты по брифу другого, а второй канал не получает ничего. Теперь канал выбирает человек,
 * а если не выбрал — берём самый ранний ЯВНО и предсказуемо.
 */
export async function resolveChannel(userId: number, wanted?: number | null): Promise<number | null> {
  const pool = getPool();
  if (wanted) {
    const own = await pool.query(
      `select id from channels where id = $1 and user_id = $2 and network = 'tg' and is_active = true`,
      [wanted, userId],
    );
    if (own.rowCount) return wanted;
    return null; // чужой или отключённый канал — молча подменять на свой нельзя
  }
  const r = await pool.query<{ id: string }>(
    `select id from channels where user_id = $1 and network = 'tg' and is_active = true
      order by id limit 1`,
    [userId],
  );
  // Number обязателен: id — bigint, а драйвер отдаёт bigint строкой. Без этого функция
  // возвращала бы то число (когда канал выбран), то строку (когда взят по умолчанию),
  // и сравнение id на клиенте ломалось бы ровно в одном из двух случаев.
  return r.rows[0] ? Number(r.rows[0].id) : null;
}

/** Бриф контента КАНАЛА. Нет строки — пустой бриф (значит, автопилот запускать нельзя). */
export async function loadBrief(userId: number, channelId: number): Promise<Brief> {
  const r = await getPool().query(
    `select niche, audience, rubrics, formats, author_role, goal, cta, taboo, profile_answers, quality, ready, source
       from content_brief where user_id = $1 and channel_id = $2`,
    [userId, channelId],
  );
  return r.rows[0] ? normalizeBrief(r.rows[0]) : { ...EMPTY_BRIEF };
}

/** Гарантирует строку настроек КАНАЛА и возвращает её. */
export async function ensureSettings(userId: number, channelId: number): Promise<AutopilotSettings> {
  const pool = getPool();
  await pool.query(
    `insert into autopilot_settings (user_id, channel_id) values ($1, $2)
     on conflict (user_id, channel_id) do nothing`,
    [userId, channelId],
  );
  const r = await pool.query<AutopilotSettings>(
    `select enabled, mode, post_frequency, approvals_streak
       from autopilot_settings where user_id = $1 and channel_id = $2`,
    [userId, channelId],
  );
  return r.rows[0];
}

/** Повторяемая доставка уже сохранённого post; `post-{id}` не допускает две BullMQ job. */
export async function enqueueAutopilotPost(
  postId: number,
  scheduledAt: string,
  scheduleRevision = 1,
): Promise<void> {
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  await getPublishQueue().add(
    "publish",
    { postId, scheduleRevision },
    { delay, jobId: jobIdForPostRevision(postId, scheduleRevision), removeOnComplete: true, removeOnFail: false },
  );
}

/** Legacy helper for non-checkpointed callers. Approval routes use the transactional outbox. */
export async function schedulePost(
  userId: number,
  channelId: number,
  text: string,
  scheduledAt: string,
): Promise<number> {
  const pool = getPool();
  const ins = await pool.query<{ id: number; schedule_revision: number | string }>(
    `insert into posts (user_id, channel_id, text, scheduled_at, status, publication_origin)
     values ($1, $2, $3, $4, 'scheduled', 'autopilot') returning id, schedule_revision`,
    [userId, channelId, text, scheduledAt],
  );
  const postId = ins.rows[0].id;
  try {
    await enqueueAutopilotPost(postId, scheduledAt, Number(ins.rows[0].schedule_revision || 1));
  } catch (error) {
    await pool.query(`delete from posts where id = $1 and status = 'scheduled'`, [postId]).catch(() => {});
    throw error;
  }
  return postId;
}
