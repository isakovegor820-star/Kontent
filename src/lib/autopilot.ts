// Автопилот (Д.9). Общие помощники: настройки и постановка одобренного поста в ту же
// очередь публикации, что и ручные посты (Д.3) — те же надёжность, повторы, уведомления.

import { getPool } from "./db";
import { getPublishQueue, jobIdForPostRevision } from "./queue";
import { EMPTY_BRIEF, normalizeBrief, type Brief } from "./brief";
import { requireSelectedProjectPermission } from "./project-permissions";
import {
  DEFAULT_AUTOPILOT_ENGINE,
  DEFAULT_AUTOPILOT_PLANNING_WEEKS,
} from "./autopilot-config.mjs";
import type { AutopilotNewsSource } from "./autopilot-news.mjs";
import type { AutopilotQuickSettings } from "./autopilot-style.mjs";
import { DEFAULT_AUTOPILOT_QUICK_SETTINGS } from "./autopilot-style.mjs";

export interface AutopilotSettings {
  enabled: boolean;
  mode: "confirm" | "full";
  post_frequency: number;
  approvals_streak: number;
  generation_engine: string;
  planning_months: number;
  planning_weeks: number;
  news_sources: AutopilotNewsSource[];
  quick_settings: AutopilotQuickSettings;
}

/**
 * The project is the tenant boundary. `actorUserId` is retained only for audit fields on
 * newly-created rows; it must never be used to decide which channel/project data is visible.
 */
export interface AutopilotProjectScope {
  actorUserId: number;
  projectId: number;
}

function isProjectScope(value: number | AutopilotProjectScope): value is AutopilotProjectScope {
  return typeof value === "object" && value !== null;
}

/**
 * Канал, с которым сейчас работает автопилот.
 * Раньше по всему коду стояло «...is_active = true limit 1» — БЕЗ order by. При двух каналах
 * это значило: автопилот молча берёт какой-то один (какой — Postgres не обещает) и пишет туда
 * посты по брифу другого, а второй канал не получает ничего. Теперь канал выбирает человек,
 * а если не выбрал — берём самый ранний ЯВНО и предсказуемо.
 */
export async function resolveChannel(
  scope: AutopilotProjectScope,
  wanted?: number | null,
): Promise<number | null>;
/** Compatibility overload: resolves the server-owned selected project before reading a channel. */
export async function resolveChannel(userId: number, wanted?: number | null): Promise<number | null>;
export async function resolveChannel(
  scopeOrUserId: number | AutopilotProjectScope,
  wanted?: number | null,
): Promise<number | null> {
  const pool = getPool();
  if (isProjectScope(scopeOrUserId)) {
    if (wanted) {
      const selected = await pool.query(
        `select id from channels
          where id = $1 and project_id = $2 and network = 'tg' and is_active = true`,
        [wanted, scopeOrUserId.projectId],
      );
      return selected.rowCount ? wanted : null;
    }
    const selected = await pool.query<{ id: string }>(
      `select id from channels
        where project_id = $1 and network = 'tg' and is_active = true
        order by id limit 1`,
      [scopeOrUserId.projectId],
    );
    return selected.rows[0] ? Number(selected.rows[0].id) : null;
  }

  const membership = await requireSelectedProjectPermission(pool, scopeOrUserId, "project.read");
  return resolveChannel(
    { actorUserId: scopeOrUserId, projectId: membership.projectId },
    wanted,
  );
}

/** Бриф контента КАНАЛА. Нет строки — пустой бриф (значит, автопилот запускать нельзя). */
export async function loadBrief(scope: AutopilotProjectScope, channelId: number): Promise<Brief>;
/** Compatibility overload: resolves the server-owned selected project before reading a brief. */
export async function loadBrief(userId: number, channelId: number): Promise<Brief>;
export async function loadBrief(
  scopeOrUserId: number | AutopilotProjectScope,
  channelId: number,
): Promise<Brief> {
  if (!isProjectScope(scopeOrUserId)) {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, scopeOrUserId, "project.read");
    return loadBrief(
      { actorUserId: scopeOrUserId, projectId: membership.projectId },
      channelId,
    );
  }
  const r = await getPool().query(
    `select niche, audience, rubrics, formats, author_role, goal, cta, taboo,
            profile_answers, quality, ready, source
       from content_brief
      where project_id = $1 and channel_id = $2
      order by updated_at desc, user_id
      limit 1`,
    [scopeOrUserId.projectId, channelId],
  );
  return r.rows[0] ? normalizeBrief(r.rows[0]) : { ...EMPTY_BRIEF };
}

