import { createHash } from "node:crypto";
import { Temporal } from "@js-temporal/polyfill";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import { requireSelectedProjectPermission } from "./project-permissions";
import { RELEASE_1_FEATURE, TODAY_RANKING_VERSION, release1Enabled } from "./content-intelligence";
import { topicFromSourceText } from "./reference-adaptation";

type Queryable = Pick<Pool | PoolClient, "query">;

export type TodayItemType = "opportunity" | "review" | "result" | "risk" | "onboarding";
export type TodayChannelOption = { id: number; label: string; enabled: boolean };
export type TodaySource = "reviews" | "opportunities" | "results";
export type TodayRecommendationKind = "opportunity" | "calendar_gap" | "result_success" | "result_weak" | "result_update";
export type TodaySmartAction = {
  kind: "create_opportunity_draft" | "fill_calendar_gap" | "continue_post" | "improve_post";
  subjectId: number;
  scheduledLocalDate?: string;
};
export type TodayPulse = {
  state: "ready" | "no_posts" | "no_stats" | "unavailable";
  periodLabel: string;
  publishedCount: number;
  postsWithStats: number;
  views: number;
  reactions: number;
  engagementRate: number | null;
  comparison: {
    viewsPerPostPercent: number | null;
    reactionsPerPostPercent: number | null;
    engagementPoints: number | null;
  };
  bestPost: { id: number; title: string; views: number | null; reactions: number | null; href: string } | null;
  insight: string;
  collectedAt: string | null;
};
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
  sourceLabel: string;
  smartAction: TodaySmartAction | null;
  recommendationKind: TodayRecommendationKind | null;
};

export type TodayBoard = {
  enabled: boolean;
  projectId: number;
  timezone: string;
  channelId: number | null;
  channelLabel: string;
  channels: TodayChannelOption[];
  updatedAt: string;
  lastSuccessfulAt: string | null;
  availability: "ready" | "partial" | "unavailable";
  items: TodayItem[];
  partialErrors: Array<{ source: TodaySource; message: string }>;
  sourceStatuses: Array<{
    source: TodaySource;
    status: "ready" | "error" | "not_updated";
    lastSuccessfulAt: string | null;
    message: string;
  }>;
  readiness: {
    state: "no_channel" | "admin_disabled" | "has_items" | "need_competitors" | "need_posts" | "need_stats" | "complete";
    competitorCount: number;
    opportunityCount: number;
    publishedCount: number;
    statsCount: number;
  };
  summary: { doneToday: number; snoozed: number };
  pulse: TodayPulse;
};

export class TodayError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "TodayError"; }
}

const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const TODAY_PREFERENCE_VERSION = "today-preference-v1";

export function todayPreferenceFingerprint(input: {
  projectId: number; channelId: number; recommendationKind: TodayRecommendationKind;
}): string {
  return sha(`${TODAY_PREFERENCE_VERSION}:${input.projectId}:${input.channelId}:${input.recommendationKind}`);
}

const EMPTY_PULSE: TodayPulse = {
  state: "unavailable",
  periodLabel: "Последние 7 дней",
  publishedCount: 0,
  postsWithStats: 0,
  views: 0,
  reactions: 0,
  engagementRate: null,
  comparison: { viewsPerPostPercent: null, reactionsPerPostPercent: null, engagementPoints: null },
  bestPost: null,
  insight: "Пульс появится, когда станут доступны публикации и их статистика.",
  collectedAt: null,
};

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
  if (requestedChannelId != null && !requested) throw new TodayError("channel_not_found");
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

