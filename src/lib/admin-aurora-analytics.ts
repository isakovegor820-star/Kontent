import type { Pool } from "pg";

import {
  AURORA_SECTION_BY_ID,
  AURORA_SECTION_CATALOG,
  auroraSloFor,
  isAuroraSectionId,
  type AuroraSectionId,
  type AuroraSloKind,
} from "./aurora-section-catalog";

type Queryable = Pick<Pool, "query">;

export const AURORA_ANALYTICS_RANGES = ["24h", "7d", "30d", "custom"] as const;
export const AURORA_ANALYTICS_TABS = ["overview", "funnel", "errors", "speed", "events"] as const;
export const AURORA_ANALYTICS_SEGMENTS = ["all", "owners", "team"] as const;
export const AURORA_ANALYTICS_TENURES = ["all", "new", "returning"] as const;
export const AURORA_ANALYTICS_DEVICES = ["all", "desktop", "mobile", "tablet", "unknown"] as const;

export type AuroraAnalyticsRange = (typeof AURORA_ANALYTICS_RANGES)[number];
export type AuroraAnalyticsTab = (typeof AURORA_ANALYTICS_TABS)[number];
export type AuroraAnalyticsSegment = (typeof AURORA_ANALYTICS_SEGMENTS)[number];
export type AuroraAnalyticsTenure = (typeof AURORA_ANALYTICS_TENURES)[number];
export type AuroraAnalyticsDevice = (typeof AURORA_ANALYTICS_DEVICES)[number];
export type AuroraAnalyticsHealthState = "healthy" | "degraded" | "down" | "unobserved";

export interface AdminAuroraAnalyticsFilters {
  range: AuroraAnalyticsRange;
  from: string;
  to: string;
  previousFrom: string;
  previousTo: string;
  projectId: number | null;
  segment: AuroraAnalyticsSegment;
  tenure: AuroraAnalyticsTenure;
  device: AuroraAnalyticsDevice;
  appVersion: string | null;
  release: string | null;
  sectionId: AuroraSectionId | null;
  tab: AuroraAnalyticsTab;
}

export interface AuroraMetricValue {
  current: number;
  previous: number;
  changePercent: number | null;
}

export interface AuroraNullableMetricValue {
  current: number | null;
  previous: number | null;
  changePercent: number | null;
}

export interface AuroraUsefulOutcome {
  coverage: "available" | "not_filterable" | "unobserved";
  label: string;
  attempts: AuroraMetricValue;
  attemptUsers: AuroraMetricValue;
  successes: AuroraMetricValue;
  failures: AuroraMetricValue;
  uniqueUsers: AuroraMetricValue;
  successRate: AuroraMetricValue;
  timeToResultP50Ms: AuroraNullableMetricValue;
  lastSuccessAt: string | null;
  reason: string | null;
}

export interface AuroraAnalyticsSectionCard {
  id: AuroraSectionId;
  label: string;
  href: string;
  groupId: string;
  groupTitle: string;
  activity: {
    uniqueUsers: AuroraMetricValue;
    sessions: AuroraMetricValue;
    launches: AuroraMetricValue;
    keyActions: AuroraMetricValue;
  };
  technical: {
    state: AuroraAnalyticsHealthState;
    errorRate: AuroraMetricValue;
    affectedUsers: AuroraMetricValue;
    p50Ms: AuroraMetricValue;
    p95Ms: AuroraMetricValue;
    p99Ms: AuroraMetricValue;
    pageP95Ms: number | null;
    observations: number;
    reason: string;
  };
  outcome: AuroraUsefulOutcome;
  dependencies: readonly string[];
}

export interface AuroraAnalyticsFunnelStep {
  id: "opening" | "action_started" | "server_confirmed" | "result" | "further_use";
  label: string;
  users: AuroraMetricValue;
  conversionPercent: number | null;
  dropoffUsers: number | null;
  durationP50Ms: number | null;
  errors: number;
  evidence: "product_event" | "domain_table" | "combined";
}

export interface AuroraAnalyticsErrorGroup {
  errorCode: string;
  title: string;
  sectionId: AuroraSectionId;
  featureId: string;
  stage: string;
  source: "frontend" | "api" | "worker" | "bot" | "system";
  count: number;
  previousCount: number;
  affectedUsers: number;
  affectedProjects: number;
  firstSeenAt: string;
  lastSeenAt: string;
  release: string | null;
  requestId: string | null;
  status: "active" | "regression" | "recurring";
  sentryUrl: string | null;
  dependencyId: string | null;
}

export interface AuroraAnalyticsSpeedGroup {
  source: string;
  operationKind: string;
  release: string | null;
  observations: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  failures: number;
  sloKind: AuroraSloKind | null;
  sloP95Ms: number | null;
  withinSlo: boolean | null;
}

export interface AuroraAnalyticsEventItem {
  id: string;
  occurredAt: string;
  sectionId: AuroraSectionId;
  featureId: string;
  action: string;
  stage: string;
  outcome: string;
  durationMs: number | null;
  errorCode: string | null;
  requestId: string | null;
  operationId: string | null;
  release: string | null;
  device: string;
  source: string;
  operationKind: string | null;
  userRef: string;
  projectRef: string;
}

export interface AuroraAnalyticsProblem {
  id: string;
  kind: "error_growth" | "provider_failure" | "conversion_drop" | "latency" | "stale" | "stuck_stage" | "release_regression";
  title: string;
  sectionId: AuroraSectionId;
  affectedUsers: number;
  frequency: number;
  severity: number;
  impact: number;
  formula: string;
  evidence: string;
  dependencyId: string | null;
  sentryUrl: string | null;
}

export interface AdminAuroraAnalytics {
  schemaVersion: 1;
  checkedAt: string;
  filters: AdminAuroraAnalyticsFilters;
  rawRetentionDays: number;
  coverage: {
    rawFrom: string;
    domainFiltersApplied: boolean;
    notes: string[];
  };
  options: {
    projects: Array<{ id: number; label: string }>;
    releases: string[];
    appVersions: string[];
  };
  releases: Array<{ release: string; commitSha: string | null; deployedAt: string }>;
  timeline: Array<{
    bucket: string;
    sectionId: AuroraSectionId;
    users: number;
    launches: number;
    successes: number;
    failures: number;
    p95Ms: number | null;
  }>;
  sections: AuroraAnalyticsSectionCard[];
  problems: AuroraAnalyticsProblem[];
  detail: null | {
    sectionId: AuroraSectionId;
    tab: AuroraAnalyticsTab;
    scenario: readonly string[];
    slos: typeof AURORA_SECTION_CATALOG[number]["slos"];
    funnel: AuroraAnalyticsFunnelStep[];
    errors: AuroraAnalyticsErrorGroup[];
    speed: AuroraAnalyticsSpeedGroup[];
    events: AuroraAnalyticsEventItem[];
  };
}

export class AdminAnalyticsQueryError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AdminAnalyticsQueryError";
    this.code = code;
  }
}

