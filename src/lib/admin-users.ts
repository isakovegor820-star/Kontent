import type { Pool } from "pg";

import type { AdminPeriodDays } from "./admin-dashboard";

export type AdminUserStatusFilter = "all" | "active" | "attention" | "new" | "onboarding";
export type AdminUserSort = "registered_desc" | "activity_desc" | "posts_desc" | "ai_desc";

export interface AdminUsersQuery {
  days: AdminPeriodDays;
  query: string;
  status: AdminUserStatusFilter;
  network: string;
  sort: AdminUserSort;
  page: number;
  pageSize: number;
}

export interface AdminUserListItem {
  id: number;
  name: string;
  email: string | null;
  createdAt: string;
  onboardingCompleted: boolean;
  botLinked: boolean;
  auth: {
    email: boolean;
    password: boolean;
    telegram: boolean;
    vk: boolean;
  };
  activeSessions: number;
  lastSignedInAt: string | null;
  lastActivityAt: string;
  projects: number;
  ownedProjects: number;
  roles: string[];
  channels: number;
  activeChannels: number;
  channelAttention: number;
  networks: string[];
  postsTotal: number;
  postsPeriod: number;
  publishedPeriod: number;
  scheduled: number;
  failedPeriod: number;
  drafts: number;
  lastPostAt: string | null;
  aiTotal: number;
  aiPeriod: number;
  lastAiAt: string | null;
}

export interface AdminUsersResponse {
  periodDays: AdminPeriodDays;
  summary: {
    accounts: number;
    newAccounts: number;
    activeAccounts: number;
    onboardingComplete: number;
    botLinked: number;
    withChannels: number;
  };
  users: AdminUserListItem[];
  pagination: {
    page: number;
    pageSize: number;
    total: number;
    pages: number;
  };
}

export interface AdminUserDetail {
  periodDays: AdminPeriodDays;
  user: {
    id: number;
    name: string;
    email: string | null;
    createdAt: string;
    onboardingCompletedAt: string | null;
    botLinked: boolean;
    aiEngine: string | null;
    auth: {
      email: boolean;
      password: boolean;
      telegram: boolean;
      vk: boolean;
    };
    lastActivityAt: string;
  };
  summary: {
    projects: number;
    channels: number;
    activeChannels: number;
    channelAttention: number;
    posts: number;
    postsPeriod: number;
    published: number;
    scheduled: number;
    failed: number;
    drafts: number;
    quarantined: number;
    aiTotal: number;
    aiPeriod: number;
    aiToday: number;
    sessions: number;
    activeSessions: number;
  };
  activity: Array<{
    date: string;
    posts: number;
    published: number;
    ai: number;
  }>;
  projects: Array<{
    id: number;
    name: string;
    timezone: string;
    role: string;
    status: string;
    personal: boolean;
    archived: boolean;
    joinedAt: string;
    members: number;
    channels: number;
    posts: number;
  }>;
  channels: Array<{
    id: number;
    projectId: number;
    project: string;
    network: string;
    title: string;
    handle: string | null;
    active: boolean;
    status: string;
    createdAt: string;
    lastAuthErrorCode: string | null;
    lastAuthErrorAt: string | null;
    subscribers: number | null;
    subscribersDelta: number | null;
    posts: number;
    published: number;
    scheduled: number;
    failed: number;
    drafts: number;
    lastPublishedAt: string | null;
  }>;
  posts: Array<{
    id: number;
    project: string;
    channel: string;
    network: string;
    text: string;
    status: string;
    origin: string;
    attempts: number;
    hasMedia: boolean;
    safeErrorCode: string | null;
    verificationState: string;
    createdAt: string;
    scheduledAt: string | null;
    publishedAt: string | null;
    views: number | null;
    reactions: number | null;
    comments: number | null;
  }>;
  aiKinds: Array<{
    kind: string;
    total: number;
    period: number;
  }>;
  recentAi: Array<{
    id: number;
    kind: string;
    contentType: string | null;
    createdAt: string;
  }>;
  sessions: Array<{
    device: string;
    createdAt: string;
    expiresAt: string;
    active: boolean;
  }>;
  audit: Array<{
    id: number;
    action: string;
    entityType: string;
    entityId: string | null;
    project: string;
    createdAt: string;
  }>;
}

