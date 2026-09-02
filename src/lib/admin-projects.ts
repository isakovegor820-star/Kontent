import type { Pool } from "pg";

import type { AdminPeriodDays } from "./admin-dashboard";

type Queryable = Pick<Pool, "query">;

export const ADMIN_PROJECT_STATUS_FILTERS = ["all", "active", "attention", "inactive", "archived", "personal", "team"] as const;
export type AdminProjectStatusFilter = (typeof ADMIN_PROJECT_STATUS_FILTERS)[number];
export const ADMIN_PROJECT_SORTS = ["activity_desc", "created_desc", "posts_desc", "members_desc"] as const;
export type AdminProjectSort = (typeof ADMIN_PROJECT_SORTS)[number];

export interface AdminProjectsQuery {
  days: AdminPeriodDays;
  query: string;
  status: AdminProjectStatusFilter;
  network: string;
  sort: AdminProjectSort;
  page: number;
  pageSize: number;
}

export interface AdminProjectListItem {
  id: number;
  name: string;
  timezone: string;
  personal: boolean;
  archived: boolean;
  createdAt: string;
  ownerId: number | null;
  owner: string | null;
  members: number;
  channels: number;
  activeChannels: number;
  channelAttention: number;
  networks: string[];
  postsTotal: number;
  postsPeriod: number;
  publishedPeriod: number;
  scheduled: number;
  failedPeriod: number;
  lastActivityAt: string | null;
  botEnabled: boolean;
  autopilotEnabled: boolean;
}

export interface AdminProjectsResponse {
  periodDays: AdminPeriodDays;
  summary: {
    projects: number;
    active: number;
    team: number;
    archived: number;
    withChannels: number;
    attention: number;
    newPeriod: number;
  };
  projects: AdminProjectListItem[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}

export interface AdminProjectDetail {
  periodDays: AdminPeriodDays;
  project: {
    id: number;
    name: string;
    timezone: string;
    personal: boolean;
    archived: boolean;
    createdAt: string;
    version: number;
    botEnabled: boolean;
    botDisabledReason: string | null;
    autopilotEnabled: boolean;
    autopilotMode: string | null;
  };
  summary: {
    members: number;
    channels: number;
    activeChannels: number;
    channelAttention: number;
    postsTotal: number;
    postsPeriod: number;
    publishedPeriod: number;
    scheduled: number;
    failedPeriod: number;
    drafts: number;
    aiPeriod: number;
  };
  activity: Array<{ date: string; posts: number; published: number; failed: number }>;
  members: Array<{
    userId: number;
    name: string;
    email: string | null;
    role: string;
    status: string;
    joinedAt: string;
    lastSignedInAt: string | null;
    postsPeriod: number;
    botLinked: boolean;
  }>;
  channels: Array<{
    id: number;
    network: string;
    title: string;
    handle: string | null;
    active: boolean;
    status: string;
    createdAt: string;
    lastAuthErrorCode: string | null;
    lastAuthErrorAt: string | null;
    posts: number;
    published: number;
    scheduled: number;
    failed: number;
    subscribers: number | null;
  }>;
  posts: Array<{
    id: number;
    channel: string;
    network: string;
    authorId: number;
    author: string;
    status: string;
    origin: string;
    text: string;
    safeErrorCode: string | null;
    attempts: number;
    scheduledAt: string | null;
    publishedAt: string | null;
    createdAt: string;
  }>;
  audit: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    actor: string;
    createdAt: string;
  }>;
}

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((item) => String(item)) : [];
}

export function normalizeAdminProjectsQuery(params: URLSearchParams): AdminProjectsQuery {
  const statusValue = params.get("status") ?? "all";
  const sortValue = params.get("sort") ?? "activity_desc";
  const network = String(params.get("network") ?? "all").trim().toLowerCase();
  const page = Number(params.get("page") ?? "1");
  return {
    days: params.get("days") === "30" ? 30 : 7,
    query: String(params.get("query") ?? params.get("q") ?? "").trim().slice(0, 200),
    status: ADMIN_PROJECT_STATUS_FILTERS.includes(statusValue as AdminProjectStatusFilter) ? statusValue as AdminProjectStatusFilter : "all",
    network: /^[a-z0-9_-]{1,32}$/u.test(network) ? network : "all",
    sort: ADMIN_PROJECT_SORTS.includes(sortValue as AdminProjectSort) ? sortValue as AdminProjectSort : "activity_desc",
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 10_000) : 1,
    pageSize: 25,
  };
}

