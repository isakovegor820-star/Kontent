import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";
import { RELEASE_1_FEATURE, TODAY_RANKING_VERSION, release1Enabled } from "./content-intelligence";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TodayItemType = "opportunity" | "review" | "result" | "risk" | "onboarding";
export type TodayChannelOption = { id: number; label: string; enabled: boolean };
export type TodayItem = {
  fingerprint: string;
  type: TodayItemType;
  title: string;
  whyNow: string;
  channelId: number | null;
  channelLabel: string;
  confidence: "low" | "medium" | "high";
  epistemicState: "observed" | "inferred" | "insufficient_data" | "stale" | "blocked";
  freshness: string;
  priority: number;
  primaryAction: { label: string; href: string };
  secondaryAction: { label: string; state: "snoozed" } | null;
  evidence: { kind: "opportunity" | "draft"; id: number } | null;
};

export type TodayBoard = {
  enabled: boolean;
  featureKey: typeof RELEASE_1_FEATURE;
  rankingVersion: typeof TODAY_RANKING_VERSION;
  projectId: number;
  timezone: string;
  channelId: number | null;
  channelLabel: string;
  channels: TodayChannelOption[];
  updatedAt: string;
  availability: "ready" | "partial" | "unavailable";
  items: TodayItem[];
  partialErrors: Array<{ source: string; message: string }>;
};

export class TodayError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "TodayError"; }
}

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

export function rankTodayItems(items: TodayItem[]): TodayItem[] {
  const typeOrder: Record<TodayItemType, number> = { risk: 0, review: 1, opportunity: 2, result: 3, onboarding: 4 };
  return [...items]
    .sort((a, b) => b.priority - a.priority || typeOrder[a.type] - typeOrder[b.type] || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, 5);
}

function channelLabel(row: { title: string | null; handle: string | null }): string {
  return row.title?.trim() || (row.handle ? `@${row.handle.replace(/^@/u, "")}` : "Канал");
}

async function scopeFor(db: Queryable, actorUserId: number, requestedChannelId: number | null) {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  const project = (await db.query<{ timezone: string }>(
    `select timezone from projects where id = $1 and is_archived = false limit 1`,
    [membership.projectId],
  )).rows[0];
  if (!project) throw new TodayError("project_not_found");
  const rows = (await db.query<{
    id: string;
    title: string | null;
    handle: string | null;
    today_enabled: boolean;
  }>(
    `select channel.id, channel.title, channel.handle,
            coalesce(flag.enabled, false) as today_enabled
       from channels channel
       left join channel_feature_flags flag
         on flag.project_id = channel.project_id
        and flag.channel_id = channel.id
        and flag.feature_key = $2
      where channel.project_id = $1
        and channel.is_active = true
        and channel.status = 'active'
      order by channel.id`,
    [membership.projectId, RELEASE_1_FEATURE],
  )).rows;
  const requested = requestedChannelId == null
    ? null
    : rows.find((candidate) => Number(candidate.id) === requestedChannelId) ?? null;
  const row = requested ?? rows[0];
  return {
    projectId: membership.projectId,
    timezone: project.timezone,
    channelId: row ? Number(row.id) : null,
    label: row ? channelLabel(row) : "Канал не подключён",
    channels: rows.map((candidate) => ({
      id: Number(candidate.id),
      label: channelLabel(candidate),
      enabled: process.env.NODE_ENV !== "production" && process.env.AURORA_RELEASE1_DEV_ENABLED === "true"
        ? true
        : candidate.today_enabled === true,
    })),
  };
}

/** Returns 09:00 on the next calendar day in the selected project's timezone. */
export function nextTodayReminderAt(timezone: string, now = new Date()): string {
  const tomorrow = Temporal.Instant.from(now.toISOString())
    .toZonedDateTimeISO(timezone)
    .toPlainDate()
    .add({ days: 1 });
  const reminder = Temporal.ZonedDateTime.from({
    timeZone: timezone,
    year: tomorrow.year,
    month: tomorrow.month,
    day: tomorrow.day,
    hour: 9,
    minute: 0,
    second: 0,
  }, { disambiguation: "compatible" });
  return new Date(reminder.epochMilliseconds).toISOString();
}

