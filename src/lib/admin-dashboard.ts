import type { Pool } from "pg";
import type { DependencyState } from "./readiness";

export type AdminPeriodDays = 7 | 30;

export interface AdminSystemState {
  database: DependencyState;
  redis: DependencyState;
  publicationWorker: DependencyState;
  ai: "healthy" | "attention" | "unobserved" | "not_configured";
}

export interface AdminDashboardData {
  checkedAt: string;
  periodDays: AdminPeriodDays;
  summary: {
    usersTotal: number;
    activeUsers: number;
    newUsers: number;
    projectsTotal: number;
    publicationsTotal: number;
    publishedToday: number;
    scheduled: number;
    failed: number;
    quarantined: number;
    overdue: number;
    authAttention: number;
    aiToday: number;
    aiPeriod: number;
  };
  daily: Array<{
    date: string;
    registrations: number;
    publications: number;
    published: number;
    ai: number;
  }>;
  providers: Array<{
    network: string;
    total: number;
    active: number;
    attention: number;
    lastAuthErrorAt: string | null;
  }>;
  attention: Array<{
    id: number;
    project: string;
    projectId: number;
    author: string;
    authorId: number;
    channel: string;
    network: string;
    status: "failed" | "quarantined" | "overdue" | "auth";
    attempts: number;
    errorCode: string;
    text: string;
    scheduledAt: string | null;
    createdAt: string;
  }>;
  recentUsers: Array<{
    id: number;
    name: string;
    email: string | null;
    createdAt: string;
    projects: number;
    channels: number;
    publications: number;
    ai: number;
    botLinked: boolean;
  }>;
  audit: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    project: string;
    actor: string;
    createdAt: string;
  }>;
  system: AdminSystemState;
}

type Queryable = Pick<Pool, "query">;

type HeadlineRow = Record<
  | "users_total"
  | "active_users"
  | "new_users"
  | "projects_total"
  | "publications_total"
  | "published_today"
  | "scheduled"
  | "failed"
  | "quarantined"
  | "overdue"
  | "auth_attention"
  | "ai_today"
  | "ai_period",
  number | string | null
>;

function count(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : 0;
}

function positiveId(value: unknown): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 0;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value || ""));
  return Number.isFinite(date.getTime()) ? date.toISOString() : new Date(0).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

export function normalizeAdminPeriod(value: string | null): AdminPeriodDays {
  return value === "30" ? 30 : 7;
}