const DAY_MS = 86_400_000;
const MAX_CUSTOM_RANGE_MS = 90 * DAY_MS;
const SAFE_FILTER_VALUE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/u;
const OUTCOME_LABELS: Record<AuroraSectionId, string> = {
  today: "Выполненные задачи",
  calendar: "Запланированные или опубликованные материалы",
  studio: "Подтверждённые результаты генерации",
  autopilot: "Утверждённые или завершённые планы",
  composer: "Сохранённые редактором черновики",
  library: "Просмотренные или оценённые материалы",
  rss: "Сохранённые или использованные инфоповоды",
  knowledge: "Проиндексированные источники",
  recon: "Синхронизированные конкуренты",
  opportunities: "Построенные снимки возможностей",
  radar: "Завершённые поисковые запуски",
  siteAnalysis: "Готовые отчёты анализа сайта",
  sites: "Опубликованные на сайт материалы",
  growth: "Выполненные рекомендации развития",
  analytics: "Подтверждённые tracking-снимки",
  settings: "Сохранённые изменения настроек",
};

function includesValue<const T extends readonly string[]>(values: T, value: string): value is T[number] {
  return values.includes(value as T[number]);
}

function parseDate(value: string, endOfDay: boolean): Date {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/u.test(value);
  const date = new Date(dateOnly ? `${value}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z` : value);
  if (!Number.isFinite(date.getTime())) throw new AdminAnalyticsQueryError("analytics_date_invalid");
  return date;
}

function safeOptionalFilter(params: URLSearchParams, key: string): string | null {
  const value = params.get(key);
  if (value == null || value === "" || value === "all") return null;
  if (!SAFE_FILTER_VALUE.test(value)) throw new AdminAnalyticsQueryError(`analytics_${key}_invalid`);
  return value;
}

function projectFilter(params: URLSearchParams): number | null {
  const value = params.get("project");
  if (value == null || value === "" || value === "all") return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new AdminAnalyticsQueryError("analytics_project_invalid");
  }
  return parsed;
}

export function normalizeAdminAnalyticsQuery(
  source: URLSearchParams,
  now = new Date(),
): AdminAuroraAnalyticsFilters {
  const rangeValue = source.get("range") ?? "7d";
  if (!includesValue(AURORA_ANALYTICS_RANGES, rangeValue)) {
    throw new AdminAnalyticsQueryError("analytics_range_invalid");
  }
  const range = rangeValue;
  let to = new Date(now);
  let from: Date;
  if (range === "custom") {
    const fromValue = source.get("from");
    const toValue = source.get("to");
    if (!fromValue || !toValue) throw new AdminAnalyticsQueryError("analytics_custom_range_required");
    from = parseDate(fromValue, false);
    to = parseDate(toValue, true);
  } else {
    const duration = range === "24h" ? DAY_MS : range === "30d" ? 30 * DAY_MS : 7 * DAY_MS;
    from = new Date(to.getTime() - duration);
  }
  const durationMs = to.getTime() - from.getTime();
  if (durationMs <= 0 || durationMs > MAX_CUSTOM_RANGE_MS) {
    throw new AdminAnalyticsQueryError("analytics_range_out_of_bounds");
  }
  // Do not accept future windows: they are almost always a timezone/input mistake and
  // make previous-period comparisons misleading.
  if (to.getTime() > now.getTime() + 5 * 60_000) {
    throw new AdminAnalyticsQueryError("analytics_future_range");
  }

  const segmentValue = source.get("segment") ?? "all";
  const tenureValue = source.get("tenure") ?? "all";
  const deviceValue = source.get("device") ?? "all";
  const tabValue = source.get("analyticsTab") ?? "overview";
  if (!includesValue(AURORA_ANALYTICS_SEGMENTS, segmentValue)) throw new AdminAnalyticsQueryError("analytics_segment_invalid");
  if (!includesValue(AURORA_ANALYTICS_TENURES, tenureValue)) throw new AdminAnalyticsQueryError("analytics_tenure_invalid");
  if (!includesValue(AURORA_ANALYTICS_DEVICES, deviceValue)) throw new AdminAnalyticsQueryError("analytics_device_invalid");
  if (!includesValue(AURORA_ANALYTICS_TABS, tabValue)) throw new AdminAnalyticsQueryError("analytics_tab_invalid");
  const sectionValue = source.get("analyticsSection");
  if (sectionValue != null && !isAuroraSectionId(sectionValue)) {
    throw new AdminAnalyticsQueryError("analytics_section_invalid");
  }
  const previousTo = new Date(from);
  const previousFrom = new Date(from.getTime() - durationMs);
  return {
    range,
    from: from.toISOString(),
    to: to.toISOString(),
    previousFrom: previousFrom.toISOString(),
    previousTo: previousTo.toISOString(),
    projectId: projectFilter(source),
    segment: segmentValue,
    tenure: tenureValue,
    device: deviceValue,
    appVersion: safeOptionalFilter(source, "version"),
    release: safeOptionalFilter(source, "release"),
    sectionId: sectionValue && isAuroraSectionId(sectionValue) ? sectionValue : null,
    tab: tabValue,
  };
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: unknown): string {
  const parsed = value instanceof Date ? value : new Date(String(value ?? ""));
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : new Date(0).toISOString();
}

function nullableIso(value: unknown): string | null {
  return value == null ? null : iso(value);
}

function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 10_000) / 100;
}

function metric(current: number, previous: number): AuroraMetricValue {
  return { current, previous, changePercent: changePercent(current, previous) };
}

function nullableMetric(current: number | null, previous: number | null): AuroraNullableMetricValue {
  return {
    current,
    previous,
    changePercent: current == null || previous == null ? null : changePercent(current, previous),
  };
}

function rate(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 10_000) / 100 : 0;
}

const PRODUCT_SCOPE_SQL = `
  with event_periods as (
    select event.*,
           case when event.occurred_at >= $1::timestamptz then 'current' else 'previous' end as period,
           case when event.occurred_at >= $1::timestamptz then $1::timestamptz else $3::timestamptz end as period_start,
           case when event.occurred_at >= $1::timestamptz then $2::timestamptz else $4::timestamptz end as period_end
      from product_events event
     where event.occurred_at >= $3::timestamptz
       and event.occurred_at < $2::timestamptz
       and ($5::bigint is null or event.project_id = $5::bigint)
       and ($8::text = 'all' or coalesce(event.safe_context->>'device', 'unknown') = $8::text)
       and ($9::text is null or event.safe_context->>'appVersion' = $9::text)
       and ($10::text is null or event.release_key = $10::text)
       and ($11::text is null or event.section_id = $11::text)
  ), scoped_events as (
    select event.*
      from event_periods event
      join users app_user on app_user.id = event.user_id
     where (
       $6::text = 'all'
       or exists (
         select 1 from project_members member
          where member.project_id = event.project_id
            and member.user_id = event.user_id
            and member.status = 'active'
            and (($6::text = 'owners' and member.role = 'owner') or ($6::text = 'team' and member.role <> 'owner'))
       )
     )
       and (
         $7::text = 'all'
         or ($7::text = 'new' and app_user.created_at >= event.period_start and app_user.created_at < event.period_end)
         or ($7::text = 'returning' and app_user.created_at < event.period_start)
       )
  )`;

function queryParams(filters: AdminAuroraAnalyticsFilters, sectionOverride?: AuroraSectionId | null) {
  return [
    filters.from,
    filters.to,
    filters.previousFrom,
    filters.previousTo,
    filters.projectId,
    filters.segment,
    filters.tenure,
    filters.device,
    filters.appVersion,
    filters.release,
    sectionOverride === undefined ? filters.sectionId : sectionOverride,
  ];
}

type SectionMetricRow = {
  section_id: string;
  period: "current" | "previous";
  unique_users: unknown;
  sessions: unknown;
  launches: unknown;
  key_actions: unknown;
  successes: unknown;
  failures: unknown;
  affected_users: unknown;
  observations: unknown;
  p50_ms: unknown;
  p95_ms: unknown;
  p99_ms: unknown;
  page_p95_ms: unknown;
  time_to_result_p50_ms: unknown;
  last_success_at: unknown;
};