const ORDER_BY: Record<AdminProjectSort, string> = {
  activity_desc: "base.last_activity_at desc nulls last, base.id desc",
  created_desc: "base.created_at desc, base.id desc",
  posts_desc: "base.posts_period desc, base.last_activity_at desc nulls last, base.id desc",
  members_desc: "base.members desc, base.last_activity_at desc nulls last, base.id desc",
};

export async function loadAdminProjects(db: Queryable, input: AdminProjectsQuery): Promise<AdminProjectsResponse> {
  const offset = (input.page - 1) * input.pageSize;
  const search = `%${input.query.replace(/[%_\\]/gu, (char) => `\\${char}`)}%`;
  const [summary, rows] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select
         count(*) as projects,
         count(*) filter (where project.is_archived = false) as active,
         count(*) filter (where project.is_archived = false and project.personal_owner_user_id is null) as team,
         count(*) filter (where project.is_archived) as archived,
         count(*) filter (where exists (select 1 from channels channel where channel.project_id = project.id and channel.is_active)) as with_channels,
         count(*) filter (where exists (
           select 1 from channels channel where channel.project_id = project.id and channel.is_active and channel.status <> 'active'
         ) or exists (
           select 1 from posts post where post.project_id = project.id and post.status in ('failed','quarantined')
             and coalesce(post.scheduled_at, post.created_at) >= now() - make_interval(days => $1::int)
         )) as attention,
         count(*) filter (where project.created_at >= now() - make_interval(days => $1::int)) as new_period
       from projects project`,
      [input.days],
    ),
    db.query<Record<string, unknown>>(
      `with member_rollup as (
         select member.project_id,
                count(*) filter (where member.status = 'active') as members
           from project_members member group by member.project_id
       ), channel_rollup as (
         select channel.project_id,
                count(*) as channels,
                count(*) filter (where channel.is_active) as active_channels,
                count(*) filter (where channel.is_active and channel.status <> 'active') as channel_attention,
                array_agg(distinct channel.network order by channel.network) filter (where channel.is_active) as networks
           from channels channel group by channel.project_id
       ), post_rollup as (
         select post.project_id,
                count(*) as posts_total,
                count(*) filter (where post.created_at >= now() - make_interval(days => $1::int)) as posts_period,
                count(*) filter (where post.published_at >= now() - make_interval(days => $1::int)) as published_period,
                count(*) filter (where post.status = 'scheduled') as scheduled,
                count(*) filter (where post.status in ('failed','failed_retry','quarantined')
                  and coalesce(post.scheduled_at, post.created_at) >= now() - make_interval(days => $1::int)) as failed_period,
                max(coalesce(post.published_at, post.created_at)) as last_post_at
           from posts post group by post.project_id
       ), owner_rollup as (
         select distinct on (member.project_id) member.project_id, owner.id as owner_id,
                coalesce(nullif(btrim(owner.name), ''), owner.email, 'Пользователь ' || owner.id::text) as owner
           from project_members member
           join users owner on owner.id = member.user_id
          where member.role = 'owner' and member.status = 'active'
          order by member.project_id, member.joined_at
       ), autopilot_rollup as (
         select settings.project_id, bool_or(settings.enabled) as autopilot_enabled
           from autopilot_settings settings where settings.project_id is not null group by settings.project_id
       ), base as (
         select project.id, project.name, project.timezone, project.is_archived, project.created_at,
                project.personal_owner_user_id is not null as personal,
                owner_rollup.owner_id, owner_rollup.owner,
                coalesce(member_rollup.members, 0) as members,
                coalesce(channel_rollup.channels, 0) as channels,
                coalesce(channel_rollup.active_channels, 0) as active_channels,
                coalesce(channel_rollup.channel_attention, 0) as channel_attention,
                coalesce(channel_rollup.networks, array[]::text[]) as networks,
                coalesce(post_rollup.posts_total, 0) as posts_total,
                coalesce(post_rollup.posts_period, 0) as posts_period,
                coalesce(post_rollup.published_period, 0) as published_period,
                coalesce(post_rollup.scheduled, 0) as scheduled,
                coalesce(post_rollup.failed_period, 0) as failed_period,
                greatest(project.created_at, post_rollup.last_post_at) as last_activity_at,
                coalesce(bot.enabled, true) as bot_enabled,
                coalesce(autopilot_rollup.autopilot_enabled, false) as autopilot_enabled
           from projects project
           left join member_rollup on member_rollup.project_id = project.id
           left join channel_rollup on channel_rollup.project_id = project.id
           left join post_rollup on post_rollup.project_id = project.id
           left join owner_rollup on owner_rollup.project_id = project.id
           left join bot_project_controls bot on bot.project_id = project.id
           left join autopilot_rollup on autopilot_rollup.project_id = project.id
       ), filtered as (
         select base.* from base
          where ($2::text = '' or base.id::text = $2 or base.name ilike $3 or coalesce(base.owner, '') ilike $3)
            and ($4::text = 'all'
              or ($4 = 'active' and base.is_archived = false)
              or ($4 = 'archived' and base.is_archived)
              or ($4 = 'personal' and base.personal)
              or ($4 = 'team' and base.personal = false)
              or ($4 = 'attention' and (base.channel_attention > 0 or base.failed_period > 0))
              or ($4 = 'inactive' and base.is_archived = false and base.posts_period = 0
                  and base.last_activity_at < now() - make_interval(days => $1::int)))
            and ($5::text = 'all' or $5 = any(base.networks))
       )
       select base.*, count(*) over() as filtered_total
         from filtered base
        order by ${ORDER_BY[input.sort]}
        limit $6 offset $7`,
      [input.days, input.query, search, input.status, input.network, input.pageSize, offset],
    ),
  ]);

  const totals = summary.rows[0] ?? {};
  const total = count(rows.rows[0]?.filtered_total);
  return {
    periodDays: input.days,
    summary: {
      projects: count(totals.projects),
      active: count(totals.active),
      team: count(totals.team),
      archived: count(totals.archived),
      withChannels: count(totals.with_channels),
      attention: count(totals.attention),
      newPeriod: count(totals.new_period),
    },
    projects: rows.rows.map((row) => ({
      id: positiveId(row.id),
      name: String(row.name || "Проект"),
      timezone: String(row.timezone || "UTC"),
      personal: row.personal === true,
      archived: row.is_archived === true,
      createdAt: iso(row.created_at),
      ownerId: row.owner_id == null ? null : positiveId(row.owner_id),
      owner: row.owner == null ? null : String(row.owner),
      members: count(row.members),
      channels: count(row.channels),
      activeChannels: count(row.active_channels),
      channelAttention: count(row.channel_attention),
      networks: stringArray(row.networks),
      postsTotal: count(row.posts_total),
      postsPeriod: count(row.posts_period),
      publishedPeriod: count(row.published_period),
      scheduled: count(row.scheduled),
      failedPeriod: count(row.failed_period),
      lastActivityAt: nullableIso(row.last_activity_at),
      botEnabled: row.bot_enabled !== false,
      autopilotEnabled: row.autopilot_enabled === true,
    })),
    pagination: { page: input.page, pageSize: input.pageSize, total, pages: Math.max(1, Math.ceil(total / input.pageSize)) },
  };
}

export async function loadAdminProjectDetail(
  db: Queryable,
  projectId: number,
  days: AdminPeriodDays,
): Promise<AdminProjectDetail | null> {
  if (!Number.isSafeInteger(projectId) || projectId <= 0) return null;
  const project = await db.query<Record<string, unknown>>(
    `select project.id, project.name, project.timezone, project.is_archived, project.created_at, project.version,
            project.personal_owner_user_id is not null as personal,
            coalesce(bot.enabled, true) as bot_enabled, bot.disabled_reason,
            (select bool_or(settings.enabled) from autopilot_settings settings where settings.project_id = project.id) as autopilot_enabled,
            (select settings.mode from autopilot_settings settings
              where settings.project_id = project.id and settings.enabled order by settings.user_id limit 1) as autopilot_mode
       from projects project
       left join bot_project_controls bot on bot.project_id = project.id
      where project.id = $1`,
    [projectId],
  );
  const row = project.rows[0];
  if (!row) return null;

  const [summary, activity, members, channels, posts, audit] = await Promise.all([
    db.query<Record<string, unknown>>(
      `select
         (select count(*) from project_members member where member.project_id = $1 and member.status = 'active') as members,
         (select count(*) from channels channel where channel.project_id = $1) as channels,
         (select count(*) from channels channel where channel.project_id = $1 and channel.is_active) as active_channels,
         (select count(*) from channels channel where channel.project_id = $1 and channel.is_active and channel.status <> 'active') as channel_attention,
         (select count(*) from posts post where post.project_id = $1) as posts_total,
         (select count(*) from posts post where post.project_id = $1 and post.created_at >= now() - make_interval(days => $2::int)) as posts_period,
         (select count(*) from posts post where post.project_id = $1 and post.published_at >= now() - make_interval(days => $2::int)) as published_period,
         (select count(*) from posts post where post.project_id = $1 and post.status = 'scheduled') as scheduled,
         (select count(*) from posts post where post.project_id = $1 and post.status in ('failed','failed_retry','quarantined')
            and coalesce(post.scheduled_at, post.created_at) >= now() - make_interval(days => $2::int)) as failed_period,
         (select count(*) from drafts draft where draft.project_id = $1 and draft.purpose <> 'source_context') as drafts,
         (select count(*) from ai_usage usage
            join project_members member on member.user_id = usage.user_id and member.project_id = $1 and member.status = 'active'
           where usage.status = 'committed' and usage.created_at >= now() - make_interval(days => $2::int)) as ai_period`,
      [projectId, days],
    ),
    db.query<{ day: Date | string; posts: unknown; published: unknown; failed: unknown }>(
      `with days as (
         select generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date as day
       )
       select days.day,
              (select count(*) from posts post where post.project_id = $1 and post.created_at::date = days.day) as posts,
              (select count(*) from posts post where post.project_id = $1 and post.published_at::date = days.day) as published,
              (select count(*) from posts post where post.project_id = $1 and post.status in ('failed','quarantined')
                 and coalesce(post.scheduled_at, post.created_at)::date = days.day) as failed
         from days order by days.day`,
      [projectId, days],
    ),
    db.query<Record<string, unknown>>(
      `select member.user_id, member.role, member.status, member.joined_at,
              coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as name,
              app_user.email, app_user.tg_chat_id is not null as bot_linked,
              (select max(app_session.created_at) from sessions app_session where app_session.user_id = member.user_id) as last_signed_in_at,
              (select count(*) from posts post where post.project_id = $1 and post.user_id = member.user_id
                 and post.created_at >= now() - make_interval(days => $2::int)) as posts_period
         from project_members member
         join users app_user on app_user.id = member.user_id
        where member.project_id = $1
        order by (member.status = 'active') desc, (member.role = 'owner') desc, member.joined_at`,
      [projectId, days],
    ),
    db.query<Record<string, unknown>>(
      `select channel.id, channel.network, channel.is_active, channel.status, channel.created_at,
              channel.last_auth_error_code, channel.last_auth_error_at,
              coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as title,
              channel.handle,
              (select count(*) from posts post where post.channel_id = channel.id) as posts,
              (select count(*) from posts post where post.channel_id = channel.id and post.status = 'published') as published,
              (select count(*) from posts post where post.channel_id = channel.id and post.status = 'scheduled') as scheduled,
              (select count(*) from posts post where post.channel_id = channel.id and post.status in ('failed','failed_retry','quarantined')) as failed,
              (select channel_stats.subscribers from channel_stats
                where channel_stats.channel_id = channel.id order by channel_stats.snapshot_date desc limit 1) as subscribers
         from channels channel
        where channel.project_id = $1
        order by channel.is_active desc, channel.created_at desc`,
      [projectId],
    ),
    db.query<Record<string, unknown>>(
      `select post.id, post.status, post.publication_origin as origin, post.attempts,
              post.scheduled_at, post.published_at, post.created_at,
              left(regexp_replace(post.text, '\\s+', ' ', 'g'), 180) as text,
              case when post.status in ('failed','failed_retry','quarantined','missing','deleted_external','published_unverified')
                   then coalesce(post.verification_error_code, post.quarantine_reason, 'provider_error') end as safe_error_code,
              channel.network,
              coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as channel,
              author.id as author_id,
              coalesce(nullif(btrim(author.name), ''), author.email, 'Пользователь ' || author.id::text) as author
         from posts post
         join channels channel on channel.id = post.channel_id
         join users author on author.id = post.user_id
        where post.project_id = $1
        order by coalesce(post.published_at, post.scheduled_at, post.created_at) desc, post.id desc
        limit 25`,
      [projectId],
    ),
    db.query<Record<string, unknown>>(
      `select event.id, event.action, event.entity_type, event.entity_id, event.created_at,
              coalesce(nullif(btrim(actor.name), ''), actor.email, 'Системное действие') as actor
         from audit_events event
         left join users actor on actor.id = event.actor_user_id
        where event.project_id = $1
        order by event.created_at desc, event.id desc
        limit 20`,
      [projectId],
    ),
  ]);

  const totals = summary.rows[0] ?? {};
  return {
    periodDays: days,
    project: {
      id: positiveId(row.id),
      name: String(row.name || "Проект"),
      timezone: String(row.timezone || "UTC"),
      personal: row.personal === true,
      archived: row.is_archived === true,
      createdAt: iso(row.created_at),
      version: count(row.version),
      botEnabled: row.bot_enabled !== false,
      botDisabledReason: row.disabled_reason == null ? null : String(row.disabled_reason),
      autopilotEnabled: row.autopilot_enabled === true,
      autopilotMode: row.autopilot_mode == null ? null : String(row.autopilot_mode),
    },
    summary: {
      members: count(totals.members),
      channels: count(totals.channels),
      activeChannels: count(totals.active_channels),
      channelAttention: count(totals.channel_attention),
      postsTotal: count(totals.posts_total),
      postsPeriod: count(totals.posts_period),
      publishedPeriod: count(totals.published_period),
      scheduled: count(totals.scheduled),
      failedPeriod: count(totals.failed_period),
      drafts: count(totals.drafts),
      aiPeriod: count(totals.ai_period),
    },
    activity: activity.rows.map((item) => ({
      date: iso(item.day).slice(0, 10),
      posts: count(item.posts),
      published: count(item.published),
      failed: count(item.failed),
    })),
    members: members.rows.map((member) => ({
      userId: positiveId(member.user_id),
      name: String(member.name),
      email: member.email == null ? null : String(member.email),
      role: String(member.role),
      status: String(member.status),
      joinedAt: iso(member.joined_at),
      lastSignedInAt: nullableIso(member.last_signed_in_at),
      postsPeriod: count(member.posts_period),
      botLinked: member.bot_linked === true,
    })),
    channels: channels.rows.map((channel) => ({
      id: positiveId(channel.id),
      network: String(channel.network),
      title: String(channel.title),
      handle: channel.handle == null ? null : String(channel.handle),
      active: channel.is_active === true,
      status: String(channel.status || "active"),
      createdAt: iso(channel.created_at),
      lastAuthErrorCode: channel.last_auth_error_code == null ? null : String(channel.last_auth_error_code),
      lastAuthErrorAt: nullableIso(channel.last_auth_error_at),
      posts: count(channel.posts),
      published: count(channel.published),
      scheduled: count(channel.scheduled),
      failed: count(channel.failed),
      subscribers: channel.subscribers == null ? null : count(channel.subscribers),
    })),
    posts: posts.rows.map((post) => ({
      id: positiveId(post.id),
      channel: String(post.channel),
      network: String(post.network),
      authorId: positiveId(post.author_id),
      author: String(post.author),
      status: String(post.status),
      origin: String(post.origin || "manual"),
      text: String(post.text || "Публикация без текста"),
      safeErrorCode: post.safe_error_code == null ? null : String(post.safe_error_code),
      attempts: count(post.attempts),
      scheduledAt: nullableIso(post.scheduled_at),
      publishedAt: nullableIso(post.published_at),
      createdAt: iso(post.created_at),
    })),
    audit: audit.rows.map((event) => ({
      id: positiveId(event.id),
      action: String(event.action),
      entityType: String(event.entity_type),
      entityId: event.entity_id == null ? null : String(event.entity_id),
      actor: String(event.actor || "Системное действие"),
      createdAt: iso(event.created_at),
    })),
  };
}