export async function loadAdminDashboard(
  db: Queryable,
  periodDays: AdminPeriodDays,
): Promise<Omit<AdminDashboardData, "checkedAt" | "system">> {
  const [headline, daily, providers, attention, users, audit] = await Promise.all([
    db.query<HeadlineRow>(
      `select
         (select count(*) from users) as users_total,
         (select count(distinct session.user_id) from sessions session where session.expires_at > now()) as active_users,
         (select count(*) from users app_user
           where app_user.created_at >= now() - make_interval(days => $1::int)) as new_users,
         (select count(*) from projects project where project.is_archived = false) as projects_total,
         (select count(*) from posts) as publications_total,
         (select count(*) from posts post
           where post.published_at >= date_trunc('day', now())) as published_today,
         (select count(*) from posts post where post.status = 'scheduled') as scheduled,
         (select count(*) from posts post
           where post.status = 'failed'
             and coalesce(post.scheduled_at, post.created_at) >= now() - make_interval(days => $1::int)) as failed,
         (select count(*) from posts post
           where post.quarantined_at is not null and post.status <> 'published') as quarantined,
         (select count(*) from posts post
           where post.status = 'scheduled' and post.scheduled_at < now() - interval '5 minutes') as overdue,
         (select count(*) from channels channel
           where channel.is_active = true and channel.status <> 'active') as auth_attention,
         (select count(*) from ai_usage usage
           where usage.status = 'committed' and usage.usage_date = current_date) as ai_today,
         (select count(*) from ai_usage usage
           where usage.status = 'committed'
             and usage.created_at >= now() - make_interval(days => $1::int)) as ai_period`,
      [periodDays],
    ),
    db.query<{
      day: Date | string;
      registrations: number | string;
      publications: number | string;
      published: number | string;
      ai: number | string;
    }>(
      `with days as (
         select generate_series(
           current_date - ($1::int - 1),
           current_date,
           interval '1 day'
         )::date as day
       )
       select days.day,
              (select count(*) from users app_user where app_user.created_at::date = days.day) as registrations,
              (select count(*) from posts post where post.created_at::date = days.day) as publications,
              (select count(*) from posts post where post.published_at::date = days.day) as published,
              (select count(*) from ai_usage usage
                where usage.status = 'committed' and usage.usage_date = days.day) as ai
         from days order by days.day`,
      [periodDays],
    ),
    db.query<{
      network: string;
      total: number | string;
      active: number | string;
      attention: number | string;
      last_auth_error_at: Date | string | null;
    }>(
      `select channel.network,
              count(*) as total,
              count(*) filter (where channel.is_active = true and channel.status = 'active') as active,
              count(*) filter (where channel.is_active = true and channel.status <> 'active') as attention,
              max(channel.last_auth_error_at) as last_auth_error_at
         from channels channel
        group by channel.network
        order by channel.network`,
    ),
    db.query<{
      id: number | string;
      project: string | null;
      project_id: number | string;
      author: string | null;
      author_id: number | string;
      channel: string | null;
      network: string;
      attention_status: "failed" | "quarantined" | "overdue" | "auth";
      attempts: number | string;
      error_code: string;
      text: string;
      scheduled_at: Date | string | null;
      created_at: Date | string;
    }>(
      `select post.id,
              project.name as project,
              project.id as project_id,
              coalesce(nullif(btrim(author.name), ''), author.email, 'Пользователь ' || author.id::text) as author,
              author.id as author_id,
              coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as channel,
              channel.network,
              case
                when channel.is_active = true and channel.status <> 'active' then 'auth'
                when post.quarantined_at is not null then 'quarantined'
                when post.status = 'scheduled' and post.scheduled_at < now() - interval '5 minutes' then 'overdue'
                else 'failed'
              end as attention_status,
              post.attempts,
              case
                when channel.is_active = true and channel.status <> 'active'
                  then coalesce(channel.last_auth_error_code, 'integration_reconnect_required')
                when post.quarantined_at is not null
                  then coalesce(post.quarantine_reason, 'publication_quarantined')
                when post.status = 'scheduled' and post.scheduled_at < now() - interval '5 minutes'
                  then 'publication_overdue'
                when post.verification_error_code is not null then post.verification_error_code
                else 'provider_error'
              end as error_code,
              left(regexp_replace(post.text, '\\s+', ' ', 'g'), 180) as text,
              post.scheduled_at,
              post.created_at
         from posts post
         join channels channel on channel.id = post.channel_id and channel.project_id = post.project_id
         join projects project on project.id = post.project_id
         join users author on author.id = post.user_id
        where post.status = 'failed'
           or post.quarantined_at is not null
           or (post.status = 'scheduled' and post.scheduled_at < now() - interval '5 minutes')
           or (channel.is_active = true and channel.status <> 'active')
        order by
          case
            when channel.is_active = true and channel.status <> 'active' then 1
            when post.quarantined_at is not null then 2
            when post.status = 'failed' then 3
            else 4
          end,
          coalesce(post.scheduled_at, post.created_at) desc
        limit 40`,
    ),
    db.query<{
      id: number | string;
      name: string | null;
      email: string | null;
      created_at: Date | string;
      projects: number | string;
      channels: number | string;
      publications: number | string;
      ai: number | string;
      bot_linked: boolean;
    }>(
      `select app_user.id,
              coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as name,
              app_user.email,
              app_user.created_at,
              (select count(*) from project_members member
                where member.user_id = app_user.id and member.status = 'active') as projects,
              (select count(*) from channels channel
                where channel.user_id = app_user.id and channel.is_active = true) as channels,
              (select count(*) from posts post
                where post.user_id = app_user.id
                  and post.created_at >= now() - make_interval(days => $1::int)) as publications,
              (select count(*) from ai_usage usage
                where usage.user_id = app_user.id and usage.status = 'committed'
                  and usage.created_at >= now() - make_interval(days => $1::int)) as ai,
              app_user.tg_chat_id is not null as bot_linked
         from users app_user
        order by app_user.created_at desc, app_user.id desc
        limit 12`,
      [periodDays],
    ),
    db.query<{
      id: number | string;
      action: string;
      entity_type: string;
      entity_id: string | null;
      project: string;
      actor: string | null;
      created_at: Date | string;
    }>(
      `select event.id, event.action, event.entity_type, event.entity_id,
              project.name as project,
              coalesce(nullif(btrim(actor.name), ''), actor.email, 'Системное действие') as actor,
              event.created_at
         from audit_events event
         join projects project on project.id = event.project_id
         left join users actor on actor.id = event.actor_user_id
        order by event.created_at desc, event.id desc
        limit 16`,
    ),
  ]);

  const totals = headline.rows[0] ?? {} as HeadlineRow;
  return {
    periodDays,
    summary: {
      usersTotal: count(totals.users_total),
      activeUsers: count(totals.active_users),
      newUsers: count(totals.new_users),
      projectsTotal: count(totals.projects_total),
      publicationsTotal: count(totals.publications_total),
      publishedToday: count(totals.published_today),
      scheduled: count(totals.scheduled),
      failed: count(totals.failed),
      quarantined: count(totals.quarantined),
      overdue: count(totals.overdue),
      authAttention: count(totals.auth_attention),
      aiToday: count(totals.ai_today),
      aiPeriod: count(totals.ai_period),
    },
    daily: daily.rows.map((row) => ({
      date: iso(row.day).slice(0, 10),
      registrations: count(row.registrations),
      publications: count(row.publications),
      published: count(row.published),
      ai: count(row.ai),
    })),
    providers: providers.rows.map((row) => ({
      network: row.network,
      total: count(row.total),
      active: count(row.active),
      attention: count(row.attention),
      lastAuthErrorAt: nullableIso(row.last_auth_error_at),
    })),
    attention: attention.rows.map((row) => ({
      id: positiveId(row.id),
      project: row.project || "Проект",
      projectId: positiveId(row.project_id),
      author: row.author || "Пользователь",
      authorId: positiveId(row.author_id),
      channel: row.channel || "Канал",
      network: row.network,
      status: row.attention_status,
      attempts: count(row.attempts),
      errorCode: row.error_code,
      text: row.text || "Публикация без текста",
      scheduledAt: nullableIso(row.scheduled_at),
      createdAt: iso(row.created_at),
    })),
    recentUsers: users.rows.map((row) => ({
      id: positiveId(row.id),
      name: row.name || "Пользователь",
      email: row.email,
      createdAt: iso(row.created_at),
      projects: count(row.projects),
      channels: count(row.channels),
      publications: count(row.publications),
      ai: count(row.ai),
      botLinked: row.bot_linked === true,
    })),
    audit: audit.rows.map((row) => ({
      id: positiveId(row.id),
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      project: row.project,
      actor: row.actor || "Системное действие",
      createdAt: iso(row.created_at),
    })),
  };
}