type Queryable = Pick<Pool, "query">;

const NETWORKS = new Set(["all", "tg", "vk", "instagram", "youtube", "x", "tiktok", "linkedin"]);
const STATUSES = new Set<AdminUserStatusFilter>(["all", "active", "attention", "new", "onboarding"]);
const SORTS = new Set<AdminUserSort>(["registered_desc", "activity_desc", "posts_desc", "ai_desc"]);

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

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
}

function nullableCount(value: unknown): number | null {
  return value == null ? null : count(value);
}

export function normalizeAdminUsersQuery(params: URLSearchParams): AdminUsersQuery {
  const rawPage = Number(params.get("page"));
  const rawStatus = params.get("status") as AdminUserStatusFilter | null;
  const rawSort = params.get("sort") as AdminUserSort | null;
  const rawNetwork = String(params.get("network") || "all").trim().toLowerCase();
  return {
    days: params.get("days") === "30" ? 30 : 7,
    query: String(params.get("query") || "").trim().slice(0, 120),
    status: rawStatus && STATUSES.has(rawStatus) ? rawStatus : "all",
    network: NETWORKS.has(rawNetwork) ? rawNetwork : "all",
    sort: rawSort && SORTS.has(rawSort) ? rawSort : "activity_desc",
    page: Number.isSafeInteger(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1,
    pageSize: 25,
  };
}

const ORDER_BY: Record<AdminUserSort, string> = {
  registered_desc: "created_at desc, id desc",
  activity_desc: "last_activity_at desc, id desc",
  posts_desc: "posts_period desc, last_activity_at desc, id desc",
  ai_desc: "ai_period desc, last_activity_at desc, id desc",
};

interface ListRow {
  id: unknown;
  name: string | null;
  email: string | null;
  created_at: unknown;
  onboarding_completed: boolean;
  bot_linked: boolean;
  email_login: boolean;
  password_login: boolean;
  telegram_login: boolean;
  vk_login: boolean;
  active_sessions: unknown;
  last_signed_in_at: unknown;
  last_activity_at: unknown;
  projects: unknown;
  owned_projects: unknown;
  roles: unknown;
  channels: unknown;
  active_channels: unknown;
  channel_attention: unknown;
  networks: unknown;
  posts_total: unknown;
  posts_period: unknown;
  published_period: unknown;
  scheduled: unknown;
  failed_period: unknown;
  drafts: unknown;
  last_post_at: unknown;
  ai_total: unknown;
  ai_period: unknown;
  last_ai_at: unknown;
  filtered_total: unknown;
}

export async function loadAdminUsers(db: Queryable, input: AdminUsersQuery): Promise<AdminUsersResponse> {
  const search = input.query ? `%${input.query}%` : "";
  const offset = (input.page - 1) * input.pageSize;
  const [summary, rows] = await Promise.all([
    db.query<{
      accounts: unknown;
      new_accounts: unknown;
      active_accounts: unknown;
      onboarding_complete: unknown;
      bot_linked: unknown;
      with_channels: unknown;
    }>(
      `select
         count(*) as accounts,
         count(*) filter (where app_user.created_at >= now() - make_interval(days => $1::int)) as new_accounts,
         count(*) filter (where exists (
           select 1 from sessions app_session
            where app_session.user_id = app_user.id and app_session.expires_at > now()
         )) as active_accounts,
         count(*) filter (where app_user.onboarding_completed_at is not null) as onboarding_complete,
         count(*) filter (where app_user.tg_chat_id is not null) as bot_linked,
         count(*) filter (where exists (
           select 1 from channels channel where channel.user_id = app_user.id
         )) as with_channels
       from users app_user`,
      [input.days],
    ),
    db.query<ListRow>(
      `with session_rollup as (
         select app_session.user_id,
                count(*) filter (where app_session.expires_at > now()) as active_sessions,
                max(app_session.created_at) as last_signed_in_at
           from sessions app_session group by app_session.user_id
       ), member_rollup as (
         select member.user_id,
                count(*) filter (where member.status = 'active') as projects,
                count(*) filter (where member.status = 'active' and member.role = 'owner') as owned_projects,
                array_agg(distinct member.role order by member.role) filter (where member.status = 'active') as roles
           from project_members member group by member.user_id
       ), channel_rollup as (
         select channel.user_id,
                count(*) as channels,
                count(*) filter (where channel.is_active) as active_channels,
                count(*) filter (where channel.is_active and channel.status <> 'active') as channel_attention,
                array_agg(distinct channel.network order by channel.network) filter (where channel.is_active) as networks
           from channels channel group by channel.user_id
       ), post_rollup as (
         select post.user_id,
                count(*) as posts_total,
                count(*) filter (where post.created_at >= now() - make_interval(days => $1::int)) as posts_period,
                count(*) filter (where post.published_at >= now() - make_interval(days => $1::int)) as published_period,
                count(*) filter (where post.status = 'scheduled') as scheduled,
                count(*) filter (where (post.status in ('failed', 'failed_retry', 'quarantined')
                    or post.quarantined_at is not null)
                  and post.created_at >= now() - make_interval(days => $1::int)) as failed_period,
                count(*) filter (where post.status = 'draft') as drafts,
                max(coalesce(post.published_at, post.created_at)) as last_post_at
           from posts post group by post.user_id
       ), ai_rollup as (
         select usage.user_id,
                count(*) filter (where usage.status = 'committed') as ai_total,
                count(*) filter (where usage.status = 'committed'
                  and usage.created_at >= now() - make_interval(days => $1::int)) as ai_period,
                max(usage.created_at) filter (where usage.status = 'committed') as last_ai_at
           from ai_usage usage group by usage.user_id
       ), base as (
         select app_user.id,
                coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as name,
                app_user.email,
                app_user.created_at,
                app_user.onboarding_completed_at is not null as onboarding_completed,
                app_user.tg_chat_id is not null as bot_linked,
                app_user.email is not null as email_login,
                app_user.password_hash is not null as password_login,
                app_user.tg_id is not null as telegram_login,
                app_user.vk_id is not null as vk_login,
                coalesce(session_rollup.active_sessions, 0) as active_sessions,
                session_rollup.last_signed_in_at,
                greatest(app_user.created_at, session_rollup.last_signed_in_at,
                  post_rollup.last_post_at, ai_rollup.last_ai_at) as last_activity_at,
                coalesce(member_rollup.projects, 0) as projects,
                coalesce(member_rollup.owned_projects, 0) as owned_projects,
                coalesce(member_rollup.roles, array[]::text[]) as roles,
                coalesce(channel_rollup.channels, 0) as channels,
                coalesce(channel_rollup.active_channels, 0) as active_channels,
                coalesce(channel_rollup.channel_attention, 0) as channel_attention,
                coalesce(channel_rollup.networks, array[]::text[]) as networks,
                coalesce(post_rollup.posts_total, 0) as posts_total,
                coalesce(post_rollup.posts_period, 0) as posts_period,
                coalesce(post_rollup.published_period, 0) as published_period,
                coalesce(post_rollup.scheduled, 0) as scheduled,
                coalesce(post_rollup.failed_period, 0) as failed_period,
                coalesce(post_rollup.drafts, 0) as drafts,
                post_rollup.last_post_at,
                coalesce(ai_rollup.ai_total, 0) as ai_total,
                coalesce(ai_rollup.ai_period, 0) as ai_period,
                ai_rollup.last_ai_at
           from users app_user
           left join session_rollup on session_rollup.user_id = app_user.id
           left join member_rollup on member_rollup.user_id = app_user.id
           left join channel_rollup on channel_rollup.user_id = app_user.id
           left join post_rollup on post_rollup.user_id = app_user.id
           left join ai_rollup on ai_rollup.user_id = app_user.id
       ), filtered as (
         select base.* from base
          where ($2::text = '' or base.id::text = $2 or base.name ilike $3 or coalesce(base.email, '') ilike $3
            or exists (
              select 1 from project_members member
              join projects project on project.id = member.project_id
              where member.user_id = base.id and project.name ilike $3
            ))
            and ($4::text = 'all'
              or ($4 = 'active' and base.active_sessions > 0)
              or ($4 = 'attention' and (base.channel_attention > 0 or base.failed_period > 0))
              or ($4 = 'new' and base.created_at >= now() - make_interval(days => $1::int))
              or ($4 = 'onboarding' and base.onboarding_completed = false))
            and ($5::text = 'all' or $5 = any(base.networks))
       )
       select filtered.*, count(*) over() as filtered_total
         from filtered
        order by ${ORDER_BY[input.sort]}
        limit $6 offset $7`,
      [input.days, input.query, search, input.status, input.network, input.pageSize, offset],
    ),
  ]);

  const headline = summary.rows[0];
  const total = rows.rows.length > 0 ? count(rows.rows[0].filtered_total) : 0;
  return {
    periodDays: input.days,
    summary: {
      accounts: count(headline?.accounts),
      newAccounts: count(headline?.new_accounts),
      activeAccounts: count(headline?.active_accounts),
      onboardingComplete: count(headline?.onboarding_complete),
      botLinked: count(headline?.bot_linked),
      withChannels: count(headline?.with_channels),
    },
    users: rows.rows.map((row) => ({
      id: positiveId(row.id),
      name: row.name || `Пользователь ${positiveId(row.id)}`,
      email: row.email,
      createdAt: iso(row.created_at),
      onboardingCompleted: row.onboarding_completed === true,
      botLinked: row.bot_linked === true,
      auth: {
        email: row.email_login === true,
        password: row.password_login === true,
        telegram: row.telegram_login === true,
        vk: row.vk_login === true,
      },
      activeSessions: count(row.active_sessions),
      lastSignedInAt: nullableIso(row.last_signed_in_at),
      lastActivityAt: iso(row.last_activity_at),
      projects: count(row.projects),
      ownedProjects: count(row.owned_projects),
      roles: strings(row.roles),
      channels: count(row.channels),
      activeChannels: count(row.active_channels),
      channelAttention: count(row.channel_attention),
      networks: strings(row.networks),
      postsTotal: count(row.posts_total),
      postsPeriod: count(row.posts_period),
      publishedPeriod: count(row.published_period),
      scheduled: count(row.scheduled),
      failedPeriod: count(row.failed_period),
      drafts: count(row.drafts),
      lastPostAt: nullableIso(row.last_post_at),
      aiTotal: count(row.ai_total),
      aiPeriod: count(row.ai_period),
      lastAiAt: nullableIso(row.last_ai_at),
    })),
    pagination: {
      page: input.page,
      pageSize: input.pageSize,
      total,
      pages: Math.max(1, Math.ceil(total / input.pageSize)),
    },
  };
}

export async function loadAdminUserDetail(
  db: Queryable,
  userId: number,
  periodDays: AdminPeriodDays,
): Promise<AdminUserDetail | null> {
  if (!Number.isSafeInteger(userId) || userId <= 0) return null;

  const identity = await db.query<{
    id: unknown;
    name: string | null;
    email: string | null;
    created_at: unknown;
    onboarding_completed_at: unknown;
    bot_linked: boolean;
    ai_engine: string | null;
    email_login: boolean;
    password_login: boolean;
    telegram_login: boolean;
    vk_login: boolean;
    last_activity_at: unknown;
  }>(
    `select app_user.id,
            coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as name,
            app_user.email, app_user.created_at, app_user.onboarding_completed_at,
            app_user.tg_chat_id is not null as bot_linked,
            nullif(btrim(app_user.ai_engine), '') as ai_engine,
            app_user.email is not null as email_login,
            app_user.password_hash is not null as password_login,
            app_user.tg_id is not null as telegram_login,
            app_user.vk_id is not null as vk_login,
            greatest(
              app_user.created_at,
              (select max(app_session.created_at) from sessions app_session where app_session.user_id = app_user.id),
              (select max(coalesce(post.published_at, post.created_at)) from posts post where post.user_id = app_user.id),
              (select max(usage.created_at) from ai_usage usage where usage.user_id = app_user.id and usage.status = 'committed')
            ) as last_activity_at
       from users app_user where app_user.id = $1`,
    [userId],
  );
  if (identity.rowCount === 0) return null;

  const [summary, activity, projects, channels, posts, aiKinds, recentAi, sessions, audit] = await Promise.all([
    db.query<{
      projects: unknown;
      channels: unknown;
      active_channels: unknown;
      channel_attention: unknown;
      posts: unknown;
      posts_period: unknown;
      published: unknown;
      scheduled: unknown;
      failed: unknown;
      drafts: unknown;
      quarantined: unknown;
      ai_total: unknown;
      ai_period: unknown;
      ai_today: unknown;
      sessions: unknown;
      active_sessions: unknown;
    }>(
      `select
         (select count(*) from project_members member where member.user_id = $1 and member.status = 'active') as projects,
         (select count(*) from channels channel where channel.user_id = $1) as channels,
         (select count(*) from channels channel where channel.user_id = $1 and channel.is_active) as active_channels,
         (select count(*) from channels channel where channel.user_id = $1 and channel.is_active and channel.status <> 'active') as channel_attention,
         (select count(*) from posts post where post.user_id = $1) as posts,
         (select count(*) from posts post where post.user_id = $1
           and post.created_at >= now() - make_interval(days => $2::int)) as posts_period,
         (select count(*) from posts post where post.user_id = $1
           and post.status in ('published', 'published_unverified')) as published,
         (select count(*) from posts post where post.user_id = $1 and post.status = 'scheduled') as scheduled,
         (select count(*) from posts post where post.user_id = $1 and post.status in ('failed', 'failed_retry')) as failed,
         (select count(*) from posts post where post.user_id = $1 and post.status = 'draft') as drafts,
         (select count(*) from posts post where post.user_id = $1 and post.quarantined_at is not null) as quarantined,
         (select count(*) from ai_usage usage where usage.user_id = $1 and usage.status = 'committed') as ai_total,
         (select count(*) from ai_usage usage where usage.user_id = $1 and usage.status = 'committed'
           and usage.created_at >= now() - make_interval(days => $2::int)) as ai_period,
         (select count(*) from ai_usage usage where usage.user_id = $1 and usage.status = 'committed'
           and usage.usage_date = current_date) as ai_today,
         (select count(*) from sessions app_session where app_session.user_id = $1) as sessions,
         (select count(*) from sessions app_session where app_session.user_id = $1 and app_session.expires_at > now()) as active_sessions`,
      [userId, periodDays],
    ),
    db.query<{ day: unknown; posts: unknown; published: unknown; ai: unknown }>(
      `with days as (
         select generate_series(current_date - ($2::int - 1), current_date, interval '1 day')::date as day
       )
       select days.day,
              (select count(*) from posts post where post.user_id = $1 and post.created_at::date = days.day) as posts,
              (select count(*) from posts post where post.user_id = $1 and post.published_at::date = days.day) as published,
              (select count(*) from ai_usage usage where usage.user_id = $1 and usage.status = 'committed'
                and usage.usage_date = days.day) as ai
         from days order by days.day`,
      [userId, periodDays],
    ),
    db.query<{
      id: unknown;
      name: string;
      timezone: string;
      role: string;
      status: string;
      personal: boolean;
      archived: boolean;
      joined_at: unknown;
      members: unknown;
      channels: unknown;
      posts: unknown;
    }>(
      `select project.id, project.name, project.timezone, member.role, member.status,
              project.personal_owner_user_id = $1 as personal,
              project.is_archived as archived, member.joined_at,
              (select count(*) from project_members colleague where colleague.project_id = project.id and colleague.status = 'active') as members,
              (select count(*) from channels channel where channel.project_id = project.id) as channels,
              (select count(*) from posts post where post.project_id = project.id) as posts
         from project_members member
         join projects project on project.id = member.project_id
        where member.user_id = $1
        order by (member.status = 'active') desc, project.is_archived, member.joined_at desc`,
      [userId],
    ),
    db.query<{
      id: unknown;
      project_id: unknown;
      project: string;
      network: string;
      title: string | null;
      handle: string | null;
      active: boolean;
      status: string;
      created_at: unknown;
      last_auth_error_code: string | null;
      last_auth_error_at: unknown;
      subscribers: unknown;
      subscribers_delta: unknown;
      posts: unknown;
      published: unknown;
      scheduled: unknown;
      failed: unknown;
      drafts: unknown;
      last_published_at: unknown;
    }>(
      `select channel.id, channel.project_id, project.name as project, channel.network,
              coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as title,
              nullif(btrim(channel.handle), '') as handle,
              channel.is_active as active, channel.status, channel.created_at,
              channel.last_auth_error_code, channel.last_auth_error_at,
              stats.subscribers, stats.subscribers_delta,
              coalesce(post_rollup.posts, 0) as posts,
              coalesce(post_rollup.published, 0) as published,
              coalesce(post_rollup.scheduled, 0) as scheduled,
              coalesce(post_rollup.failed, 0) as failed,
              coalesce(post_rollup.drafts, 0) as drafts,
              post_rollup.last_published_at
         from channels channel
         join projects project on project.id = channel.project_id
         left join lateral (
           select channel_stats.subscribers, channel_stats.subscribers_delta
             from channel_stats
            where channel_stats.channel_id = channel.id
            order by channel_stats.snapshot_date desc limit 1
         ) stats on true
         left join lateral (
           select count(*) as posts,
                  count(*) filter (where post.status in ('published', 'published_unverified')) as published,
                  count(*) filter (where post.status = 'scheduled') as scheduled,
                  count(*) filter (where post.status in ('failed', 'failed_retry')) as failed,
                  count(*) filter (where post.status = 'draft') as drafts,
                  max(post.published_at) as last_published_at
             from posts post where post.channel_id = channel.id
         ) post_rollup on true
        where channel.user_id = $1
        order by channel.is_active desc, channel.created_at desc`,
      [userId],
    ),
    db.query<{
      id: unknown;
      project: string;
      channel: string;
      network: string;
      text: string | null;
      status: string;
      origin: string;
      attempts: unknown;
      has_media: boolean;
      safe_error_code: string | null;
      verification_state: string;
      created_at: unknown;
      scheduled_at: unknown;
      published_at: unknown;
      views: unknown;
      reactions: unknown;
      comments: unknown;
    }>(
      `select post.id, project.name as project,
              coalesce(nullif(btrim(channel.title), ''), nullif(btrim(channel.handle), ''), 'Канал ' || channel.id::text) as channel,
              channel.network,
              left(regexp_replace(post.text, '\\s+', ' ', 'g'), 220) as text,
              post.status, post.publication_origin as origin, post.attempts,
              post.media is not null and post.media <> 'null'::jsonb and post.media <> '{}'::jsonb as has_media,
              case
                when post.verification_error_code is not null then post.verification_error_code
                when post.quarantine_reason is not null then post.quarantine_reason
                when post.status = 'failed' then 'provider_error'
                else null
              end as safe_error_code,
              post.verification_state, post.created_at, post.scheduled_at, post.published_at,
              stats.views, stats.reactions, stats.comments
         from posts post
         join projects project on project.id = post.project_id
         join channels channel on channel.id = post.channel_id
         left join lateral (
           select snapshot.views, snapshot.reactions, snapshot.comments
             from post_stats snapshot where snapshot.post_id = post.id
            order by snapshot.snapshot_date desc limit 1
         ) stats on true
        where post.user_id = $1
        order by coalesce(post.published_at, post.scheduled_at, post.created_at) desc, post.id desc
        limit 25`,
      [userId],
    ),
    db.query<{ kind: string; total: unknown; period: unknown }>(
      `select usage.kind,
              count(*) filter (where usage.status = 'committed') as total,
              count(*) filter (where usage.status = 'committed'
                and usage.created_at >= now() - make_interval(days => $2::int)) as period
         from ai_usage usage where usage.user_id = $1
        group by usage.kind order by period desc, total desc, usage.kind`,
      [userId, periodDays],
    ),
    db.query<{ id: unknown; kind: string; content_type: string | null; created_at: unknown }>(
      `select usage.id, usage.kind, usage.result_content_type as content_type, usage.created_at
         from ai_usage usage
        where usage.user_id = $1 and usage.status = 'committed'
        order by usage.created_at desc, usage.id desc limit 16`,
      [userId],
    ),
    db.query<{ device: string | null; created_at: unknown; expires_at: unknown; active: boolean }>(
      `select nullif(btrim(app_session.device), '') as device,
              app_session.created_at, app_session.expires_at,
              app_session.expires_at > now() as active
         from sessions app_session where app_session.user_id = $1
        order by app_session.created_at desc limit 10`,
      [userId],
    ),
    db.query<{
      id: unknown;
      action: string;
      entity_type: string;
      entity_id: string | null;
      project: string;
      created_at: unknown;
    }>(
      `select event.id, event.action, event.entity_type, event.entity_id,
              project.name as project, event.created_at
         from audit_events event
         join projects project on project.id = event.project_id
        where event.actor_user_id = $1
        order by event.created_at desc, event.id desc limit 20`,
      [userId],
    ),
  ]);

  const row = identity.rows[0];
  const totals = summary.rows[0];
  return {
    periodDays,
    user: {
      id: positiveId(row.id),
      name: row.name || `Пользователь ${userId}`,
      email: row.email,
      createdAt: iso(row.created_at),
      onboardingCompletedAt: nullableIso(row.onboarding_completed_at),
      botLinked: row.bot_linked === true,
      aiEngine: row.ai_engine,
      auth: {
        email: row.email_login === true,
        password: row.password_login === true,
        telegram: row.telegram_login === true,
        vk: row.vk_login === true,
      },
      lastActivityAt: iso(row.last_activity_at),
    },
    summary: {
      projects: count(totals?.projects),
      channels: count(totals?.channels),
      activeChannels: count(totals?.active_channels),
      channelAttention: count(totals?.channel_attention),
      posts: count(totals?.posts),
      postsPeriod: count(totals?.posts_period),
      published: count(totals?.published),
      scheduled: count(totals?.scheduled),
      failed: count(totals?.failed),
      drafts: count(totals?.drafts),
      quarantined: count(totals?.quarantined),
      aiTotal: count(totals?.ai_total),
      aiPeriod: count(totals?.ai_period),
      aiToday: count(totals?.ai_today),
      sessions: count(totals?.sessions),
      activeSessions: count(totals?.active_sessions),
    },
    activity: activity.rows.map((item) => ({
      date: iso(item.day).slice(0, 10),
      posts: count(item.posts),
      published: count(item.published),
      ai: count(item.ai),
    })),
    projects: projects.rows.map((item) => ({
      id: positiveId(item.id),
      name: item.name,
      timezone: item.timezone,
      role: item.role,
      status: item.status,
      personal: item.personal === true,
      archived: item.archived === true,
      joinedAt: iso(item.joined_at),
      members: count(item.members),
      channels: count(item.channels),
      posts: count(item.posts),
    })),
    channels: channels.rows.map((item) => ({
      id: positiveId(item.id),
      projectId: positiveId(item.project_id),
      project: item.project,
      network: item.network,
      title: item.title || `Канал ${positiveId(item.id)}`,
      handle: item.handle,
      active: item.active === true,
      status: item.status,
      createdAt: iso(item.created_at),
      lastAuthErrorCode: item.last_auth_error_code,
      lastAuthErrorAt: nullableIso(item.last_auth_error_at),
      subscribers: nullableCount(item.subscribers),
      subscribersDelta: item.subscribers_delta == null ? null : Number(item.subscribers_delta),
      posts: count(item.posts),
      published: count(item.published),
      scheduled: count(item.scheduled),
      failed: count(item.failed),
      drafts: count(item.drafts),
      lastPublishedAt: nullableIso(item.last_published_at),
    })),
    posts: posts.rows.map((item) => ({
      id: positiveId(item.id),
      project: item.project,
      channel: item.channel,
      network: item.network,
      text: item.text || "Публикация без текста",
      status: item.status,
      origin: item.origin,
      attempts: count(item.attempts),
      hasMedia: item.has_media === true,
      safeErrorCode: item.safe_error_code,
      verificationState: item.verification_state,
      createdAt: iso(item.created_at),
      scheduledAt: nullableIso(item.scheduled_at),
      publishedAt: nullableIso(item.published_at),
      views: nullableCount(item.views),
      reactions: nullableCount(item.reactions),
      comments: nullableCount(item.comments),
    })),
    aiKinds: aiKinds.rows.map((item) => ({
      kind: item.kind,
      total: count(item.total),
      period: count(item.period),
    })),
    recentAi: recentAi.rows.map((item) => ({
      id: positiveId(item.id),
      kind: item.kind,
      contentType: item.content_type,
      createdAt: iso(item.created_at),
    })),
    sessions: sessions.rows.map((item) => ({
      device: item.device || "Устройство не определено",
      createdAt: iso(item.created_at),
      expiresAt: iso(item.expires_at),
      active: item.active === true,
    })),
    audit: audit.rows.map((item) => ({
      id: positiveId(item.id),
      action: item.action,
      entityType: item.entity_type,
      entityId: item.entity_id,
      project: item.project,
      createdAt: iso(item.created_at),
    })),
  };
}