/** Гарантирует строку настроек КАНАЛА и возвращает её. */
export async function ensureSettings(
  scope: AutopilotProjectScope,
  channelId: number,
): Promise<AutopilotSettings>;
/** Compatibility overload: resolves the server-owned selected project before ensuring settings. */
export async function ensureSettings(userId: number, channelId: number): Promise<AutopilotSettings>;
export async function ensureSettings(
  scopeOrUserId: number | AutopilotProjectScope,
  channelId: number,
): Promise<AutopilotSettings> {
  const pool = getPool();
  if (isProjectScope(scopeOrUserId)) {
    const existing = await pool.query<AutopilotSettings>(
      `select enabled, mode, post_frequency, approvals_streak, generation_engine,
              planning_months, planning_weeks, news_sources, quick_settings
         from autopilot_settings
        where project_id = $1 and channel_id = $2
        order by updated_at desc, user_id
        limit 1`,
      [scopeOrUserId.projectId, channelId],
    );
    if (existing.rows[0]) return existing.rows[0];

    await pool.query(
      `insert into autopilot_settings
         (project_id, user_id, channel_id, generation_engine, planning_months, planning_weeks,
          post_frequency, mode, quick_settings)
       select $1, $2, $3, $4, 1, $5, 5, 'confirm', $6::jsonb
        where exists (
          select 1 from channels
           where id = $3 and project_id = $1 and network = 'tg' and is_active = true
        )
       on conflict (project_id, channel_id) do nothing`,
      [
        scopeOrUserId.projectId,
        scopeOrUserId.actorUserId,
        channelId,
        DEFAULT_AUTOPILOT_ENGINE,
        DEFAULT_AUTOPILOT_PLANNING_WEEKS,
        JSON.stringify(DEFAULT_AUTOPILOT_QUICK_SETTINGS),
      ],
    );
    const created = await pool.query<AutopilotSettings>(
      `select enabled, mode, post_frequency, approvals_streak, generation_engine,
              planning_months, planning_weeks, news_sources, quick_settings
         from autopilot_settings
        where project_id = $1 and channel_id = $2
        order by updated_at desc, user_id
        limit 1`,
      [scopeOrUserId.projectId, channelId],
    );
    if (!created.rows[0]) throw new Error("autopilot channel settings unavailable");
    return created.rows[0];
  }

  const membership = await requireSelectedProjectPermission(pool, scopeOrUserId, "project.read");
  return ensureSettings(
    { actorUserId: scopeOrUserId, projectId: membership.projectId },
    channelId,
  );
}

/** Повторяемая доставка уже сохранённого post; `post-{id}` не допускает две BullMQ job. */
export async function enqueueAutopilotPost(
  projectId: number,
  postId: number,
  scheduledAt: string,
  scheduleRevision = 1,
): Promise<void> {
  const delay = Math.max(0, new Date(scheduledAt).getTime() - Date.now());
  await getPublishQueue().add(
    "publish",
    { projectId, postId, scheduleRevision },
    { delay, jobId: jobIdForPostRevision(postId, scheduleRevision), removeOnComplete: true, removeOnFail: false },
  );
}

/** Legacy helper for non-checkpointed callers. Approval routes use the transactional outbox. */
export async function schedulePost(
  scope: AutopilotProjectScope,
  channelId: number,
  text: string,
  scheduledAt: string,
): Promise<number> {
  const pool = getPool();
  const ins = await pool.query<{ id: number; schedule_revision: number | string }>(
    `insert into posts
       (project_id, user_id, channel_id, text, scheduled_at, status, publication_origin)
     select $1, $2, $3, $4, $5, 'scheduled', 'autopilot'
      where exists (
        select 1 from channels
         where id = $3 and project_id = $1 and network = 'tg' and is_active = true
      )
     returning id, schedule_revision`,
    [scope.projectId, scope.actorUserId, channelId, text, scheduledAt],
  );
  if (!ins.rows[0]) throw new Error("autopilot channel unavailable");
  const postId = ins.rows[0].id;
  try {
    await enqueueAutopilotPost(
      scope.projectId,
      postId,
      scheduledAt,
      Number(ins.rows[0].schedule_revision || 1),
    );
  } catch (error) {
    await pool.query(
      `delete from posts where id = $1 and project_id = $2 and status = 'scheduled'`,
      [postId, scope.projectId],
    ).catch(() => {});
    throw error;
  }
  return postId;
}