async function loadSectionMetrics(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  return db.query<SectionMetricRow>(
    `/* admin_aurora_section_metrics */
     ${PRODUCT_SCOPE_SQL},
     section_metrics as (
       select section_id, period,
            count(distinct user_id) as unique_users,
            count(distinct session_id) filter (where session_id is not null) as sessions,
            count(*) filter (where action = 'loaded') as launches,
            count(*) filter (where action <> 'loaded') as key_actions,
            count(*) filter (where outcome = 'success' and stage = 'completed') as successes,
            count(*) filter (where outcome = 'failure') as failures,
            count(distinct user_id) filter (where outcome = 'failure') as affected_users,
            count(duration_ms) as observations,
            percentile_cont(0.50) within group (order by duration_ms) filter (where duration_ms is not null) as p50_ms,
            percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null) as p95_ms,
            percentile_cont(0.99) within group (order by duration_ms) filter (where duration_ms is not null) as p99_ms,
            percentile_cont(0.95) within group (order by duration_ms)
              filter (where duration_ms is not null and safe_context->>'operationKind' = 'page_load') as page_p95_ms,
            max(occurred_at) filter (where outcome = 'success') as last_success_at
         from scoped_events
        group by section_id, period
     ), journey_sessions as (
       select section_id, period, user_id, session_id,
              min(occurred_at) filter (where action = 'loaded') as opened_at,
              min(occurred_at) filter (
                where action <> 'loaded' and outcome = 'success' and stage = 'completed'
              ) as result_at
         from scoped_events
        where session_id is not null
        group by section_id, period, user_id, session_id
     ), journey_metrics as (
       select section_id, period,
              percentile_cont(0.50) within group (
                order by extract(epoch from (result_at - opened_at)) * 1000
              ) as time_to_result_p50_ms
         from journey_sessions
        where opened_at is not null and result_at is not null and result_at >= opened_at
        group by section_id, period
     )
     select metric.*, journey.time_to_result_p50_ms
       from section_metrics metric
       left join journey_metrics journey
         on journey.section_id = metric.section_id and journey.period = metric.period`,
    // Cards must always cover all 15 sections; the section URL controls detail only.
    queryParams(filters, null),
  );
}

const DOMAIN_EVENTS_SQL = `
  select 'today'::text as section_id, state.project_id, state.user_id,
         state.updated_at as occurred_at,
         case when state.state = 'done' then 'success' else 'neutral' end as outcome
    from today_item_states state
  union all
  select 'calendar', post.project_id, post.user_id, post.created_at,
         case when post.status in ('scheduled','published') then 'success' when post.status = 'failed' then 'failure' else 'neutral' end
    from posts post
  union all
  select 'studio', channel.project_id, operation.user_id, operation.created_at,
         case when operation.status = 'acknowledged' then 'success' when operation.status in ('failed','retryable_failed') then 'failure' else 'neutral' end
    from generation_operations operation join channels channel on channel.id = operation.channel_id
  union all
  select 'autopilot', plan.project_id, plan.user_id, plan.created_at,
         case when plan.status in ('approved','done') then 'success' when plan.status = 'error' then 'failure' else 'neutral' end
    from autopilot_plan plan
  union all
  select 'composer', draft.project_id, draft.user_id, draft.updated_at, 'success'
    from drafts draft where draft.purpose <> 'source_context'
  union all
  select 'library', channel.project_id, state.user_id, state.updated_at,
         case when state.viewed_at is not null or state.rating is not null then 'success' else 'neutral' end
    from library_item_states state join channels channel on channel.id = state.channel_id
  union all
  select 'rss', channel.project_id, state.user_id, state.updated_at,
         case when state.state in ('saved','used') then 'success' else 'neutral' end
    from legal_opportunity_states state
    join rss_items item on item.id = state.rss_item_id
    join rss_feeds feed on feed.id = item.feed_id
    join channels channel on channel.id = feed.channel_id
  union all
  select 'knowledge', channel.project_id, source.user_id, source.added_at,
         case when source.status = 'ready' then 'success' when source.status = 'error' then 'failure' else 'neutral' end
    from knowledge_sources source join channels channel on channel.id = source.channel_id
  union all
  select 'recon', channel.project_id, competitor.user_id, competitor.added_at,
         case when competitor.status = 'ready' then 'success' when competitor.status = 'error' then 'failure' else 'neutral' end
    from competitors competitor join channels channel on channel.id = competitor.channel_id
  union all
  select 'opportunities', snapshot.project_id, channel.user_id, snapshot.created_at, 'success'
    from opportunity_snapshots snapshot join channels channel on channel.id = snapshot.channel_id
  union all
  select 'radar', channel.project_id, run.user_id, run.created_at,
         case when run.status in ('ready','partial') then 'success' when run.status = 'failed' then 'failure' else 'neutral' end
    from radar_search_runs run join channels channel on channel.id = run.channel_id
  union all
  select 'siteAnalysis', job.project_id, job.user_id, job.created_at,
         case when job.status = 'ready' then 'success' when job.status = 'failed' then 'failure' else 'neutral' end
    from site_analysis_jobs job where job.project_id is not null
  union all
  select 'sites', article.project_id, article.user_id, article.updated_at,
         case when article.status = 'published' then 'success'
              when article.status in ('failed','rejected') then 'failure' else 'neutral' end
    from site_articles article
  union all
  select 'growth', move.project_id, channel.user_id, move.updated_at,
         case when move.status = 'done' then 'success' else 'neutral' end
    from growth_moves move join channels channel on channel.id = move.channel_id
  union all
  select 'analytics', snapshot.project_id, post.user_id, snapshot.created_at, 'success'
    from publication_tracking_snapshots snapshot join posts post on post.id = snapshot.post_id
  union all
  select 'settings', audit.project_id, audit.actor_user_id, audit.created_at, 'success'
    from audit_events audit
   where audit.actor_user_id is not null
     and (audit.action like 'settings.%' or audit.entity_type in ('channel','project','profile','integration'))`;

type DomainOutcomeRow = {
  section_id: string;
  period: "current" | "previous";
  attempts: unknown;
  attempt_users: unknown;
  successes: unknown;
  failures: unknown;
  unique_users: unknown;
  last_success_at: unknown;
};

function domainFiltersApplied(filters: AdminAuroraAnalyticsFilters): boolean {
  return filters.device === "all" && filters.appVersion === null && filters.release === null;
}