function hoursAgo(value: string | null): string {
  if (!value) return "Свежесть неизвестна";
  const hours = Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 3_600_000));
  return hours < 24 ? `${hours || "<1"} ч назад` : `${Math.floor(hours / 24)} дн. назад`;
}

async function opportunityItems(db: Queryable, scope: { projectId: number; channelId: number }, label: string): Promise<TodayItem[]> {
  const rows = (await db.query<{
    id: string; title: string; confidence: "low" | "medium" | "high"; epistemic_state: string;
    observed_at: string | null; expires_at: string; fingerprint: string;
  }>(`select id, title, confidence, epistemic_state, observed_at::text, expires_at::text, fingerprint
        from opportunity_snapshots where project_id = $1 and channel_id = $2 and expires_at > now()
        order by expires_at, id desc limit 2`, [scope.projectId, scope.channelId])).rows;
  return rows.map((row, index) => ({
    fingerprint: sha(`today:${TODAY_RANKING_VERSION}:opportunity:${row.id}:${row.fingerprint}`),
    type: "opportunity", title: row.title,
    whyNow: index === 0 ? "Это самая свежая свободная тема с доказуемым источником." : "Сигнал ещё актуален и подходит для самостоятельного материала.",
    channelId: scope.channelId, channelLabel: label, confidence: row.confidence,
    epistemicState: row.epistemic_state === "insufficient_data" ? "insufficient_data" : "inferred",
    freshness: hoursAgo(row.observed_at), priority: 80 - index,
    primaryAction: { label: "Открыть возможность", href: `/app/opportunities?opportunity=${row.id}&channel=${scope.channelId}` },
    secondaryAction: { label: "Напомнить завтра", state: "snoozed" },
    evidence: { kind: "opportunity", id: Number(row.id) },
  }));
}

async function reviewItems(db: Queryable, scope: { projectId: number; channelId: number }, label: string): Promise<TodayItem[]> {
  const rows = (await db.query<{ id: string; version: string; updated_at: string; editorial_state: string; ai_validation: unknown }>(
    `select draft.id, draft.version, draft.updated_at::text,
            coalesce(workflow.state, 'draft') as editorial_state, draft.ai_validation
       from drafts draft
       join draft_destinations destination on destination.draft_id = draft.id and destination.channel_id = $2
       left join draft_editorial_workflows workflow on workflow.draft_id = draft.id and workflow.project_id = draft.project_id
      where draft.project_id = $1 and draft.purpose <> 'source_context'
        and (workflow.state in ('in_review','changes_requested') or draft.purpose = 'needs_review')
      order by draft.updated_at desc limit 2`, [scope.projectId, scope.channelId])).rows;
  return rows.map((row) => {
    const blocked = row.ai_validation && typeof row.ai_validation === "object" && (row.ai_validation as { status?: unknown }).status === "blocked";
    return {
      fingerprint: sha(`today:${TODAY_RANKING_VERSION}:review:${row.id}:${row.version}`),
      type: blocked ? "risk" as const : "review" as const,
      title: blocked ? "Исправьте заблокированный черновик" : row.editorial_state === "changes_requested" ? "Внесите запрошенные правки" : "Проверьте черновик",
      whyNow: blocked ? "Точная версия содержит блокирующее утверждение." : "Материал ждёт решения и не исчезнет после открытия.",
      channelId: scope.channelId, channelLabel: label, confidence: blocked ? "high" as const : "medium" as const,
      epistemicState: blocked ? "blocked" as const : "observed" as const, freshness: hoursAgo(row.updated_at),
      priority: blocked ? 100 : 90,
      primaryAction: { label: blocked ? "Исправить черновик" : "Проверить черновик", href: `/app/composer?draft=${row.id}&from=today` },
      secondaryAction: { label: "Напомнить завтра", state: "snoozed" as const },
      evidence: { kind: "draft" as const, id: Number(row.id) },
    };
  });
}

