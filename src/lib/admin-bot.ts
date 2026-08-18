import type { Pool } from "pg";

import type { AdminPeriodDays } from "./admin-dashboard";
import { TELEGRAM_BOT_COMMANDS, telegramBotCommandsReady } from "./telegram-bot-commands.mjs";
import { resolveTranscriptionRuntime } from "./transcription-runtime.mjs";
import {
  telegramPollingGuardConfiguration,
  telegramPollingGuardMatches,
} from "../../worker/telegram-polling-guard.mjs";

type Queryable = Pick<Pool, "query">;
type Transactional = Pick<Pool, "query" | "connect">;
type AdminBotEnv = Readonly<Record<string, string | undefined>>;

export type AdminBotRuntimeState = "healthy" | "down" | "not_configured";
type TelegramSendResponse = { ok?: boolean; error_code?: number; description?: string };

export interface AdminBotRuntime {
  state: AdminBotRuntimeState;
  configured: boolean;
  botName: string | null;
  username: string | null;
  botId: string | null;
  miniAppReady: boolean;
  voiceReady: boolean;
  voiceProvider: "openai" | "navy" | null;
  webhookClear: boolean | null;
  webhookGuarded: boolean | null;
  commandsReady: boolean | null;
  businessReady: boolean;
  checkedAt: string;
}