async function loadDomainOutcomes(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  if (!domainFiltersApplied(filters)) return [] as DomainOutcomeRow[];
  const result = await db.query<DomainOutcomeRow>(
    `/* admin_aurora_domain_outcomes */
     with domain_events as (${DOMAIN_EVENTS_SQL}),
     event_periods as (
       select event.*,
              case when event.occurred_at >= $1::timestamptz then 'current' else 'previous' end as period,
              case when event.occurred_at >= $1::timestamptz then $1::timestamptz else $3::timestamptz end as period_start,
              case when event.occurred_at >= $1::timestamptz then $2::timestamptz else $4::timestamptz end as period_end
         from domain_events event
        where event.project_id is not null
          and event.user_id is not null
          and event.occurred_at >= $3::timestamptz and event.occurred_at < $2::timestamptz
          and ($5::bigint is null or event.project_id = $5::bigint)
     ), scoped as (
       select event.* from event_periods event
       join users app_user on app_user.id = event.user_id
       where ($6::text = 'all' or exists (
         select 1 from project_members member
          where member.project_id = event.project_id and member.user_id = event.user_id
            and member.status = 'active'
            and (($6::text = 'owners' and member.role = 'owner') or ($6::text = 'team' and member.role <> 'owner'))
       ))
       and ($7::text = 'all'
         or ($7::text = 'new' and app_user.created_at >= event.period_start and app_user.created_at < event.period_end)
         or ($7::text = 'returning' and app_user.created_at < event.period_start))
     )
     select section_id, period, count(*) as attempts,
            count(distinct user_id) as attempt_users,
            count(*) filter (where outcome = 'success') as successes,
            count(*) filter (where outcome = 'failure') as failures,
            count(distinct user_id) filter (where outcome = 'success') as unique_users,
            max(occurred_at) filter (where outcome = 'success') as last_success_at
       from scoped group by section_id, period`,
    [filters.from, filters.to, filters.previousFrom, filters.previousTo, filters.projectId, filters.segment, filters.tenure],
  );
  return result.rows;
}

type TimelineRow = {
  bucket: unknown;
  section_id: string;
  users: unknown;
  launches: unknown;
  successes: unknown;
  failures: unknown;
  p95_ms: unknown;
};

async function loadTimeline(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  const bucket = filters.range === "24h" ? "hour" : "day";
  return db.query<TimelineRow>(
    `/* admin_aurora_timeline */
     ${PRODUCT_SCOPE_SQL}
     select date_trunc('${bucket}', occurred_at) as bucket, section_id,
            count(distinct user_id) as users,
            count(*) filter (where action = 'loaded') as launches,
            count(*) filter (where outcome = 'success' and stage = 'completed') as successes,
            count(*) filter (where outcome = 'failure') as failures,
            percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null) as p95_ms
       from scoped_events where period = 'current'
      group by date_trunc('${bucket}', occurred_at), section_id
      order by bucket asc, section_id asc`,
    queryParams(filters, null),
  );
}

type ErrorRow = {
  section_id: string;
  feature_id: string;
  stage: string;
  source: string | null;
  error_code: string;
  period: "current" | "previous";
  count: unknown;
  affected_users: unknown;
  affected_projects: unknown;
  first_seen_at: unknown;
  last_seen_at: unknown;
  release_key: string | null;
  request_id: string | null;
};

async function loadErrors(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  const product = db.query<ErrorRow>(
    `/* admin_aurora_errors */
     ${PRODUCT_SCOPE_SQL}
     select section_id, feature_id, stage,
            coalesce(safe_context->>'source', 'ui') as source,
            error_code, period, count(*) as count,
            count(distinct user_id) as affected_users,
            count(distinct project_id) as affected_projects,
            min(occurred_at) as first_seen_at,
            max(occurred_at) as last_seen_at,
            (array_agg(release_key order by occurred_at desc) filter (where release_key is not null))[1] as release_key,
            (array_agg(request_id order by occurred_at desc) filter (where request_id is not null))[1] as request_id
       from scoped_events
      where outcome = 'failure' and error_code is not null
      group by section_id, feature_id, stage, coalesce(safe_context->>'source', 'ui'), error_code, period
      order by count(*) desc
      limit 300`,
    queryParams(filters, null),
  );
  if (!domainFiltersApplied(filters)) return product;
  const domain = db.query<ErrorRow>(
    `/* admin_aurora_domain_errors */
     with domain_errors as (
       select 'studio'::text as section_id, 'generation'::text as feature_id,
              'failed'::text as stage, 'api'::text as source,
              operation.error_code::text, channel.project_id, operation.user_id,
              operation.created_at as occurred_at, operation.server_request_id::text as request_id
         from generation_operations operation
         join channels channel on channel.id = operation.channel_id
        where operation.error_code ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'studio', 'generation', 'failed', 'worker', generation.error_code,
              generation.project_id, generation.user_id, generation.created_at, generation.request_id::text
         from media_generations generation
        where generation.status = 'failed' and generation.error_code ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'siteAnalysis', 'analysis', 'failed', 'worker', job.error_code,
              job.project_id, job.user_id, job.created_at, job.request_id
         from site_analysis_jobs job
        where job.project_id is not null and job.status = 'failed' and job.error_code ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'sites', 'site', 'failed', 'worker', article.status_reason,
              article.project_id, article.user_id, article.updated_at, null::text
         from site_articles article
        where article.status = 'failed' and article.status_reason ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'radar', 'search', 'failed', 'worker', run.error_code,
              channel.project_id, run.user_id, run.created_at, null::text
         from radar_search_runs run join channels channel on channel.id = run.channel_id
        where run.status = 'failed' and run.error_code ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'calendar', 'publication', 'queued', 'worker', outbox.last_error_code,
              operation.project_id, operation.user_id, outbox.updated_at, null::text
         from publication_outbox outbox join publication_operations operation on operation.id = outbox.operation_id
        where outbox.status = 'failed' and outbox.last_error_code ~ '^[a-z0-9_]{1,100}$'
       union all
       select 'composer', 'draft', 'failed', 'worker', attempt.safe_error_code,
              attempt.project_id, operation.requested_by_user_id, attempt.started_at, null::text
         from publication_extra_attempts attempt
         join publication_extra_operations operation
           on operation.id = attempt.operation_id and operation.project_id = attempt.project_id
        where attempt.status in ('failed','failed_retry') and attempt.safe_error_code is not null
       union all
       select 'settings', 'configuration', 'failed', 'api', event.safe_error_code,
              channel.project_id, event.actor_user_id, event.created_at, event.request_id
         from channel_events event join channels channel on channel.id = event.channel_id
        where event.actor_user_id is not null and event.safe_error_code ~ '^[a-z0-9_]{1,100}$'
     ), periods as (
       select event.*,
              case when event.occurred_at >= $1::timestamptz then 'current' else 'previous' end as period,
              case when event.occurred_at >= $1::timestamptz then $1::timestamptz else $3::timestamptz end as period_start,
              case when event.occurred_at >= $1::timestamptz then $2::timestamptz else $4::timestamptz end as period_end
         from domain_errors event
        where event.project_id is not null and event.user_id is not null
          and event.occurred_at >= $3::timestamptz and event.occurred_at < $2::timestamptz
          and ($5::bigint is null or event.project_id = $5::bigint)
     ), scoped as (
       select event.* from periods event join users app_user on app_user.id = event.user_id
        where ($6::text = 'all' or exists (
          select 1 from project_members member
           where member.project_id = event.project_id and member.user_id = event.user_id
             and member.status = 'active'
             and (($6::text = 'owners' and member.role = 'owner') or ($6::text = 'team' and member.role <> 'owner'))
        ))
          and ($7::text = 'all'
            or ($7::text = 'new' and app_user.created_at >= event.period_start and app_user.created_at < event.period_end)
            or ($7::text = 'returning' and app_user.created_at < event.period_start))
     )
     select section_id, feature_id, stage, source, error_code, period,
            count(*) as count, count(distinct user_id) as affected_users,
            count(distinct project_id) as affected_projects,
            min(occurred_at) as first_seen_at, max(occurred_at) as last_seen_at,
            null::text as release_key,
            (array_agg(request_id order by occurred_at desc) filter (where request_id is not null))[1] as request_id
       from scoped
      group by section_id, feature_id, stage, source, error_code, period
      order by count(*) desc limit 300`,
    [filters.from, filters.to, filters.previousFrom, filters.previousTo, filters.projectId, filters.segment, filters.tenure],
  );
  const [productResult, domainResult] = await Promise.all([product, domain]);
  return { ...productResult, rows: [...productResult.rows, ...domainResult.rows] };
}