async function resultItems(db: Queryable, scope: { projectId: number; channelId: number }, label: string): Promise<TodayItem[]> {
  const rows = (await db.query<{
    post_id: string; stats_id: string; draft_id: string | null; views: number | null; reactions: number | null;
    collected_at: string; published_at: string;
  }>(
    `select post.id as post_id, stats.id as stats_id, operation.draft_id,
            stats.views, stats.reactions, stats.collected_at::text, post.published_at::text
       from posts post
       join lateral (
         select snapshot.id, snapshot.views, snapshot.reactions, snapshot.collected_at
           from post_stats snapshot
          where snapshot.project_id = post.project_id and snapshot.post_id = post.id
          order by snapshot.snapshot_date desc, snapshot.collected_at desc limit 1
       ) stats on true
       left join publication_operations operation
         on operation.id = post.publication_operation_id and operation.project_id = post.project_id
      where post.project_id = $1 and post.channel_id = $2
        and post.status in ('published','published_unverified')
        and post.published_at >= now() - interval '7 days'
        and (stats.views is not null or stats.reactions is not null)
      order by stats.collected_at desc, post.id desc limit 1`,
    [scope.projectId, scope.channelId],
  )).rows;
  return rows.map((row) => {
    const metrics = [
      row.views == null ? null : `${row.views.toLocaleString("ru-RU")} просмотров`,
      row.reactions == null ? null : `${row.reactions.toLocaleString("ru-RU")} реакций`,
    ].filter(Boolean).join(" · ");
    return {
      fingerprint: sha(`today:${TODAY_RANKING_VERSION}:result:${row.post_id}:${row.stats_id}`),
      type: "result", title: "Проверьте свежий результат публикации",
      whyNow: `${metrics}. Это наблюдаемый снимок, а не обещание роста.`,
      channelId: scope.channelId, channelLabel: label, confidence: "medium",
      epistemicState: "observed", freshness: hoursAgo(row.collected_at), priority: 70,
      primaryAction: { label: "Открыть результаты", href: "/app/analytics" }, secondaryAction: null,
      evidence: row.draft_id ? { kind: "draft", id: Number(row.draft_id) } : null,
    } satisfies TodayItem;
  });
}

async function applyUserState(db: Queryable, userId: number, scope: { projectId: number; channelId: number }, items: TodayItem[]) {
  if (items.length === 0) return items;
  const rows = (await db.query<{ fingerprint: string; state: string; snoozed_until: string | null }>(
    `select fingerprint, state, snoozed_until::text from today_item_states
      where project_id = $1 and channel_id = $2 and user_id = $3 and fingerprint = any($4::char(64)[])`,
    [scope.projectId, scope.channelId, userId, items.map((item) => item.fingerprint)],
  )).rows;
  const states = new Map(rows.map((row) => [row.fingerprint, row]));
  return items.filter((item) => {
    const state = states.get(item.fingerprint);
    // Старое действие «Не сегодня» не должно продолжать скрывать карточку навсегда.
    if (!state || state.state === "active" || state.state === "dismissed") return true;
    if (state.state === "snoozed" && state.snoozed_until && new Date(state.snoozed_until).getTime() <= Date.now()) return true;
    return false;
  });
}