async function nextCalendarGap(db: Queryable, scope: { projectId: number; channelId: number }, timezone: string): Promise<string | null> {
  const settings = (await db.query<{ post_frequency: string }>(
    `select least(7, greatest(1, post_frequency))::int as post_frequency
       from autopilot_settings where project_id = $1 and channel_id = $2 limit 1`,
    [scope.projectId, scope.channelId],
  )).rows[0];
  const target = Number(settings?.post_frequency ?? 0);
  if (!Number.isSafeInteger(target) || target <= 0) return null;
  const occupiedRows = (await db.query<{ local_date: string }>(
    `select distinct local_date::text
       from (
         select (post.scheduled_at at time zone $3)::date as local_date
           from posts post
          where post.project_id = $1 and post.channel_id = $2
            and post.status in ('scheduled','publishing','published','published_unverified')
            and post.scheduled_at >= ((now() at time zone $3)::date + 1)::timestamp at time zone $3
            and post.scheduled_at < ((now() at time zone $3)::date + 8)::timestamp at time zone $3
         union
         select coalesce(draft.scheduled_local_date, (draft.scheduled_at at time zone $3)::date) as local_date
           from drafts draft
           join draft_destinations destination on destination.draft_id = draft.id and destination.channel_id = $2
          where draft.project_id = $1 and draft.purpose <> 'source_context' and draft.scheduled_at is not null
            and draft.scheduled_at >= ((now() at time zone $3)::date + 1)::timestamp at time zone $3
            and draft.scheduled_at < ((now() at time zone $3)::date + 8)::timestamp at time zone $3
       ) occupied
      where local_date is not null order by local_date`,
    [scope.projectId, scope.channelId, timezone],
  )).rows;
  const occupied = new Set(occupiedRows.map((row) => String(row.local_date).slice(0, 10)));
  if (occupied.size >= target) return null;
  const tomorrow = Temporal.Now.instant().toZonedDateTimeISO(timezone).toPlainDate().add({ days: 1 });
  for (let offset = 0; offset < 7; offset += 1) {
    const candidate = tomorrow.add({ days: offset }).toString();
    if (!occupied.has(candidate)) return candidate;
  }
  return null;
}

function localDateLabel(value: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" })
      .format(new Date(`${value}T12:00:00.000Z`));
  } catch {
    return value;
  }
}

async function opportunityItems(
  db: Queryable,
  scope: { projectId: number; channelId: number },
  label: string,
  timezone: string,
): Promise<TodayItem[]> {
  const rows = (await db.query<{
    id: string; title: string; confidence: "low" | "medium" | "high"; epistemic_state: string;
    observed_at: string | null; expires_at: string; fingerprint: string; evidence: Record<string, unknown>;
  }>(`select id, title, confidence, epistemic_state, observed_at::text, expires_at::text, fingerprint, evidence
        from opportunity_snapshots where project_id = $1 and channel_id = $2 and expires_at > now()
        order by observed_at desc nulls last, expires_at desc, id desc limit 2`, [scope.projectId, scope.channelId])).rows;
  const gap = rows.length > 0 ? await nextCalendarGap(db, scope, timezone).catch(() => null) : null;
  return rows.map((row, index) => {
    const sourceId = Number(row.evidence?.sourceId);
    const actionable = row.evidence?.sourceKind === "competitor_post"
      && Number.isSafeInteger(sourceId) && sourceId > 0;
    const fillsGap = index === 0 && Boolean(gap) && actionable;
    return {
      fingerprint: sha(`today:${TODAY_RANKING_VERSION}:opportunity:${row.id}:${row.fingerprint}`),
      type: "opportunity", title: row.title,
      whyNow: fillsGap && gap
        ? `В календаре свободно ${localDateLabel(gap)}. Эта актуальная возможность лучше других подходит, чтобы заполнить окно.`
        : index === 0 ? "Это самая свежая свободная тема с доказуемым источником." : "Сигнал ещё актуален и подходит для самостоятельного материала.",
      channelId: scope.channelId, channelLabel: label, confidence: row.confidence,
      epistemicState: row.epistemic_state === "insufficient_data" ? "insufficient_data" : "inferred",
      freshness: hoursAgo(row.observed_at), priority: 80 - index,
      primaryAction: actionable
        ? { label: fillsGap ? "Заполнить окно" : "Создать черновик", href: `/app/opportunities?opportunity=${row.id}&channel=${scope.channelId}` }
        : { label: "Открыть возможность", href: `/app/opportunities?opportunity=${row.id}&channel=${scope.channelId}` },
      secondaryAction: { label: "Напомнить завтра", state: "snoozed" },
      evidence: { kind: "opportunity", id: Number(row.id) },
      sourceLabel: typeof row.evidence?.sourceLabel === "string" && row.evidence.sourceLabel.trim()
        ? row.evidence.sourceLabel : "Карта возможностей",
      smartAction: actionable ? {
        kind: fillsGap ? "fill_calendar_gap" : "create_opportunity_draft",
        subjectId: Number(row.id),
        ...(fillsGap && gap ? { scheduledLocalDate: gap } : {}),
      } as TodaySmartAction : null,
      recommendationKind: fillsGap ? "calendar_gap" : "opportunity",
    } satisfies TodayItem;
  });
}