type StuckStageRow = {
  section_id: string;
  feature_id: string;
  stage: string;
  source: string | null;
  operations: unknown;
  affected_users: unknown;
  oldest_age_ms: unknown;
};

async function loadStuckStages(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  return db.query<StuckStageRow>(
    `/* admin_aurora_stuck_stages */
     ${PRODUCT_SCOPE_SQL},
     ranked_operations as (
       select section_id, feature_id, stage, user_id, project_id, operation_id, occurred_at,
              coalesce(safe_context->>'source', 'ui') as source,
              row_number() over (
                partition by section_id, user_id, project_id, operation_id
                order by occurred_at desc, id desc
              ) as latest_rank
         from scoped_events
        where period = 'current' and operation_id is not null
     )
     select section_id, feature_id, stage, source,
            count(*) as operations,
            count(distinct user_id) as affected_users,
            extract(epoch from ($2::timestamptz - min(occurred_at))) * 1000 as oldest_age_ms
       from ranked_operations
      where latest_rank = 1
        and stage in ('started','accepted','queued','processing','retried')
        and occurred_at < $2::timestamptz - interval '15 minutes'
      group by section_id, feature_id, stage, source
      order by operations desc, oldest_age_ms desc
      limit 100`,
    queryParams(filters, null),
  );
}

type FunnelRow = {
  action: string;
  stage: string;
  period: "current" | "previous";
  users: unknown;
  failures: unknown;
  p50_ms: unknown;
};

async function loadFunnelRows(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  if (!filters.sectionId) return [] as FunnelRow[];
  const result = await db.query<FunnelRow>(
    `/* admin_aurora_funnel */
     ${PRODUCT_SCOPE_SQL}
     select action, stage, period, count(distinct user_id) as users,
            count(*) filter (where outcome = 'failure') as failures,
            percentile_cont(0.50) within group (order by duration_ms) filter (where duration_ms is not null) as p50_ms
       from scoped_events group by action, stage, period`,
    queryParams(filters),
  );
  return result.rows;
}

type SpeedRow = {
  source: string | null;
  operation_kind: string | null;
  release_key: string | null;
  observations: unknown;
  p50_ms: unknown;
  p95_ms: unknown;
  p99_ms: unknown;
  failures: unknown;
};

async function loadSpeedRows(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  if (!filters.sectionId) return [] as SpeedRow[];
  const result = await db.query<SpeedRow>(
    `/* admin_aurora_speed */
     ${PRODUCT_SCOPE_SQL}
     select coalesce(safe_context->>'source', 'ui') as source,
            coalesce(safe_context->>'operationKind', 'unknown') as operation_kind,
            release_key, count(duration_ms) as observations,
            percentile_cont(0.50) within group (order by duration_ms) filter (where duration_ms is not null) as p50_ms,
            percentile_cont(0.95) within group (order by duration_ms) filter (where duration_ms is not null) as p95_ms,
            percentile_cont(0.99) within group (order by duration_ms) filter (where duration_ms is not null) as p99_ms,
            count(*) filter (where outcome = 'failure') as failures
       from scoped_events where period = 'current'
      group by coalesce(safe_context->>'source', 'ui'), coalesce(safe_context->>'operationKind', 'unknown'), release_key
      order by p95_ms desc nulls last, observations desc
      limit 100`,
    queryParams(filters),
  );
  return result.rows;
}

type EventRow = {
  event_id: string;
  project_id: unknown;
  user_id: unknown;
  section_id: string;
  feature_id: string;
  action: string;
  stage: string;
  outcome: string;
  duration_ms: unknown;
  error_code: string | null;
  request_id: string | null;
  operation_id: string | null;
  release_key: string | null;
  occurred_at: unknown;
  device: string | null;
  source: string | null;
  operation_kind: string | null;
};

async function loadEventRows(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  if (!filters.sectionId) return [] as EventRow[];
  const result = await db.query<EventRow>(
    `/* admin_aurora_events */
     ${PRODUCT_SCOPE_SQL}
     select event_id, project_id, user_id, section_id, feature_id, action, stage, outcome,
            duration_ms, error_code, request_id, operation_id, release_key, occurred_at,
            coalesce(safe_context->>'device', 'unknown') as device,
            coalesce(safe_context->>'source', 'ui') as source,
            safe_context->>'operationKind' as operation_kind
       from scoped_events where period = 'current'
      order by occurred_at desc, id desc limit 100`,
    queryParams(filters),
  );
  return result.rows;
}

type OptionsRow = { kind: "project" | "release" | "version"; id: unknown; label: string };
type ReleaseRow = { release_key: string; commit_sha: string | null; observed_at: unknown };

async function loadOptions(db: Queryable, filters: AdminAuroraAnalyticsFilters) {
  return Promise.all([
    db.query<OptionsRow>(
      `/* admin_aurora_options */
       select 'project'::text as kind, project.id, project.name::text as label
         from projects project where project.is_archived = false
       union all
       select 'release', null::bigint, release.release_key
         from aurora_releases release
        where release.last_observed_at >= $1::timestamptz
       union all
       select distinct 'version', null::bigint, event.safe_context->>'appVersion'
         from product_events event
        where event.occurred_at >= $1::timestamptz
          and event.safe_context ? 'appVersion'
       order by kind, label`,
      [filters.previousFrom],
    ),
    db.query<ReleaseRow>(
      `/* admin_aurora_release_markers */
       select release.release_key, release.commit_sha,
              coalesce(release.deployed_at, release.first_observed_at) as observed_at
         from aurora_releases release
        where coalesce(release.deployed_at, release.first_observed_at) >= $1::timestamptz
          and coalesce(release.deployed_at, release.first_observed_at) < $2::timestamptz
        order by observed_at asc`,
      [filters.from, filters.to],
    ),
  ]);
}

function rowByPeriod<T extends { period: "current" | "previous" }>(rows: T[]) {
  return {
    current: rows.find((row) => row.period === "current"),
    previous: rows.find((row) => row.period === "previous"),
  };
}

function healthFor(sectionId: AuroraSectionId, current: SectionMetricRow | undefined) {
  if (!current) return { state: "unobserved" as const, reason: "За период нет продуктовых наблюдений." };
  const failures = number(current.failures);
  const events = number(current.launches) + number(current.key_actions);
  const errorRate = rate(failures, events);
  const p95 = nullableNumber(current.page_p95_ms);
  const pageSlo = auroraSloFor(sectionId, "page")?.p95Ms ?? null;
  if (errorRate >= 20 || (p95 != null && pageSlo != null && p95 >= pageSlo * 2)) {
    return { state: "down" as const, reason: "Подтверждена высокая доля ошибок или двукратное превышение page SLO." };
  }
  if (errorRate >= 5 || (p95 != null && pageSlo != null && p95 > pageSlo)) {
    return { state: "degraded" as const, reason: "Есть ошибки или превышение SLO; низкая активность сама по себе статус не ухудшает." };
  }
  return { state: "healthy" as const, reason: "Есть наблюдения, доля ошибок и p95 не превышают заданные пороги." };
}