export async function loadTodayBoard(input: { actorUserId: number; channelId: number | null }, db: Queryable = getPool()): Promise<TodayBoard> {
  const scope = await scopeFor(db, input.actorUserId, input.channelId);
  const shared = {
    featureKey: RELEASE_1_FEATURE,
    rankingVersion: TODAY_RANKING_VERSION,
    projectId: scope.projectId,
    timezone: scope.timezone,
    channelId: scope.channelId,
    channelLabel: scope.label,
    channels: scope.channels,
    updatedAt: new Date().toISOString(),
  } as const;
  if (!scope.channelId) {
    return { ...shared, enabled: true, availability: "ready", partialErrors: [], items: [{
        fingerprint: sha(`today:${TODAY_RANKING_VERSION}:onboarding:${scope.projectId}`), type: "onboarding",
        title: "Подключите первый канал", whyNow: "Без канала Аврора не смешивает демо-данные с вашими решениями.",
        channelId: null, channelLabel: scope.label, confidence: "low", epistemicState: "insufficient_data",
        freshness: "Данных пока нет", priority: 100,
        primaryAction: { label: "Подключить канал", href: "/app/settings?section=channels" }, secondaryAction: null, evidence: null,
      }] };
  }
  const enabled = await release1Enabled(db, { projectId: scope.projectId, channelId: scope.channelId });
  if (!enabled) return { ...shared, enabled: false, availability: "ready", items: [], partialErrors: [] };
  const partialErrors: TodayBoard["partialErrors"] = [];
  const collected: TodayItem[] = [];
  for (const [source, loader] of [["opportunities", opportunityItems], ["reviews", reviewItems], ["results", resultItems]] as const) {
    try { collected.push(...await loader(db, { projectId: scope.projectId, channelId: scope.channelId }, scope.label)); }
    catch { partialErrors.push({ source, message: source === "opportunities" ? "Возможности временно недоступны." : source === "reviews" ? "Проверки временно недоступны." : "Результаты временно недоступны." }); }
  }
  const availability = partialErrors.length === 3
    ? "unavailable"
    : partialErrors.length > 0
      ? "partial"
      : "ready";
  const items = availability === "unavailable"
    ? []
    : rankTodayItems(await applyUserState(
      db,
      input.actorUserId,
      { projectId: scope.projectId, channelId: scope.channelId },
      collected,
    ));
  return { ...shared, enabled, availability, items, partialErrors };
}

export async function loadTodayNavigationAvailability(
  actorUserId: number,
  db: Queryable = getPool(),
): Promise<{ visible: boolean }> {
  const scope = await scopeFor(db, actorUserId, null);
  return {
    visible: scope.channels.length === 0 || scope.channels.some((channel) => channel.enabled),
  };
}

export async function updateTodayItemState(input: {
  actorUserId: number;
  channelId: number;
  fingerprint: string;
  state: "active" | "snoozed" | "done";
  snoozedUntil?: string | null;
}, db: Queryable = getPool()) {
  if (!/^[0-9a-f]{64}$/u.test(input.fingerprint)) throw new TodayError("bad_fingerprint");
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) throw new TodayError("bad_channel");
  if (input.state === "active") {
    const scope = await scopeFor(db, input.actorUserId, input.channelId);
    if (scope.channelId !== input.channelId) throw new TodayError("item_not_found");
    const restored = await db.query(
      `delete from today_item_states
        where project_id = $1 and channel_id = $2 and user_id = $3 and fingerprint = $4
        returning fingerprint`,
      [scope.projectId, input.channelId, input.actorUserId, input.fingerprint],
    );
    if (restored.rows.length === 0) throw new TodayError("item_not_found");
    return;
  }
  const board = await loadTodayBoard({ actorUserId: input.actorUserId, channelId: input.channelId }, db);
  if (!board.enabled || !board.items.some((item) => item.fingerprint === input.fingerprint)) throw new TodayError("item_not_found");
  const snoozedUntil = input.state === "snoozed"
    ? new Date(input.snoozedUntil || nextTodayReminderAt(board.timezone))
    : null;
  if (snoozedUntil && (!Number.isFinite(snoozedUntil.getTime()) || snoozedUntil.getTime() <= Date.now())) throw new TodayError("bad_snooze");
  await db.query(
    `insert into today_item_states
       (project_id, channel_id, user_id, fingerprint, ranking_version, state, snoozed_until)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (project_id, channel_id, user_id, fingerprint) do update
       set state = excluded.state, snoozed_until = excluded.snoozed_until,
           ranking_version = excluded.ranking_version, state_version = today_item_states.state_version + 1,
           updated_at = now()`,
    [board.projectId, input.channelId, input.actorUserId, input.fingerprint, TODAY_RANKING_VERSION, input.state, snoozedUntil],
  );
}