async function reviewItems(db: Queryable, scope: { projectId: number; channelId: number }, label: string): Promise<TodayItem[]> {
  const rows = (await db.query<{ id: string; version: string; updated_at: string; editorial_state: string; ai_validation: unknown }>(
    `select draft.id, draft.version, draft.updated_at::text,
            coalesce(workflow.state, 'draft') as editorial_state, draft.ai_validation
       from drafts draft
       join draft_destinations destination on destination.draft_id = draft.id and destination.channel_id = $2
       left join draft_editorial_workflows workflow on workflow.draft_id = draft.id and workflow.project_id = draft.project_id
      where draft.project_id = $1 and draft.purpose <> 'source_context'
        and (workflow.state in ('in_review','changes_requested') or draft.purpose = 'needs_review'
          or draft.ai_validation->>'status' = 'blocked')
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
      primaryAction: {
        label: blocked || row.editorial_state === "changes_requested" ? "Исправить сейчас" : "Проверить черновик",
        href: `/app/composer?draft=${row.id}&from=today`,
      },
      secondaryAction: { label: "Напомнить завтра", state: "snoozed" as const },
      evidence: { kind: "draft" as const, id: Number(row.id) },
      sourceLabel: blocked ? "Проверка утверждений" : "Редакционный процесс",
      smartAction: null,
      recommendationKind: null,
    };
  });
}

type ResultRow = {
  post_id: string; post_text: string; stats_id: string | null; draft_id: string | null; source_topic: string | null;
  views: number | null; reactions: number | null; previous_views: number | null; previous_reactions: number | null;
  collected_at: string | null; published_at: string;
};

function localDate(value: string, timezone: string): Temporal.PlainDate {
  return Temporal.Instant.from(new Date(value).toISOString()).toZonedDateTimeISO(timezone).toPlainDate();
}

function percentChange(current: number | null, previous: number | null): number | null {
  if (current == null || previous == null || previous <= 0) return null;
  return Math.round(((current - previous) / previous) * 100);
}

function shortPostTitle(text: string): string {
  const line = text.split(/\n/u).map((part) => part.trim()).find(Boolean) || "Публикация";
  return line.length > 90 ? `${line.slice(0, 87)}…` : line;
}

export function buildTodayPulse(rows: ResultRow[], timezone: string): TodayPulse {
  const today = Temporal.Instant.from(new Date().toISOString()).toZonedDateTimeISO(timezone).toPlainDate();
  const currentStart = today.subtract({ days: 6 });
  const previousStart = today.subtract({ days: 13 });
  const current = rows.filter((row) => Temporal.PlainDate.compare(localDate(row.published_at, timezone), currentStart) >= 0);
  const previous = rows.filter((row) => {
    const date = localDate(row.published_at, timezone);
    return Temporal.PlainDate.compare(date, previousStart) >= 0 && Temporal.PlainDate.compare(date, currentStart) < 0;
  });
  const measured = current.filter((row) => row.views != null || row.reactions != null);
  const previousMeasured = previous.filter((row) => row.views != null || row.reactions != null);
  const total = (source: ResultRow[], field: "views" | "reactions") => source.reduce((sum, row) => sum + Number(row[field] ?? 0), 0);
  const views = total(measured, "views");
  const reactions = total(measured, "reactions");
  const previousViews = total(previousMeasured, "views");
  const previousReactions = total(previousMeasured, "reactions");
  const engagementRate = views > 0 ? Number(((reactions / views) * 100).toFixed(1)) : null;
  const previousEngagement = previousViews > 0 ? Number(((previousReactions / previousViews) * 100).toFixed(1)) : null;
  const viewsPerPost = measured.length > 0 ? views / measured.length : null;
  const reactionsPerPost = measured.length > 0 ? reactions / measured.length : null;
  const previousViewsPerPost = previousMeasured.length > 0 ? previousViews / previousMeasured.length : null;
  const previousReactionsPerPost = previousMeasured.length > 0 ? previousReactions / previousMeasured.length : null;
  const best = [...measured].sort((a, b) => Number(b.views ?? 0) - Number(a.views ?? 0) || Number(b.reactions ?? 0) - Number(a.reactions ?? 0) || Number(b.post_id) - Number(a.post_id))[0];
  const viewsDelta = percentChange(viewsPerPost, previousViewsPerPost);
  const engagementDelta = engagementRate != null && previousEngagement != null
    ? Number((engagementRate - previousEngagement).toFixed(1)) : null;
  const insight = previousMeasured.length === 0
    ? "Сравнение появится, когда будет статистика публикаций и за предыдущие 7 дней."
    : viewsDelta != null && Math.abs(viewsDelta) >= 20
      ? `Просмотры на публикацию ${viewsDelta > 0 ? "выросли" : "снизились"} на ${Math.abs(viewsDelta)}% к предыдущим 7 дням.`
      : engagementDelta != null && Math.abs(engagementDelta) >= 0.5
        ? `Доля реакций ${engagementDelta > 0 ? "выросла" : "снизилась"} на ${Math.abs(engagementDelta).toLocaleString("ru-RU")} п. п.`
        : "Резкого изменения не видно: продолжайте собирать статистику, чтобы отличить тенденцию от колебаний.";
  return {
    state: current.length === 0 ? "no_posts" : measured.length === 0 ? "no_stats" : "ready",
    periodLabel: "Последние 7 дней",
    publishedCount: current.length,
    postsWithStats: measured.length,
    views,
    reactions,
    engagementRate,
    comparison: {
      viewsPerPostPercent: viewsDelta,
      reactionsPerPostPercent: percentChange(reactionsPerPost, previousReactionsPerPost),
      engagementPoints: engagementDelta,
    },
    bestPost: best ? {
      id: Number(best.post_id), title: shortPostTitle(best.post_text), views: best.views, reactions: best.reactions, href: "/app/analytics",
    } : null,
    insight,
    collectedAt: measured.map((row) => row.collected_at).filter((value): value is string => Boolean(value)).sort().at(-1) ?? null,
  };
}

async function resultSource(
  db: Queryable,
  scope: { projectId: number; channelId: number },
  label: string,
  timezone: string,
): Promise<{ items: TodayItem[]; pulse: TodayPulse }> {
  const rows = (await db.query<ResultRow>(
    `select post.id as post_id, coalesce(post.text, '') as post_text, stats.id as stats_id, operation.draft_id,
            source_draft.source_ref->>'topic' as source_topic,
            stats.views, stats.reactions, stats.previous_views, stats.previous_reactions,
            stats.collected_at::text, post.published_at::text
       from posts post
       left join lateral (
         select ranked.id, ranked.views, ranked.reactions, ranked.collected_at,
                ranked.previous_views, ranked.previous_reactions
           from (
             select snapshot.id, snapshot.views, snapshot.reactions, snapshot.collected_at,
                    lag(snapshot.views) over (order by snapshot.snapshot_date, snapshot.collected_at) as previous_views,
                    lag(snapshot.reactions) over (order by snapshot.snapshot_date, snapshot.collected_at) as previous_reactions
               from post_stats snapshot
              where snapshot.project_id = post.project_id and snapshot.post_id = post.id
           ) ranked
          order by ranked.collected_at desc, ranked.id desc limit 1
       ) stats on true
       left join publication_operations operation
         on operation.id = post.publication_operation_id and operation.project_id = post.project_id
       left join drafts source_draft on source_draft.id = operation.draft_id and source_draft.project_id = post.project_id
      where post.project_id = $1 and post.channel_id = $2
        and post.status in ('published','published_unverified')
        and post.published_at >= now() - interval '30 days'
      order by post.published_at desc, post.id desc limit 100`,
    [scope.projectId, scope.channelId],
  )).rows;
  const pulse = buildTodayPulse(rows, timezone);
  const currentStart = Temporal.Instant.from(new Date().toISOString()).toZonedDateTimeISO(timezone).toPlainDate().subtract({ days: 6 });
  const measured = rows.filter((row) => (row.views != null || row.reactions != null)
    && Temporal.PlainDate.compare(localDate(row.published_at, timezone), currentStart) >= 0);
  const noteworthy = measured.find((candidate) => {
    const baseline = rows.filter((row) => Number(row.post_id) !== Number(candidate.post_id) && row.views != null && new Date(row.published_at) < new Date(candidate.published_at));
    return baseline.length >= 3;
  }) ?? measured[0];
  if (!noteworthy) return { items: [], pulse };
  const baselineValues = rows
    .filter((row) => Number(row.post_id) !== Number(noteworthy.post_id) && row.views != null && new Date(row.published_at) < new Date(noteworthy.published_at))
    .map((row) => Number(row.views)).sort((a, b) => a - b);
  const median = baselineValues.length >= 3
    ? baselineValues.length % 2 === 0
      ? (baselineValues[baselineValues.length / 2 - 1] + baselineValues[baselineValues.length / 2]) / 2
      : baselineValues[Math.floor(baselineValues.length / 2)]
    : null;
  const ageHours = Math.max(0, (Date.now() - new Date(noteworthy.published_at).getTime()) / 3_600_000);
  const resultKind = median != null && Number(noteworthy.views ?? 0) >= median * 1.25 ? "success" as const
    : median != null && ageHours >= 24 && Number(noteworthy.views ?? 0) <= median * 0.75 ? "weak" as const
      : "update" as const;
  const topic = String(noteworthy.source_topic || topicFromSourceText(noteworthy.post_text)).trim();
  const canCreate = Boolean(topic) && resultKind !== "update";
  const metrics = [
    noteworthy.views == null ? null : `${Number(noteworthy.views).toLocaleString("ru-RU")} просмотров`,
    noteworthy.reactions == null ? null : `${Number(noteworthy.reactions).toLocaleString("ru-RU")} реакций`,
  ].filter(Boolean).join(" · ");
  const comparison = median != null && noteworthy.views != null
    ? ` Медиана предыдущих публикаций — ${Math.round(median).toLocaleString("ru-RU")} просмотров.` : "";
  const action = resultKind === "success"
    ? { label: "Запланировать продолжение", kind: "continue_post" as const }
    : resultKind === "weak"
      ? { label: "Подготовить улучшенную версию", kind: "improve_post" as const }
      : null;
  const item: TodayItem = {
    fingerprint: sha(`today:${TODAY_RANKING_VERSION}:result:${noteworthy.post_id}`),
    type: "result",
    title: resultKind === "success" ? "Развить успешную публикацию" : resultKind === "weak" ? "Улучшить слабый результат" : "Проверить свежий результат публикации",
    whyNow: `${metrics}.${comparison} Это наблюдаемые данные, а не обещание роста.`,
    channelId: scope.channelId, channelLabel: label,
    confidence: baselineValues.length >= 5 ? "high" : baselineValues.length >= 3 ? "medium" : "low",
    epistemicState: "observed", freshness: hoursAgo(noteworthy.collected_at), priority: resultKind === "update" ? 70 : 72,
    primaryAction: action && canCreate ? { label: action.label, href: "/app/analytics" } : { label: "Открыть результаты", href: "/app/analytics" },
    secondaryAction: { label: "Напомнить завтра", state: "snoozed" },
    evidence: noteworthy.draft_id ? { kind: "draft", id: Number(noteworthy.draft_id) } : null,
    sourceLabel: "Статистика публикации",
    smartAction: action && canCreate ? { kind: action.kind, subjectId: Number(noteworthy.post_id) } : null,
    recommendationKind: resultKind === "success" ? "result_success" : resultKind === "weak" ? "result_weak" : "result_update",
  };
  return { items: [item], pulse };
}

/* Readiness comes from source truth, not visible cards: cards may already be done or snoozed. */
async function loadReadiness(db: Queryable, input: {
  projectId: number; channelId: number; userId: number; timezone: string;
}) {
  const row = (await db.query<{
    competitor_count: string; opportunity_count: string; published_count: string; stats_count: string;
    done_today: string; snoozed: string;
  }>(
    `select
       (select count(*)::int from competitors competitor
         where competitor.project_id = $1 and competitor.channel_id = $2 and competitor.is_active = true) as competitor_count,
       (select count(*)::int from opportunity_snapshots snapshot
         where snapshot.project_id = $1 and snapshot.channel_id = $2 and snapshot.expires_at > now()) as opportunity_count,
       (select count(*)::int from posts post
         where post.project_id = $1 and post.channel_id = $2
           and post.status in ('published','published_unverified')) as published_count,
       (select count(*)::int from post_stats stats
         join posts post on post.id = stats.post_id and post.project_id = stats.project_id
         where stats.project_id = $1 and post.channel_id = $2) as stats_count,
       (select count(*)::int from today_item_states state
         where state.project_id = $1 and state.channel_id = $2 and state.user_id = $3
           and state.state = 'done'
           and state.updated_at >= (date_trunc('day', now() at time zone $4) at time zone $4)) as done_today,
       (select count(*)::int from today_item_states state
         where state.project_id = $1 and state.channel_id = $2 and state.user_id = $3
           and state.state = 'snoozed' and state.snoozed_until > now()) as snoozed`,
    [input.projectId, input.channelId, input.userId, input.timezone],
  )).rows[0];
  return {
    competitorCount: Number(row?.competitor_count ?? 0),
    opportunityCount: Number(row?.opportunity_count ?? 0),
    publishedCount: Number(row?.published_count ?? 0),
    statsCount: Number(row?.stats_count ?? 0),
    doneToday: Number(row?.done_today ?? 0),
    snoozed: Number(row?.snoozed ?? 0),
  };
}

const SOURCE_MESSAGES: Record<TodaySource, string> = {
  reviews: "Проверки временно недоступны.",
  opportunities: "Возможности временно недоступны.",
  results: "Результаты временно недоступны.",
};

async function loadSourceStatuses(db: Queryable, scope: { projectId: number; channelId: number }) {
  const rows = (await db.query<{
    source: TodaySource; last_attempt_state: "success" | "error" | null; last_success_at: string | null;
  }>(
    `select source, last_attempt_state, last_success_at::text
       from today_source_refreshes
      where project_id = $1 and channel_id = $2
      order by case source when 'reviews' then 1 when 'opportunities' then 2 else 3 end`,
    [scope.projectId, scope.channelId],
  )).rows;
  const bySource = new Map(rows.map((row) => [row.source, row]));
  return (["reviews", "opportunities", "results"] as const).map((source) => {
    const row = bySource.get(source);
    return {
      source,
      status: row?.last_attempt_state === "error" ? "error" as const
        : row?.last_attempt_state === "success" ? "ready" as const : "not_updated" as const,
      lastSuccessfulAt: row?.last_success_at ?? null,
      message: row?.last_attempt_state === "error" ? SOURCE_MESSAGES[source]
        : row?.last_attempt_state === "success" ? "Источник обновлён." : "Источник ещё не обновлялся вручную.",
    };
  });
}

async function applyUserState(db: Queryable, userId: number, scope: { projectId: number; channelId: number }, items: TodayItem[]) {
  if (items.length === 0) return items;
  const preferences = new Map<TodayRecommendationKind, string>();
  for (const item of items) {
    if (item.recommendationKind && !preferences.has(item.recommendationKind)) {
      preferences.set(item.recommendationKind, todayPreferenceFingerprint({ ...scope, recommendationKind: item.recommendationKind }));
    }
  }
  const itemFingerprints = items.map((item) => item.fingerprint);
  const rows = (await db.query<{ fingerprint: string; state: string; snoozed_until: string | null }>(
    `select fingerprint, state, snoozed_until::text from today_item_states
      where project_id = $1 and channel_id = $2 and user_id = $3 and fingerprint = any($4::char(64)[])`,
    [scope.projectId, scope.channelId, userId, [...itemFingerprints, ...preferences.values()]],
  )).rows;
  const states = new Map(rows.map((row) => [row.fingerprint, row]));
  const hiddenKinds = new Set([...preferences.entries()]
    .filter(([, fingerprint]) => states.get(fingerprint)?.state === "dismissed")
    .map(([kind]) => kind));
  return items.filter((item) => {
    if (item.recommendationKind && hiddenKinds.has(item.recommendationKind)) return false;
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
    projectId: scope.projectId,
    timezone: scope.timezone,
    channelId: scope.channelId,
    channelLabel: scope.label,
    channels: scope.channels,
    updatedAt: new Date().toISOString(),
  } as const;
  if (!scope.channelId) {
    return {
      ...shared,
      enabled: true,
      availability: "ready",
      partialErrors: [],
      sourceStatuses: [],
      lastSuccessfulAt: null,
      items: [],
      pulse: EMPTY_PULSE,
      readiness: {
        state: "no_channel", competitorCount: 0, opportunityCount: 0, publishedCount: 0, statsCount: 0,
      },
      summary: { doneToday: 0, snoozed: 0 },
    };
  }
  const enabled = await release1Enabled(db, { projectId: scope.projectId, channelId: scope.channelId });
  if (!enabled) return {
    ...shared,
    enabled: false,
    availability: "ready",
    items: [],
    partialErrors: [],
    sourceStatuses: [],
    lastSuccessfulAt: null,
    pulse: EMPTY_PULSE,
    readiness: {
      state: "admin_disabled", competitorCount: 0, opportunityCount: 0, publishedCount: 0, statsCount: 0,
    },
    summary: { doneToday: 0, snoozed: 0 },
  };
  const channelId = scope.channelId;
  const sourceScope = { projectId: scope.projectId, channelId };
  const loaded = await Promise.all([
    (async () => {
      try { return { source: "opportunities" as const, items: await opportunityItems(db, sourceScope, scope.label, scope.timezone), failed: false, pulse: null }; }
      catch { return { source: "opportunities" as const, items: [] as TodayItem[], failed: true, pulse: null }; }
    })(),
    (async () => {
      try { return { source: "reviews" as const, items: await reviewItems(db, sourceScope, scope.label), failed: false, pulse: null }; }
      catch { return { source: "reviews" as const, items: [] as TodayItem[], failed: true, pulse: null }; }
    })(),
    (async () => {
      try {
        const result = await resultSource(db, sourceScope, scope.label, scope.timezone);
        return { source: "results" as const, items: result.items, failed: false, pulse: result.pulse };
      } catch { return { source: "results" as const, items: [] as TodayItem[], failed: true, pulse: EMPTY_PULSE }; }
    })(),
  ]);
  const collected = loaded.flatMap((result) => result.items);
  const sourceStatuses = await loadSourceStatuses(db, {
    projectId: scope.projectId,
    channelId,
  }).catch(() => (["reviews", "opportunities", "results"] as const).map((source) => ({
    source,
    status: "not_updated" as const,
    lastSuccessfulAt: null,
    message: "Статус обновления пока неизвестен.",
  })));
  const partialErrors: TodayBoard["partialErrors"] = loaded
    .filter((result) => result.failed)
    .map((result) => ({ source: result.source, message: SOURCE_MESSAGES[result.source] }));
  for (const status of sourceStatuses) {
    if (status.status === "error" && !partialErrors.some((error) => error.source === status.source)) {
      partialErrors.push({ source: status.source, message: status.message });
    }
  }
  const failedLoaders = loaded.filter((result) => result.failed).length;
  const availability = failedLoaders === loaded.length
    ? "unavailable"
    : partialErrors.length > 0
      ? "partial"
      : "ready";
  const items = availability === "unavailable"
    ? []
    : rankTodayItems(await applyUserState(
      db,
      input.actorUserId,
      { projectId: scope.projectId, channelId },
      collected,
    ));
  const readinessData = await loadReadiness(db, {
    projectId: scope.projectId,
    channelId,
    userId: input.actorUserId,
    timezone: scope.timezone,
  }).catch(() => ({ competitorCount: 0, opportunityCount: 0, publishedCount: 0, statsCount: 0, doneToday: 0, snoozed: 0 }));
  const readinessState = items.length > 0 ? "has_items" as const
    : readinessData.opportunityCount === 0 && readinessData.competitorCount < 2 ? "need_competitors" as const
      : readinessData.publishedCount === 0 ? "need_posts" as const
        : readinessData.statsCount === 0 ? "need_stats" as const : "complete" as const;
  const successfulTimes = sourceStatuses
    .map((status) => status.lastSuccessfulAt)
    .filter((value): value is string => Boolean(value))
    .sort();
  return {
    ...shared,
    enabled,
    availability,
    items,
    partialErrors,
    sourceStatuses,
    lastSuccessfulAt: successfulTimes.at(-1) ?? null,
    readiness: {
      state: readinessState,
      competitorCount: readinessData.competitorCount,
      opportunityCount: readinessData.opportunityCount,
      publishedCount: readinessData.publishedCount,
      statsCount: readinessData.statsCount,
    },
    summary: { doneToday: readinessData.doneToday, snoozed: readinessData.snoozed },
    pulse: loaded.find((result) => result.source === "results")?.pulse ?? EMPTY_PULSE,
  };
}

export async function setTodayRecommendationPreference(input: {
  actorUserId: number;
  channelId: number;
  recommendationKind: TodayRecommendationKind;
  state: "hidden" | "active";
}, db: Queryable = getPool()) {
  const allowed = new Set<TodayRecommendationKind>(["opportunity", "calendar_gap", "result_success", "result_weak", "result_update"]);
  if (!allowed.has(input.recommendationKind)) throw new TodayError("bad_recommendation_kind");
  if (!Number.isSafeInteger(input.channelId) || input.channelId <= 0) throw new TodayError("bad_channel");
  const scope = await scopeFor(db, input.actorUserId, input.channelId);
  if (scope.channelId !== input.channelId) throw new TodayError("channel_not_found");
  const fingerprint = todayPreferenceFingerprint({
    projectId: scope.projectId,
    channelId: input.channelId,
    recommendationKind: input.recommendationKind,
  });
  if (input.state === "active") {
    await db.query(
      `delete from today_item_states
        where project_id = $1 and channel_id = $2 and user_id = $3 and fingerprint = $4`,
      [scope.projectId, input.channelId, input.actorUserId, fingerprint],
    );
    return;
  }
  await db.query(
    `insert into today_item_states
       (project_id, channel_id, user_id, fingerprint, ranking_version, state, snoozed_until)
     values ($1, $2, $3, $4, $5, 'dismissed', null)
     on conflict (project_id, channel_id, user_id, fingerprint) do update
       set state = 'dismissed', snoozed_until = null, ranking_version = excluded.ranking_version,
           state_version = today_item_states.state_version + 1, updated_at = now()`,
    [scope.projectId, input.channelId, input.actorUserId, fingerprint, TODAY_PREFERENCE_VERSION],
  );
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