function usefulOutcome(
  sectionId: AuroraSectionId,
  rows: DomainOutcomeRow[],
  filterable: boolean,
): AuroraUsefulOutcome {
  if (!filterable) {
    return {
      coverage: "not_filterable",
      label: OUTCOME_LABELS[sectionId],
      attempts: metric(0, 0), attemptUsers: metric(0, 0), successes: metric(0, 0), failures: metric(0, 0),
      uniqueUsers: metric(0, 0), successRate: metric(0, 0), timeToResultP50Ms: nullableMetric(null, null), lastSuccessAt: null,
      reason: "Устройство, версия и релиз есть только у product events; доменный результат не приписывается этим фильтрам без доказательства.",
    };
  }
  const byPeriod = rowByPeriod(rows.filter((row) => row.section_id === sectionId));
  const currentAttempts = number(byPeriod.current?.attempts);
  const previousAttempts = number(byPeriod.previous?.attempts);
  const currentSuccesses = number(byPeriod.current?.successes);
  const previousSuccesses = number(byPeriod.previous?.successes);
  const coverage = byPeriod.current ? "available" : "unobserved";
  return {
    coverage,
    label: OUTCOME_LABELS[sectionId],
    attempts: metric(currentAttempts, previousAttempts),
    attemptUsers: metric(number(byPeriod.current?.attempt_users), number(byPeriod.previous?.attempt_users)),
    successes: metric(currentSuccesses, previousSuccesses),
    failures: metric(number(byPeriod.current?.failures), number(byPeriod.previous?.failures)),
    uniqueUsers: metric(number(byPeriod.current?.unique_users), number(byPeriod.previous?.unique_users)),
    successRate: metric(rate(currentSuccesses, currentAttempts), rate(previousSuccesses, previousAttempts)),
    timeToResultP50Ms: nullableMetric(null, null),
    lastSuccessAt: nullableIso(byPeriod.current?.last_success_at),
    reason: coverage === "unobserved" ? "В доменной таблице нет подтверждённого результата за период." : null,
  };
}

function buildCards(metricRows: SectionMetricRow[], domainRows: DomainOutcomeRow[], filterable: boolean) {
  return AURORA_SECTION_CATALOG.map((section): AuroraAnalyticsSectionCard => {
    const rows = metricRows.filter((row) => row.section_id === section.id);
    const byPeriod = rowByPeriod(rows);
    const current = byPeriod.current;
    const previous = byPeriod.previous;
    const failuresCurrent = number(current?.failures);
    const failuresPrevious = number(previous?.failures);
    const eventCurrent = number(current?.launches) + number(current?.key_actions);
    const eventPrevious = number(previous?.launches) + number(previous?.key_actions);
    const health = healthFor(section.id, current);
    return {
      id: section.id,
      label: section.label,
      href: section.href,
      groupId: section.groupId,
      groupTitle: section.groupTitle,
      activity: {
        uniqueUsers: metric(number(current?.unique_users), number(previous?.unique_users)),
        sessions: metric(number(current?.sessions), number(previous?.sessions)),
        launches: metric(number(current?.launches), number(previous?.launches)),
        keyActions: metric(number(current?.key_actions), number(previous?.key_actions)),
      },
      technical: {
        state: health.state,
        errorRate: metric(rate(failuresCurrent, eventCurrent), rate(failuresPrevious, eventPrevious)),
        affectedUsers: metric(number(current?.affected_users), number(previous?.affected_users)),
        p50Ms: metric(number(current?.p50_ms), number(previous?.p50_ms)),
        p95Ms: metric(number(current?.p95_ms), number(previous?.p95_ms)),
        p99Ms: metric(number(current?.p99_ms), number(previous?.p99_ms)),
        pageP95Ms: nullableNumber(current?.page_p95_ms),
        observations: number(current?.observations),
        reason: health.reason,
      },
      outcome: {
        ...usefulOutcome(section.id, domainRows, filterable),
        timeToResultP50Ms: nullableMetric(
          nullableNumber(current?.time_to_result_p50_ms),
          nullableNumber(previous?.time_to_result_p50_ms),
        ),
      },
      dependencies: section.dependencies,
    };
  });
}

function errorSource(value: string | null): AuroraAnalyticsErrorGroup["source"] {
  if (value === "worker" || value === "bot" || value === "system") return value;
  if (value === "api") return "api";
  return "frontend";
}

function dependencyFor(sectionId: AuroraSectionId, source: string | null, code: string): string | null {
  const dependencies = AURORA_SECTION_BY_ID[sectionId].dependencies;
  if (source === "worker") return dependencies.find((item) => item.includes("worker")) ?? "redis";
  if (code.includes("ai_") || code.includes("provider")) return dependencies.includes("aurora_ai") ? "aurora_ai" : null;
  if (code.includes("database") || code.includes("postgres")) return "postgresql";
  if (code.includes("queue") || code.includes("redis")) return "redis";
  return dependencies.includes("web_api") ? "web_api" : null;
}

export function sentryIssueSearchUrl(
  errorCode: string,
  env: Record<string, string | undefined> = process.env,
): string | null {
  const org = env.SENTRY_ORG_SLUG;
  const projectId = env.SENTRY_PROJECT_ID;
  if (!org || !/^[a-z0-9][a-z0-9-]{0,62}$/u.test(org)) return null;
  if (!projectId || !/^\d{1,20}$/u.test(projectId)) return null;
  const query = new URLSearchParams({ project: projectId, query: `is:unresolved ${errorCode}` });
  return `https://sentry.io/organizations/${org}/issues/?${query.toString()}`;
}

function buildErrors(rows: ErrorRow[], now: Date): AuroraAnalyticsErrorGroup[] {
  const currentRows = rows.filter((row) => row.period === "current");
  return currentRows.flatMap((row) => {
    if (!isAuroraSectionId(row.section_id)) return [];
    const previous = rows.find((candidate) => candidate.period === "previous"
      && candidate.section_id === row.section_id
      && candidate.feature_id === row.feature_id
      && candidate.stage === row.stage
      && candidate.source === row.source
      && candidate.error_code === row.error_code);
    const currentCount = number(row.count);
    const previousCount = number(previous?.count);
    const lastSeenAt = iso(row.last_seen_at);
    const recent = now.getTime() - new Date(lastSeenAt).getTime() <= DAY_MS;
    return [{
      errorCode: row.error_code,
      title: row.error_code.replaceAll("_", " "),
      sectionId: row.section_id,
      featureId: row.feature_id,
      stage: row.stage,
      source: errorSource(row.source),
      count: currentCount,
      previousCount,
      affectedUsers: number(row.affected_users),
      affectedProjects: number(row.affected_projects),
      firstSeenAt: iso(row.first_seen_at),
      lastSeenAt,
      release: row.release_key,
      requestId: row.request_id,
      status: currentCount > Math.max(2, previousCount * 1.5) ? "regression" : recent ? "active" : "recurring",
      sentryUrl: sentryIssueSearchUrl(row.error_code),
      dependencyId: dependencyFor(row.section_id, row.source, row.error_code),
    }];
  });
}

function operationSloKind(source: string, operationKind: string): AuroraSloKind | null {
  const normalized = `${source}:${operationKind}`.toLowerCase();
  if (normalized.includes("provider") || normalized.includes("ai")) return "provider";
  if (normalized.includes("queue") || normalized.includes("wait")) return "queue";
  if (normalized.includes("worker")) return "worker";
  if (normalized.includes("page") || source === "ui") return "page";
  if (source === "api" || normalized.includes("api")) return "api";
  return null;
}