export interface AdminBotData {
  periodDays: AdminPeriodDays;
  checkedAt: string;
  runtime: AdminBotRuntime;
  workerState: "up" | "down" | "conflict" | "unknown";
  publicationWorkerState: "up" | "down" | "unknown";
  summary: {
    linkedUsers: number;
    disabledUsers: number;
    activeProjects: number;
    disabledProjects: number;
    draftsCreated: number;
    publicationsScheduled: number;
    publicationsPublished: number;
    deliveryFailures: number;
    telegramChannelsReady: number;
    telegramChannelsAttention: number;
    pendingResults: number;
    businessConnected: number;
    businessEnabled: number;
    openClientInquiries: number;
    interactions: number;
    activeUsers: number;
    commandInteractions: number;
    buttonInteractions: number;
    messageInteractions: number;
    lastInteractionAt: string | null;
  };
  daily: Array<{ date: string; drafts: number; scheduled: number; published: number; failures: number; interactions: number }>;
  notifications: {
    recipients: number;
    publicationSuccess: number;
    publicationFailure: number;
    opportunities: number;
    postResults: number;
    reviewReminders: number;
    problemDigest: number;
    dailyDigest: number;
    weeklyDigest: number;
  };
  users: Array<{
    id: number;
    name: string;
    email: string | null;
    linked: boolean;
    enabled: boolean;
    disabledReason: string | null;
    projects: number;
    notificationProfiles: number;
    draftsCreated: number;
    publicationsScheduled: number;
    interactions: number;
    commands: number;
    buttons: number;
    messages: number;
    lastActivityAt: string | null;
    lastInteractionAt: string | null;
    lastDeliveryAt: string | null;
    lastDeliveryOk: boolean | null;
  }>;
  projects: Array<{
    id: number;
    name: string;
    enabled: boolean;
    disabledReason: string | null;
    linkedMembers: number;
    telegramChannels: number;
    draftsCreated: number;
    publicationsScheduled: number;
    interactions: number;
    businessConnected: boolean;
    businessEnabled: boolean;
    openClientInquiries: number;
    lastActivityAt: string | null;
  }>;
  deliveries: Array<{
    id: number;
    user: string | null;
    project: string | null;
    method: string;
    source: string;
    ok: boolean;
    errorCode: string | null;
    description: string | null;
    createdAt: string;
  }>;
  topActions: Array<{
    type: string;
    action: string;
    count: number;
  }>;
  interactions: Array<{
    id: number;
    user: string | null;
    project: string | null;
    type: string;
    action: string;
    createdAt: string;
  }>;
  audit: Array<{
    id: string;
    action: string;
    target: string;
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

function safeReason(value: unknown): string {
  const reason = String(value || "").trim().replace(/\s+/gu, " ").slice(0, 500);
  return reason.length >= 3 ? reason : "Отключено администратором через центр управления ботом";
}

export async function probeAdminTelegramBot(
  env: AdminBotEnv = process.env,
  fetcher: typeof fetch = fetch,
): Promise<AdminBotRuntime> {
  const token = String(env.TG_BOT_TOKEN || "").trim();
  const appUrl = String(env.APP_URL || "").trim();
  const baseUrl = String(env.TG_API_URL || "https://api.telegram.org").replace(/\/+$/u, "");
  const transcription = resolveTranscriptionRuntime(env);
  const base = {
    configured: Boolean(token),
    miniAppReady: /^https:\/\//iu.test(appUrl),
    voiceReady: Boolean(transcription),
    voiceProvider: transcription?.provider || null,
    webhookClear: null,
    webhookGuarded: null,
    commandsReady: null,
    businessReady: false,
    checkedAt: new Date().toISOString(),
  };
  if (!token) {
    return { ...base, state: "not_configured", botName: null, username: null, botId: null };
  }
  try {
    const response = await fetcher(`${baseUrl}/bot${token}/getMe`, {
      method: "GET",
      cache: "no-store",
      signal: AbortSignal.timeout(4_000),
    });
    const payload = await response.json().catch(() => null) as {
      ok?: boolean;
      result?: {
        id?: number | string;
        first_name?: string;
        username?: string;
        can_connect_to_business?: boolean;
      };
    } | null;
    if (!response.ok || !payload?.ok || !payload.result) {
      return { ...base, state: "down", botName: null, username: null, botId: null };
    }
    const safeTelegramProbe = async (method: "getWebhookInfo" | "getMyCommands") => {
      try {
        const probe = await fetcher(`${baseUrl}/bot${token}/${method}`, {
          method: "GET",
          cache: "no-store",
          signal: AbortSignal.timeout(4_000),
        });
        if (!probe.ok) return null;
        const body = await probe.json().catch(() => null) as { ok?: boolean; result?: unknown } | null;
        return body?.ok ? body.result : null;
      } catch {
        return null;
      }
    };
    const [webhook, commands] = await Promise.all([
      safeTelegramProbe("getWebhookInfo"),
      safeTelegramProbe("getMyCommands"),
    ]);
    const webhookUrl = webhook == null
      ? null
      : String((webhook as { url?: unknown }).url || "").trim();
    return {
      ...base,
      state: "healthy",
      botName: String(payload.result.first_name || "Telegram-бот"),
      username: payload.result.username ? String(payload.result.username) : null,
      botId: payload.result.id == null ? null : String(payload.result.id),
      webhookClear: webhookUrl == null ? null : webhookUrl.length === 0,
      webhookGuarded: webhookUrl == null ? null : telegramPollingGuardMatches(webhook, token),
      commandsReady: commands == null ? null : telegramBotCommandsReady(commands),
      businessReady: payload.result.can_connect_to_business === true,
    };
  } catch {
    return { ...base, state: "down", botName: null, username: null, botId: null };
  }
}

export async function repairAdminTelegramConfiguration(db: Queryable, input: {
  actorUserId: number;
  env?: AdminBotEnv;
  fetcher?: typeof fetch;
}) {
  const env = input.env || process.env;
  const token = String(env.TG_BOT_TOKEN || "").trim();
  if (!token) return { status: "not_configured" as const };
  const baseUrl = String(env.TG_API_URL || "https://api.telegram.org").replace(/\/+$/u, "");
  const fetcher = input.fetcher || fetch;
  const call = async (method: "setWebhook" | "setMyCommands", body: object) => {
    try {
      const response = await fetcher(`${baseUrl}/bot${token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(8_000),
      });
      const payload = await response.json().catch(() => null) as {
        ok?: boolean;
        error_code?: number;
        description?: string;
      } | null;
      return {
        ok: response.ok && payload?.ok === true,
        errorCode: payload?.error_code || null,
        description: String(payload?.description || "").slice(0, 200),
      };
    } catch (error) {
      return {
        ok: false,
        errorCode: null,
        description: error instanceof Error ? error.name : "network_error",
      };
    }
  };

  const webhook = await call("setWebhook", telegramPollingGuardConfiguration(token));
  const commands = await call("setMyCommands", { commands: TELEGRAM_BOT_COMMANDS });
  const ok = webhook.ok && commands.ok;
  await db.query(
    `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
     values ($1, $2, 'runtime', null, $3::jsonb)`,
    [input.actorUserId, ok ? "bot.telegram.repaired" : "bot.telegram.repair_failed", JSON.stringify({
      queueGuardConfigured: webhook.ok,
      commandsConfigured: commands.ok,
      ...(webhook.errorCode ? { webhookErrorCode: webhook.errorCode } : {}),
      ...(commands.errorCode ? { commandsErrorCode: commands.errorCode } : {}),
    })],
  );
  return ok
    ? { status: "repaired" as const, queueGuardConfigured: true, commandsConfigured: true }
    : {
        status: "failed" as const,
        queueGuardConfigured: webhook.ok,
        commandsConfigured: commands.ok,
        description: commands.description || webhook.description || "Telegram не принял настройки",
      };
}

export async function loadAdminBotData(
  db: Queryable,
  periodDays: AdminPeriodDays,
): Promise<Omit<AdminBotData, "checkedAt" | "runtime" | "workerState" | "publicationWorkerState">> {
  const [
    headline,
    daily,
    notificationRows,
    userRows,
    projectRows,
    deliveryRows,
    topActionRows,
    interactionRows,
    auditRows,
  ] = await Promise.all([
    db.query(`select
      (select count(*) from users where tg_chat_id is not null) as linked_users,
      (select count(*) from bot_user_controls where enabled = false) as disabled_users,
      (select count(*) from projects project
        where project.is_archived = false
          and coalesce((select control.enabled from bot_project_controls control where control.project_id = project.id), true)) as active_projects,
      (select count(*) from bot_project_controls where enabled = false) as disabled_projects,
      (select count(*) from audit_events event
        where event.action = 'draft.saved_from_bot'
          and event.created_at >= now() - make_interval(days => $1::int)) as drafts_created,
      (select count(*) from audit_events event
        where event.action = 'publication.scheduled_from_bot'
          and event.created_at >= now() - make_interval(days => $1::int)) as publications_scheduled,
      (select count(*) from audit_events event
        join posts post on event.entity_id ~ '^[0-9]+$' and post.id = event.entity_id::bigint
        where event.action = 'publication.scheduled_from_bot' and post.status = 'published'
          and post.published_at >= now() - make_interval(days => $1::int)) as publications_published,
      (select count(*) from bot_delivery_events event
        where event.ok = false and event.created_at >= now() - make_interval(days => $1::int)) as delivery_failures,
      (select count(*) from channels channel
        where channel.network = 'tg' and channel.status = 'active'
          and channel.is_active = true and channel.tg_chat_id is not null) as telegram_channels_ready,
      (select count(*) from channels channel
        where channel.network = 'tg'
          and (channel.status in ('needs_reconnect','permission_lost','revoked')
            or (channel.status = 'active' and (channel.is_active = false or channel.tg_chat_id is null)))) as telegram_channels_attention,
      (select count(*) from bot_post_result_notifications where delivered_at is null) as pending_results,
      (select count(*) from bot_client_assistant_preferences where business_connection_id is not null) as business_connected,
      (select count(*) from bot_client_assistant_preferences where business_connection_id is not null and enabled = true) as business_enabled,
      (select count(*) from bot_client_inquiries where status in ('pending','reply_ready','approved','failed')) as open_client_inquiries,
      (select count(*) from bot_interaction_events event
        where event.created_at >= now() - make_interval(days => $1::int)) as interactions,
      (select count(distinct event.user_id) from bot_interaction_events event
        where event.user_id is not null
          and event.created_at >= now() - make_interval(days => $1::int)) as active_users,
      (select count(*) from bot_interaction_events event
        where event.interaction_type = 'command'
          and event.created_at >= now() - make_interval(days => $1::int)) as command_interactions,
      (select count(*) from bot_interaction_events event
        where event.interaction_type in ('reply_button','callback')
          and event.created_at >= now() - make_interval(days => $1::int)) as button_interactions,
      (select count(*) from bot_interaction_events event
        where event.interaction_type in ('message','voice','attachment')
          and event.created_at >= now() - make_interval(days => $1::int)) as message_interactions,
      (select max(event.created_at) from bot_interaction_events event) as last_interaction_at`,
    [periodDays]),
    db.query(`with days as (
      select generate_series(current_date - ($1::int - 1), current_date, interval '1 day')::date as day
    )
    select days.day,
      (select count(*) from audit_events event where event.action = 'draft.saved_from_bot' and event.created_at::date = days.day) as drafts,
      (select count(*) from audit_events event where event.action = 'publication.scheduled_from_bot' and event.created_at::date = days.day) as scheduled,
      (select count(*) from audit_events event
        join posts post on event.entity_id ~ '^[0-9]+$' and post.id = event.entity_id::bigint
        where event.action = 'publication.scheduled_from_bot' and post.status = 'published' and post.published_at::date = days.day) as published,
      (select count(*) from bot_delivery_events event where event.ok = false and event.created_at::date = days.day) as failures,
      (select count(*) from bot_interaction_events event where event.created_at::date = days.day) as interactions
    from days order by days.day`, [periodDays]),
    db.query(`select
      count(*) as recipients,
      count(*) filter (where publication_success_enabled) as publication_success,
      count(*) filter (where publication_failure_enabled) as publication_failure,
      count(*) filter (where content_opportunities_enabled) as opportunities,
      count(*) filter (where post_results_enabled) as post_results,
      count(*) filter (where review_reminders_enabled) as review_reminders,
      count(*) filter (where problem_digest_enabled) as problem_digest,
      count(*) filter (where daily_digest_enabled) as daily_digest,
      count(*) filter (where weekly_digest_enabled) as weekly_digest
    from bot_notification_preferences`),
    db.query(`with activity as (
      select event.actor_user_id as user_id,
        count(*) filter (where event.action = 'draft.saved_from_bot') as drafts_created,
        count(*) filter (where event.action = 'publication.scheduled_from_bot') as publications_scheduled,
        max(event.created_at) as last_activity_at
      from audit_events event
      where event.action in ('draft.saved_from_bot','publication.scheduled_from_bot')
        and event.created_at >= now() - make_interval(days => $1::int)
      group by event.actor_user_id
    ), usage as (
      select event.user_id,
        count(*) as interactions,
        count(*) filter (where event.interaction_type = 'command') as commands,
        count(*) filter (where event.interaction_type in ('reply_button','callback')) as buttons,
        count(*) filter (where event.interaction_type in ('message','voice','attachment')) as messages,
        max(event.created_at) as last_interaction_at
      from bot_interaction_events event
      where event.user_id is not null
        and event.created_at >= now() - make_interval(days => $1::int)
      group by event.user_id
    ), last_delivery as (
      select distinct on (event.user_id) event.user_id, event.created_at, event.ok
      from bot_delivery_events event where event.user_id is not null
      order by event.user_id, event.created_at desc, event.id desc
    )
    select app_user.id,
      coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || app_user.id::text) as name,
      app_user.email, app_user.tg_chat_id is not null as linked,
      coalesce(control.enabled, true) as enabled, control.disabled_reason,
      (select count(*) from project_members member where member.user_id = app_user.id and member.status = 'active') as projects,
      (select count(*) from bot_notification_preferences preference where preference.user_id = app_user.id) as notification_profiles,
      coalesce(activity.drafts_created, 0) as drafts_created,
      coalesce(activity.publications_scheduled, 0) as publications_scheduled,
      coalesce(usage.interactions, 0) as interactions,
      coalesce(usage.commands, 0) as commands,
      coalesce(usage.buttons, 0) as buttons,
      coalesce(usage.messages, 0) as messages,
      greatest(activity.last_activity_at, usage.last_interaction_at) as last_activity_at,
      usage.last_interaction_at,
      last_delivery.created_at as last_delivery_at, last_delivery.ok as last_delivery_ok
    from users app_user
    left join bot_user_controls control on control.user_id = app_user.id
    left join activity on activity.user_id = app_user.id
    left join usage on usage.user_id = app_user.id
    left join last_delivery on last_delivery.user_id = app_user.id
    where app_user.tg_chat_id is not null or control.user_id is not null
      or activity.user_id is not null or usage.user_id is not null
    order by app_user.tg_chat_id is not null desc,
      greatest(activity.last_activity_at, usage.last_interaction_at) desc nulls last,
      app_user.id desc
    limit 60`, [periodDays]),
    db.query(`with activity as (
      select event.project_id,
        count(*) filter (where event.action = 'draft.saved_from_bot') as drafts_created,
        count(*) filter (where event.action = 'publication.scheduled_from_bot') as publications_scheduled,
        max(event.created_at) as last_activity_at
      from audit_events event
      where event.action in ('draft.saved_from_bot','publication.scheduled_from_bot')
        and event.created_at >= now() - make_interval(days => $1::int)
      group by event.project_id
    ), usage as (
      select event.project_id, count(*) as interactions, max(event.created_at) as last_interaction_at
      from bot_interaction_events event
      where event.project_id is not null
        and event.created_at >= now() - make_interval(days => $1::int)
      group by event.project_id
    )
    select project.id, project.name, coalesce(control.enabled, true) as enabled, control.disabled_reason,
      (select count(distinct member.user_id) from project_members member join users app_user on app_user.id = member.user_id
        where member.project_id = project.id and member.status = 'active' and app_user.tg_chat_id is not null) as linked_members,
      (select count(*) from channels channel where channel.project_id = project.id and channel.network = 'tg'
        and channel.is_active = true and channel.status = 'active') as telegram_channels,
      coalesce(activity.drafts_created, 0) as drafts_created,
      coalesce(activity.publications_scheduled, 0) as publications_scheduled,
      coalesce(usage.interactions, 0) as interactions,
      business.business_connection_id is not null as business_connected,
      coalesce(business.enabled, false) as business_enabled,
      (select count(*) from bot_client_inquiries inquiry where inquiry.project_id = project.id
        and inquiry.status in ('pending','reply_ready','approved','failed')) as open_client_inquiries,
      greatest(activity.last_activity_at, usage.last_interaction_at) as last_activity_at
    from projects project
    left join bot_project_controls control on control.project_id = project.id
    left join activity on activity.project_id = project.id
    left join usage on usage.project_id = project.id
    left join bot_client_assistant_preferences business on business.project_id = project.id
    where project.is_archived = false and (
      control.project_id is not null or activity.project_id is not null or usage.project_id is not null
      or business.project_id is not null
      or exists (select 1 from channels channel where channel.project_id = project.id and channel.network = 'tg')
      or exists (select 1 from project_members member join users app_user on app_user.id = member.user_id
        where member.project_id = project.id and member.status = 'active' and app_user.tg_chat_id is not null)
    )
    order by coalesce(greatest(activity.last_activity_at, usage.last_interaction_at), project.created_at) desc,
      project.id desc
    limit 60`, [periodDays]),
    db.query(`select event.id, event.method, event.source, event.ok,
      coalesce(event.error_code, case when event.telegram_error_code is not null then 'telegram_' || event.telegram_error_code::text end) as error_code,
      event.error_description, event.created_at,
      coalesce(nullif(btrim(app_user.name), ''), app_user.email) as user_name,
      project.name as project_name
    from bot_delivery_events event
    left join users app_user on app_user.id = event.user_id
    left join projects project on project.id = event.project_id
    order by event.created_at desc, event.id desc limit 40`),
    db.query(`select event.interaction_type, event.action, count(*) as count
      from bot_interaction_events event
      where event.created_at >= now() - make_interval(days => $1::int)
      group by event.interaction_type, event.action
      order by count(*) desc, event.interaction_type, event.action
      limit 12`, [periodDays]),
    db.query(`select event.id, event.interaction_type, event.action, event.created_at,
      coalesce(nullif(btrim(app_user.name), ''), app_user.email) as user_name,
      project.name as project_name
    from bot_interaction_events event
    left join users app_user on app_user.id = event.user_id
    left join projects project on project.id = event.project_id
    order by event.created_at desc, event.id desc limit 40`),
    db.query(`select * from (
      select 'admin:' || event.id::text as row_id, event.action,
        case event.target_type when 'user' then coalesce(nullif(btrim(app_user.name), ''), app_user.email, 'Пользователь ' || event.target_id::text)
          when 'project' then coalesce(project.name, 'Проект ' || event.target_id::text) else 'Бот Авроры' end as target,
        coalesce(nullif(btrim(actor.name), ''), actor.email, 'Системный администратор') as actor,
        event.created_at
      from bot_admin_action_events event
      left join users app_user on event.target_type = 'user' and app_user.id = event.target_id
      left join projects project on event.target_type = 'project' and project.id = event.target_id
      left join users actor on actor.id = event.actor_user_id
      union all
      select 'project:' || event.id::text, event.action, project.name,
        coalesce(nullif(btrim(actor.name), ''), actor.email, 'Системное действие'), event.created_at
      from audit_events event
      join projects project on project.id = event.project_id
      left join users actor on actor.id = event.actor_user_id
      where event.action in ('draft.saved_from_bot','publication.scheduled_from_bot','editorial.submitted_from_bot','editorial.decided_from_bot')
    ) journal order by created_at desc limit 30`),
  ]);

  const h = headline.rows[0] || {};
  const n = notificationRows.rows[0] || {};
  return {
    periodDays,
    summary: {
      linkedUsers: count(h.linked_users), disabledUsers: count(h.disabled_users),
      activeProjects: count(h.active_projects), disabledProjects: count(h.disabled_projects),
      draftsCreated: count(h.drafts_created), publicationsScheduled: count(h.publications_scheduled),
      publicationsPublished: count(h.publications_published), deliveryFailures: count(h.delivery_failures),
      telegramChannelsReady: count(h.telegram_channels_ready),
      telegramChannelsAttention: count(h.telegram_channels_attention),
      pendingResults: count(h.pending_results), businessConnected: count(h.business_connected),
      businessEnabled: count(h.business_enabled), openClientInquiries: count(h.open_client_inquiries),
      interactions: count(h.interactions), activeUsers: count(h.active_users),
      commandInteractions: count(h.command_interactions), buttonInteractions: count(h.button_interactions),
      messageInteractions: count(h.message_interactions), lastInteractionAt: nullableIso(h.last_interaction_at),
    },
    daily: daily.rows.map((row) => ({
      date: iso(row.day).slice(0, 10), drafts: count(row.drafts), scheduled: count(row.scheduled),
      published: count(row.published), failures: count(row.failures), interactions: count(row.interactions),
    })),
    notifications: {
      recipients: count(n.recipients), publicationSuccess: count(n.publication_success),
      publicationFailure: count(n.publication_failure), opportunities: count(n.opportunities),
      postResults: count(n.post_results), reviewReminders: count(n.review_reminders),
      problemDigest: count(n.problem_digest), dailyDigest: count(n.daily_digest), weeklyDigest: count(n.weekly_digest),
    },
    users: userRows.rows.map((row) => ({
      id: positiveId(row.id), name: String(row.name || "Пользователь"), email: row.email ? String(row.email) : null,
      linked: row.linked === true, enabled: row.enabled !== false,
      disabledReason: row.disabled_reason ? String(row.disabled_reason) : null,
      projects: count(row.projects), notificationProfiles: count(row.notification_profiles),
      draftsCreated: count(row.drafts_created), publicationsScheduled: count(row.publications_scheduled),
      interactions: count(row.interactions), commands: count(row.commands), buttons: count(row.buttons),
      messages: count(row.messages), lastActivityAt: nullableIso(row.last_activity_at),
      lastInteractionAt: nullableIso(row.last_interaction_at), lastDeliveryAt: nullableIso(row.last_delivery_at),
      lastDeliveryOk: row.last_delivery_ok == null ? null : row.last_delivery_ok === true,
    })),
    projects: projectRows.rows.map((row) => ({
      id: positiveId(row.id), name: String(row.name || "Проект"), enabled: row.enabled !== false,
      disabledReason: row.disabled_reason ? String(row.disabled_reason) : null,
      linkedMembers: count(row.linked_members), telegramChannels: count(row.telegram_channels),
      draftsCreated: count(row.drafts_created), publicationsScheduled: count(row.publications_scheduled),
      interactions: count(row.interactions),
      businessConnected: row.business_connected === true, businessEnabled: row.business_enabled === true,
      openClientInquiries: count(row.open_client_inquiries), lastActivityAt: nullableIso(row.last_activity_at),
    })),
    deliveries: deliveryRows.rows.map((row) => ({
      id: positiveId(row.id), user: row.user_name ? String(row.user_name) : null,
      project: row.project_name ? String(row.project_name) : null, method: String(row.method || "sendMessage"),
      source: String(row.source || "assistant"), ok: row.ok === true,
      errorCode: row.error_code ? String(row.error_code) : null,
      description: row.error_description ? String(row.error_description) : null,
      createdAt: iso(row.created_at),
    })),
    topActions: topActionRows.rows.map((row) => ({
      type: String(row.interaction_type || "message"), action: String(row.action || "unknown"),
      count: count(row.count),
    })),
    interactions: interactionRows.rows.map((row) => ({
      id: positiveId(row.id), user: row.user_name ? String(row.user_name) : null,
      project: row.project_name ? String(row.project_name) : null,
      type: String(row.interaction_type || "message"), action: String(row.action || "unknown"),
      createdAt: iso(row.created_at),
    })),
    audit: auditRows.rows.map((row) => ({
      id: String(row.row_id), action: String(row.action), target: String(row.target || "Бот Авроры"),
      actor: String(row.actor || "Системное действие"), createdAt: iso(row.created_at),
    })),
  };
}

export async function setAdminBotAccess(db: Transactional, input: {
  actorUserId: number;
  targetType: "user" | "project";
  targetId: number;
  enabled: boolean;
  reason?: string;
}) {
  const table = input.targetType === "user" ? "bot_user_controls" : "bot_project_controls";
  const idColumn = input.targetType === "user" ? "user_id" : "project_id";
  const sourceTable = input.targetType === "user" ? "users" : "projects";
  const client = await db.connect();
  try {
    await client.query("begin");
    const exists = await client.query(`select id from ${sourceTable} where id = $1 for update`, [input.targetId]);
    if (!exists.rowCount) {
      await client.query("rollback");
      return { status: "not_found" as const };
    }
    const reason = input.enabled ? null : safeReason(input.reason);
    await client.query(
      `insert into ${table} (${idColumn}, enabled, disabled_reason, updated_by_user_id)
       values ($1, $2, $3, $4)
       on conflict (${idColumn}) do update set enabled = excluded.enabled,
         disabled_reason = excluded.disabled_reason, updated_by_user_id = excluded.updated_by_user_id,
         updated_at = now()`,
      [input.targetId, input.enabled, reason, input.actorUserId],
    );
    if (!input.enabled) {
      if (input.targetType === "user") {
        await client.query(`update bot_conversations set state = 'cancelled', updated_at = now()
          where user_id = $1 and state not in ('completed','cancelled')`, [input.targetId]);
      } else {
        await client.query(`update bot_conversations set state = 'cancelled', updated_at = now()
          where project_id = $1 and state not in ('completed','cancelled')`, [input.targetId]);
      }
    }
    await client.query(
      `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [input.actorUserId, input.enabled ? "bot.access.enabled" : "bot.access.disabled", input.targetType,
        input.targetId, JSON.stringify({ enabled: input.enabled, ...(reason ? { reason } : {}) })],
    );
    await client.query("commit");
    return { status: "updated" as const, enabled: input.enabled };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function setAdminBusinessAssistant(db: Transactional, input: {
  actorUserId: number;
  projectId: number;
  enabled: boolean;
}) {
  const client = await db.connect();
  try {
    await client.query("begin");
    const result = await client.query(
      `update bot_client_assistant_preferences set enabled = $2, require_approval = true, updated_at = now()
       where project_id = $1 and business_connection_id is not null returning project_id`,
      [input.projectId, input.enabled],
    );
    if (!result.rowCount) {
      await client.query("rollback");
      return { status: "not_connected" as const };
    }
    await client.query(
      `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
       values ($1, $2, 'project', $3, $4::jsonb)`,
      [input.actorUserId, input.enabled ? "bot.business.enabled" : "bot.business.disabled",
        input.projectId, JSON.stringify({ enabled: input.enabled, requireApproval: true })],
    );
    await client.query("commit");
    return { status: "updated" as const, enabled: input.enabled };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function sendAdminBotTest(db: Queryable, input: {
  actorUserId: number;
  targetUserId: number;
  env?: AdminBotEnv;
  fetcher?: typeof fetch;
}) {
  const env = input.env || process.env;
  const token = String(env.TG_BOT_TOKEN || "").trim();
  if (!token) return { status: "not_configured" as const };
  const recipient = (await db.query(
    `select app_user.tg_chat_id, coalesce(control.enabled, true) as enabled
       from users app_user left join bot_user_controls control on control.user_id = app_user.id
      where app_user.id = $1`, [input.targetUserId],
  )).rows[0];
  if (!recipient) return { status: "not_found" as const };
  if (!recipient.tg_chat_id) return { status: "not_linked" as const };
  if (recipient.enabled === false) return { status: "disabled" as const };

  const baseUrl = String(env.TG_API_URL || "https://api.telegram.org").replace(/\/+$/u, "");
  let payload: TelegramSendResponse | null = null;
  let networkError: string | null = null;
  try {
    const response = await (input.fetcher || fetch)(`${baseUrl}/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(8_000),
      body: JSON.stringify({
        chat_id: recipient.tg_chat_id,
        text: "Тест Авроры\n\nБот подключён и может доставлять сообщения. Это проверка из админ-панели — никаких действий не требуется.",
        disable_web_page_preview: true,
      }),
    });
    payload = await response.json().catch(() => null) as TelegramSendResponse | null;
  } catch (error) {
    networkError = error instanceof Error ? error.name : "network_error";
  }
  const ok = payload?.ok === true;
  await db.query(
    `insert into bot_delivery_events
      (user_id, chat_id, method, source, ok, telegram_error_code, error_code, error_description)
     values ($1, $2, 'sendMessage', 'admin_test', $3, $4, $5, $6)`,
    [input.targetUserId, recipient.tg_chat_id, ok, payload?.error_code || null,
      ok ? null : networkError || "telegram_rejected", ok ? null : String(payload?.description || networkError || "Telegram не принял сообщение").slice(0, 500)],
  );
  await db.query(
    `insert into bot_admin_action_events (actor_user_id, action, target_type, target_id, safe_data)
     values ($1, $2, 'user', $3, $4::jsonb)`,
    [input.actorUserId, ok ? "bot.test.delivered" : "bot.test.failed", input.targetUserId,
      JSON.stringify({ delivered: ok, ...(payload?.error_code ? { telegramErrorCode: payload.error_code } : {}) })],
  );
  return ok
    ? { status: "delivered" as const }
    : { status: "failed" as const, description: String(payload?.description || "Telegram не принял сообщение").slice(0, 200) };
}