function buildSpeed(sectionId: AuroraSectionId, rows: SpeedRow[]): AuroraAnalyticsSpeedGroup[] {
  return rows.map((row) => {
    const source = row.source ?? "ui";
    const operationKind = row.operation_kind ?? "unknown";
    const sloKind = operationSloKind(source, operationKind);
    const slo = sloKind ? auroraSloFor(sectionId, sloKind) : null;
    const p95Ms = nullableNumber(row.p95_ms);
    return {
      source,
      operationKind,
      release: row.release_key,
      observations: number(row.observations),
      p50Ms: nullableNumber(row.p50_ms),
      p95Ms,
      p99Ms: nullableNumber(row.p99_ms),
      failures: number(row.failures),
      sloKind,
      sloP95Ms: slo?.p95Ms ?? null,
      withinSlo: p95Ms == null || !slo ? null : p95Ms <= slo.p95Ms,
    };
  });
}

function funnelMetric(rows: FunnelRow[], period: "current" | "previous", predicate: (row: FunnelRow) => boolean) {
  const matching = rows.filter((row) => row.period === period && predicate(row));
  return {
    users: matching.reduce((maximum, row) => Math.max(maximum, number(row.users)), 0),
    failures: matching.reduce((sum, row) => sum + number(row.failures), 0),
    p50: matching.map((row) => nullableNumber(row.p50_ms)).find((value) => value != null) ?? null,
  };
}

function buildFunnel(
  sectionId: AuroraSectionId,
  rows: FunnelRow[],
  outcome: AuroraUsefulOutcome,
): AuroraAnalyticsFunnelStep[] {
  const scenario = AURORA_SECTION_BY_ID[sectionId].scenario;
  const startAction = scenario[0];
  const useActions = new Set(["used", "acted", "published", "scheduled", "result_confirmed", "saved", "completed", "applied"]);
  const openingCurrent = funnelMetric(rows, "current", (row) => row.action === "loaded");
  const openingPrevious = funnelMetric(rows, "previous", (row) => row.action === "loaded");
  const actionCurrent = funnelMetric(rows, "current", (row) => row.action === startAction);
  const actionPrevious = funnelMetric(rows, "previous", (row) => row.action === startAction);
  const serverCurrent = funnelMetric(rows, "current", (row) => ["accepted", "queued", "processing", "completed"].includes(row.stage));
  const serverPrevious = funnelMetric(rows, "previous", (row) => ["accepted", "queued", "processing", "completed"].includes(row.stage));
  const useCurrent = funnelMetric(rows, "current", (row) => useActions.has(row.action) && row.stage === "completed");
  const usePrevious = funnelMetric(rows, "previous", (row) => useActions.has(row.action) && row.stage === "completed");
  const stages = [
    { id: "opening" as const, label: "Открытие раздела", current: openingCurrent, previous: openingPrevious, evidence: "product_event" as const },
    { id: "action_started" as const, label: `Начало действия · ${startAction}`, current: actionCurrent, previous: actionPrevious, evidence: "product_event" as const },
    {
      id: "server_confirmed" as const,
      label: "Сервер принял или обработал действие",
      current: { ...serverCurrent, users: Math.max(serverCurrent.users, outcome.attemptUsers.current) },
      previous: { ...serverPrevious, users: Math.max(serverPrevious.users, outcome.attemptUsers.previous) },
      evidence: "combined" as const,
    },
    { id: "result" as const, label: outcome.label, current: { users: outcome.uniqueUsers.current, failures: outcome.failures.current, p50: null }, previous: { users: outcome.uniqueUsers.previous, failures: outcome.failures.previous, p50: null }, evidence: "domain_table" as const },
    { id: "further_use" as const, label: "Дальнейшее использование результата", current: useCurrent, previous: usePrevious, evidence: "combined" as const },
  ];
  return stages.map((stage, index) => {
    const priorUsers = index === 0 ? null : stages[index - 1].current.users;
    return {
      id: stage.id,
      label: stage.label,
      users: metric(stage.current.users, stage.previous.users),
      conversionPercent: priorUsers == null || priorUsers === 0 ? null : rate(stage.current.users, priorUsers),
      dropoffUsers: priorUsers == null ? null : priorUsers - stage.current.users,
      durationP50Ms: stage.current.p50,
      errors: stage.current.failures,
      evidence: stage.evidence,
    };
  });
}

function severityForError(code: string): number {
  if (/(?:security|auth|permission|encryption)/u.test(code)) return 4;
  if (/(?:timeout|provider|database|queue|unavailable)/u.test(code)) return 3;
  if (/(?:validation|invalid|cancelled)/u.test(code)) return 1;
  return 2;
}

export function rankAuroraAnalyticsProblems(
  sections: readonly AuroraAnalyticsSectionCard[],
  errors: readonly AuroraAnalyticsErrorGroup[],
  stuckStages: readonly StuckStageRow[] = [],
): AuroraAnalyticsProblem[] {
  const problems: AuroraAnalyticsProblem[] = [];
  for (const error of errors) {
    const severity = severityForError(error.errorCode);
    const frequency = error.count;
    const impact = error.affectedUsers * frequency * severity;
    problems.push({
      id: `error:${error.sectionId}:${error.errorCode}:${error.stage}:${error.source}`,
      kind: /(?:provider|ai_)/u.test(error.errorCode) && error.affectedUsers >= 3
        ? "provider_failure"
        : error.release && error.status === "regression" ? "release_regression" : "error_growth",
      title: `${AURORA_SECTION_BY_ID[error.sectionId].label}: ${error.title}`,
      sectionId: error.sectionId,
      affectedUsers: error.affectedUsers,
      frequency,
      severity,
      impact,
      formula: `${error.affectedUsers} × ${frequency} × ${severity} = ${impact}`,
      evidence: error.status === "regression"
        ? `Текущий период: ${error.count}; предыдущий: ${error.previousCount}; релиз: ${error.release ?? "не определён"}.`
        : `Безопасный код ${error.errorCode}; текущий период: ${error.count}; предыдущий: ${error.previousCount}.`,
      dependencyId: error.dependencyId,
      sentryUrl: error.sentryUrl,
    });
  }
  for (const stuck of stuckStages) {
    if (!isAuroraSectionId(stuck.section_id)) continue;
    const affectedUsers = Math.max(1, number(stuck.affected_users));
    const frequency = Math.max(1, number(stuck.operations));
    const oldestAgeMs = Math.max(0, number(stuck.oldest_age_ms));
    const severity = oldestAgeMs >= 60 * 60_000 ? 3 : 2;
    const impact = affectedUsers * frequency * severity;
    const dependencyId = stuck.stage === "queued" || stuck.stage === "processing"
      ? "redis"
      : dependencyFor(stuck.section_id, stuck.source, "stage_stuck");
    problems.push({
      id: `stuck:${stuck.section_id}:${stuck.feature_id}:${stuck.stage}:${stuck.source ?? "ui"}`,
      kind: "stuck_stage",
      title: `${AURORA_SECTION_BY_ID[stuck.section_id].label}: зависание на стадии ${stuck.stage}`,
      sectionId: stuck.section_id,
      affectedUsers,
      frequency,
      severity,
      impact,
      formula: `${affectedUsers} × ${frequency} × ${severity} = ${impact}`,
      evidence: `${frequency} операций не перешли в terminal stage более 15 минут; возраст старейшей — ${Math.round(oldestAgeMs / 60_000)} мин.`,
      dependencyId,
      sentryUrl: null,
    });
  }
  for (const section of sections) {
    if (
      section.activity.keyActions.current >= 3
      && section.outcome.coverage === "unobserved"
      && section.outcome.successes.current === 0
    ) {
      const affectedUsers = Math.max(1, section.activity.uniqueUsers.current);
      const frequency = section.activity.keyActions.current;
      const severity = 2;
      problems.push({
        id: `stale:${section.id}`,
        kind: "stale",
        title: `${section.label}: действия без доменного результата`,
        sectionId: section.id,
        affectedUsers, frequency, severity,
        impact: affectedUsers * frequency * severity,
        formula: `${affectedUsers} × ${frequency} × ${severity} = ${affectedUsers * frequency * severity}`,
        evidence: `${frequency} ключевых действий, но доменная таблица не подтвердила полезный результат за период.`,
        dependencyId: section.dependencies.includes("postgresql") ? "postgresql" : null,
        sentryUrl: null,
      });
    }
    const conversionDrop = section.outcome.successRate.previous - section.outcome.successRate.current;
    if (section.outcome.coverage === "available" && conversionDrop >= 10) {
      const affectedUsers = Math.max(1, section.outcome.uniqueUsers.previous - section.outcome.uniqueUsers.current);
      const frequency = Math.max(1, section.outcome.attempts.current);
      const severity = conversionDrop >= 25 ? 3 : 2;
      problems.push({
        id: `conversion:${section.id}`,
        kind: "conversion_drop",
        title: `${section.label}: падение успешности результата`,
        sectionId: section.id,
        affectedUsers, frequency, severity,
        impact: affectedUsers * frequency * severity,
        formula: `${affectedUsers} × ${frequency} × ${severity} = ${affectedUsers * frequency * severity}`,
        evidence: `Успешность ${section.outcome.successRate.current}% против ${section.outcome.successRate.previous}% в прошлом периоде.`,
        dependencyId: null,
        sentryUrl: null,
      });
    }
    const pageSlo = auroraSloFor(section.id, "page")?.p95Ms ?? null;
    if (pageSlo && section.technical.pageP95Ms != null && section.technical.pageP95Ms > pageSlo) {
      const affectedUsers = Math.max(1, section.activity.uniqueUsers.current);
      const frequency = Math.max(1, section.technical.observations);
      const severity = section.technical.pageP95Ms >= pageSlo * 2 ? 3 : 2;
      problems.push({
        id: `latency:${section.id}`,
        kind: "latency",
        title: `${section.label}: p95 выше page SLO`,
        sectionId: section.id,
        affectedUsers, frequency, severity,
        impact: affectedUsers * frequency * severity,
        formula: `${affectedUsers} × ${frequency} × ${severity} = ${affectedUsers * frequency * severity}`,
        evidence: `page-load p95 ${Math.round(section.technical.pageP95Ms)} мс при SLO ${pageSlo} мс.`,
        dependencyId: section.dependencies.includes("web_api") ? "web_api" : null,
        sentryUrl: null,
      });
    }
  }
  return problems.sort((left, right) => right.impact - left.impact || left.id.localeCompare(right.id)).slice(0, 50);
}

function buildEvents(rows: EventRow[]): AuroraAnalyticsEventItem[] {
  return rows.flatMap((row) => {
    if (!isAuroraSectionId(row.section_id)) return [];
    return [{
      id: row.event_id,
      occurredAt: iso(row.occurred_at),
      sectionId: row.section_id,
      featureId: row.feature_id,
      action: row.action,
      stage: row.stage,
      outcome: row.outcome,
      durationMs: nullableNumber(row.duration_ms),
      errorCode: row.error_code,
      requestId: row.request_id,
      operationId: row.operation_id,
      release: row.release_key,
      device: row.device ?? "unknown",
      source: row.source ?? "ui",
      operationKind: row.operation_kind,
      userRef: `user:${number(row.user_id)}`,
      projectRef: `project:${number(row.project_id)}`,
    }];
  });
}

export async function loadAdminAuroraAnalytics(
  db: Queryable,
  filters: AdminAuroraAnalyticsFilters,
  options: { rawRetentionDays?: number; now?: Date } = {},
): Promise<AdminAuroraAnalytics> {
  const checkedAt = options.now ?? new Date();
  const rawRetentionDays = options.rawRetentionDays ?? 90;
  const [metricsResult, domainRows, timelineResult, errorsResult, stuckStageResult, funnelRows, speedRows, eventRows, optionResults] = await Promise.all([
    loadSectionMetrics(db, filters),
    loadDomainOutcomes(db, filters),
    loadTimeline(db, filters),
    loadErrors(db, filters),
    loadStuckStages(db, filters),
    loadFunnelRows(db, filters),
    loadSpeedRows(db, filters),
    loadEventRows(db, filters),
    loadOptions(db, filters),
  ]);
  const filterable = domainFiltersApplied(filters);
  const sections = buildCards(metricsResult.rows, domainRows, filterable);
  const errors = buildErrors(errorsResult.rows, checkedAt);
  const selected = filters.sectionId ? sections.find((section) => section.id === filters.sectionId) ?? null : null;
  const [optionsResult, releaseResult] = optionResults;
  const projects = optionsResult.rows.filter((row) => row.kind === "project").map((row) => ({ id: number(row.id), label: row.label }));
  const releases = [...new Set(optionsResult.rows.filter((row) => row.kind === "release").map((row) => row.label))];
  const appVersions = [...new Set(optionsResult.rows.filter((row) => row.kind === "version").map((row) => row.label))];
  const rawFrom = new Date(checkedAt.getTime() - rawRetentionDays * DAY_MS).toISOString();
  const coverageNotes = [
    "Кнопка не считается результатом: полезные исходы подтверждаются доменными таблицами.",
    `Сырые события хранятся ${rawRetentionDays} дней; долгосрочные счётчики остаются в product_event_daily.`,
  ];
  if (!filterable) coverageNotes.push("Доменный результат скрыт для фильтров device/version/release, которых нет в доменной записи.");
  return {
    schemaVersion: 1,
    checkedAt: checkedAt.toISOString(),
    filters,
    rawRetentionDays,
    coverage: { rawFrom, domainFiltersApplied: filterable, notes: coverageNotes },
    options: { projects, releases, appVersions },
    releases: releaseResult.rows.map((row) => ({ release: row.release_key, commitSha: row.commit_sha, deployedAt: iso(row.observed_at) })),
    timeline: timelineResult.rows.flatMap((row) => isAuroraSectionId(row.section_id) ? [{
      bucket: iso(row.bucket), sectionId: row.section_id, users: number(row.users), launches: number(row.launches),
      successes: number(row.successes), failures: number(row.failures), p95Ms: nullableNumber(row.p95_ms),
    }] : []),
    sections,
    problems: rankAuroraAnalyticsProblems(sections, errors, stuckStageResult.rows),
    detail: filters.sectionId && selected ? {
      sectionId: filters.sectionId,
      tab: filters.tab,
      scenario: AURORA_SECTION_BY_ID[filters.sectionId].scenario,
      slos: AURORA_SECTION_BY_ID[filters.sectionId].slos,
      funnel: buildFunnel(filters.sectionId, funnelRows, selected.outcome),
      errors: errors.filter((error) => error.sectionId === filters.sectionId),
      speed: buildSpeed(filters.sectionId, speedRows),
      events: buildEvents(eventRows),
    } : null,
  };
}
