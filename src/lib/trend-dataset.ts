import {
  TREND_PAGE_SIZE,
  TREND_STAT_PERIODS,
  TREND_STAT_SOURCES,
  type TrendFeedItem,
  type TrendSort,
  type TrendStatPeriod,
  type TrendStatSource,
  type TrendStatsData,
} from "./trend-statistics";
import { TREND_BASELINE_DAYS, TREND_MATURE_HOURS, TREND_MIN_MATURE } from "./trend-period";

// Legacy search records have a threshold/median but no evidence of a mature sample.
// Show a ratio only when both the sample and the measured post meet the same rule.
export function radarMeasuredMedianSql(alias: string) {
  return `case when jsonb_typeof(${alias}.raw_data->'medianViews') = 'number'
    and jsonb_typeof(${alias}.raw_data->'baselinePosts') = 'number'
    then case when (${alias}.raw_data->>'baselinePosts')::numeric >= ${TREND_MIN_MATURE}
      and (${alias}.raw_data->>'medianViews')::numeric > 0
      and ${alias}.verified_at >= ${alias}.posted_at + interval '${TREND_MATURE_HOURS} hours'
    then (${alias}.raw_data->>'medianViews')::numeric end end`;
}

export function radarMeasuredRatioSql(alias: string) {
  return `round(${alias}.views::numeric / nullif((${radarMeasuredMedianSql(alias)}), 0), 2)`;
}

export type TrendDatasetInput = {
  userId: number;
  projectId: number;
  channelId: number | null;
  topic: string;
  source: TrendStatSource;
  period: TrendStatPeriod;
  runId: number | null;
  offset: number;
  sort: TrendSort;
};

function sourceSql(source: TrendStatSource) {
  if (source === "internet") {
    return `selected_run as (
      select run.* from radar_search_runs run, input
       where run.user_id = input.user_id and run.project_id = input.project_id
         and run.channel_id = input.channel_id
         and input.topic <> '' and run.normalized_query = input.topic
         and (input.run_id is null or run.id = input.run_id)
       order by run.created_at desc, run.id desc limit 1
    ), base as (
      select distinct on (regexp_replace(replace(result.url, 'https://t.me/s/', 'https://t.me/'), '[?#].*$', ''))
        result.id as item_id,
        coalesce(result.discovered_source_id, min(result.id) over (partition by result.handle)) as source_id,
        result.handle, coalesce(result.title, '@' || result.handle) as source_title,
        null::text as category, result.external_id as msg_id, result.text,
        result.views, result.reactions, result.posted_at, result.verified_at as measured_at,
        result.raw_data->>'photoUrl' as photo_url, result.raw_data->>'media' as media,
        ${radarMeasuredMedianSql("result")} as median,
        case when jsonb_typeof(result.raw_data->'baselinePosts') = 'number'
          then (result.raw_data->>'baselinePosts')::integer else 0 end as baseline_posts,
        ${radarMeasuredRatioSql("result")} as ratio,
        result.verified_at >= result.posted_at + interval '${TREND_MATURE_HOURS} hours' as is_mature,
        regexp_replace(replace(result.url, 'https://t.me/s/', 'https://t.me/'), '[?#].*$', '') as url,
        null::jsonb as idea
      from radar_search_results result
      join selected_run run on run.id = result.run_id
      join input on result.user_id = input.user_id
      where result.result_type in ('post', 'trend') and result.verification_status = 'verified'
        and result.url ~ '^https://t[.]me/(s/)?[A-Za-z0-9_]+/[0-9]+([?#].*)?$'
      order by regexp_replace(replace(result.url, 'https://t.me/s/', 'https://t.me/'), '[?#].*$', ''),
        result.verified_at desc, (result.result_type = 'trend') desc, result.id desc
    ), source_health as (
      select count(distinct source_id)::int as total, count(distinct source_id)::int as ready,
        0::int as pending, 0::int as errors from base
    )`;
  }

  const own = source === "own";
  const posts = own ? "competitor_posts" : "trend_posts";
  const sources = own ? "competitors" : "trend_sources";
  const sourceKey = own ? "competitor_id" : "source_id";
  const sourceFilter = own
    ? "source.channel_id = input.channel_id and source.network = 'tg' and source.is_active = true"
    : "source.enabled = true";
  return `selected_run as (select run.* from radar_search_runs run where false),
    selected_sources as (
      select source.* from ${sources} source, input where ${sourceFilter}
    ), norms as (
      select post.${sourceKey} as source_id,
        percentile_cont(0.5) within group (order by post.views)::numeric as median,
        count(*)::int as baseline_posts
      from ${posts} post join selected_sources source on source.id = post.${sourceKey}, bounds
      where post.views is not null and post.views >= 0
        and post.posted_at >= bounds.until - interval '${TREND_BASELINE_DAYS} days'
        and post.posted_at <= bounds.until - interval '${TREND_MATURE_HOURS} hours'
        and post.collected_at >= post.posted_at + interval '${TREND_MATURE_HOURS} hours'
      group by post.${sourceKey} having count(*) >= ${TREND_MIN_MATURE}
    ), base as (
      select post.id as item_id, source.id as source_id, source.handle,
        coalesce(source.title, '@' || source.handle) as source_title,
        ${own ? "null::text" : "source.category"} as category,
        post.tg_msg_id as msg_id, post.text, post.views, post.reactions, post.posted_at,
        post.collected_at as measured_at, post.photo_url, post.media,
        norms.median, coalesce(norms.baseline_posts, 0) as baseline_posts,
        case when post.collected_at >= post.posted_at + interval '${TREND_MATURE_HOURS} hours'
          and post.posted_at <= bounds.until - interval '${TREND_MATURE_HOURS} hours'
          then round(post.views::numeric / nullif(norms.median, 0), 2) end as ratio,
        (post.collected_at >= post.posted_at + interval '${TREND_MATURE_HOURS} hours'
          and post.posted_at <= bounds.until - interval '${TREND_MATURE_HOURS} hours') as is_mature,
        'https://t.me/' || source.handle || '/' || post.tg_msg_id as url,
        ${own ? "idea.payload" : "null::jsonb"} as idea
      from ${posts} post join selected_sources source on source.id = post.${sourceKey}
      left join norms on norms.source_id = source.id
      cross join bounds cross join input
      ${own ? `left join lateral (
        select jsonb_build_object('id', i.id, 'topic', i.topic, 'hook', i.hook,
          'structure', i.structure, 'why', i.why_it_worked) as payload
        from content_ideas i where i.source_post_id = post.id and i.user_id = input.user_id
          and i.ai_status = 'ready' and i.status <> 'dismissed'
        order by i.id desc limit 1
      ) idea on true` : ""}
      where input.topic = '' or to_tsvector('russian', coalesce(source.title, '') || ' ' || coalesce(post.text, ''))
        @@ plainto_tsquery('russian', input.topic)
    ), source_health as (
      select count(*)::int as total, count(*) filter (where status = 'ready')::int as ready,
        count(*) filter (where status in ('pending', 'refreshing'))::int as pending,
        count(*) filter (where status in ('error', 'no_feed'))::int as errors from selected_sources
    )`;
}

/** One SQL snapshot supplies both the feed and every statistic, before pagination. */
export function trendDatasetQuery(input: TrendDatasetInput) {
  const config = TREND_STAT_PERIODS[input.period];
  const days = input.period === "week" ? 6 : input.period === "month" ? 29 : 89;
  const start = input.period === "day"
    ? "clock.until - interval '24 hours'"
    : `(date_trunc('day', clock.until at time zone 'Europe/Moscow') at time zone 'Europe/Moscow') - interval '${days} days'`;
  const order = input.sort === "views" ? "views desc nulls last, posted_at desc, item_id desc"
    : input.sort === "ratio" ? "ratio desc nulls last, views desc nulls last, posted_at desc, item_id desc"
      : "posted_at desc, item_id desc";
  return {
    values: [input.userId, input.channelId, input.projectId, input.topic, input.runId, input.offset],
    text: `with input as (
      select $1::bigint as user_id, $2::bigint as channel_id, $3::bigint as project_id,
        $4::text as topic, $5::bigint as run_id, $6::integer as page_offset
    ), clock as (select statement_timestamp() as until),
    bounds as (select ${start} as since, clock.until from clock),
    ${sourceSql(input.source)},
    current_posts as (
      select base.* from base, bounds where posted_at >= bounds.since and posted_at < bounds.until
    ), metrics as (
      select count(*)::int as posts, count(distinct source_id)::int as sources,
        sum(views)::bigint as views, sum(reactions)::bigint as reactions,
        round(avg(views))::bigint as avg_views,
        count(*) filter (where ratio >= 1.5)::int as trends,
        count(views)::int as posts_with_views, count(reactions)::int as posts_with_reactions,
        min(measured_at) as oldest_measurement_at, max(measured_at) as latest_measurement_at,
        max(posted_at) as latest_post_at from current_posts
    ), buckets as (
      select bucket, least(bucket + interval '${config.step}', bounds.until) as until
        from bounds, lateral generate_series(bounds.since, bounds.until - interval '1 microsecond', interval '${config.step}') bucket
    ), series as (
      select buckets.bucket, buckets.until, count(post.item_id)::int as posts,
        sum(post.views)::bigint as views, count(post.views)::int as posts_with_views
      from buckets left join current_posts post on post.posted_at >= buckets.bucket and post.posted_at < buckets.until
      group by buckets.bucket, buckets.until order by buckets.bucket
    ), ranked_posts as (
      select current_posts.*, row_number() over (partition by source_id order by views desc nulls last, posted_at desc, item_id desc) as source_rank
      from current_posts
    ), top_posts as (
      select * from ranked_posts order by source_rank, views desc nulls last, posted_at desc, item_id desc limit 6
    ), page_posts as (
      select * from current_posts order by ${order} limit ${TREND_PAGE_SIZE} offset $6
    )
    select jsonb_build_object(
      'summary', jsonb_build_object('posts', metrics.posts, 'sources', metrics.sources,
        'views', metrics.views, 'reactions', metrics.reactions, 'avgViews', metrics.avg_views,
        'trends', metrics.trends, 'postsWithViews', metrics.posts_with_views, 'postsWithReactions', metrics.posts_with_reactions),
      'coverage', jsonb_build_object(
        'undatedPosts', (select count(*) from base where posted_at is null),
        'futurePosts', (select count(*) from base where posted_at >= bounds.until),
        'oldestMeasurementAt', metrics.oldest_measurement_at, 'latestMeasurementAt', metrics.latest_measurement_at,
        'comparisonAvailable', false),
      'window', jsonb_build_object('from', bounds.since, 'to', bounds.until, 'timeZone', 'Europe/Moscow'),
      'series', coalesce((select jsonb_agg(jsonb_build_object('bucket', bucket, 'until', until,
        'posts', posts, 'views', views, 'postsWithViews', posts_with_views) order by bucket) from series), '[]'::jsonb),
      'topItems', coalesce((select jsonb_agg(to_jsonb(top_posts) order by source_rank, views desc nulls last, posted_at desc, item_id desc) from top_posts), '[]'::jsonb),
      'items', coalesce((select jsonb_agg(to_jsonb(page_posts) order by ${order}) from page_posts), '[]'::jsonb),
      'search', (select jsonb_build_object('id', id, 'query', query, 'status', status, 'stage', stage,
        'progress', progress, 'errorMessage', error_message, 'createdAt', created_at, 'completedAt', completed_at,
        'period', search_period) from selected_run),
      'status', jsonb_build_object('competitors', source_health.total, 'ready', source_health.ready,
        'pending', source_health.pending, 'error', source_health.errors,
        'posts', (select count(*) from base), 'periodPosts', metrics.posts,
        'lastCollectedAt', metrics.oldest_measurement_at, 'latestPostAt', metrics.latest_post_at,
        'refreshEveryHours', 2, 'matureHours', ${TREND_MATURE_HOURS}, 'minMature', ${TREND_MIN_MATURE}, 'waiting', 0,
        'niche', (select niche from content_brief, input where content_brief.channel_id = input.channel_id and ready limit 1))
    ) as payload from metrics, bounds, source_health`,
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function feedItem(row: Record<string, unknown>): TrendFeedItem {
  return {
    id: Number(row.item_id), competitorId: Number(row.source_id), handle: String(row.handle || ""),
    competitorTitle: row.source_title as string | null, category: row.category as string | null,
    msgId: Number(row.msg_id) || Number(String(row.url).match(/\/(\d+)$/u)?.[1]) || Number(row.item_id),
    text: row.text as string | null, views: nullableNumber(row.views), reactions: nullableNumber(row.reactions),
    photoUrl: row.photo_url as string | null, media: row.media as string | null,
    postedAt: String(row.posted_at), measuredAt: row.measured_at as string | null,
    median: nullableNumber(row.median), baselinePosts: Number(row.baseline_posts) || 0,
    ratio: nullableNumber(row.ratio), isMature: row.is_mature === true,
    link: String(row.url), idea: (row.idea ?? null) as TrendFeedItem["idea"],
  };
}

export function serializeTrendDataset(payload: Record<string, unknown>, input: TrendDatasetInput): TrendStatsData {
  const summary = payload.summary as TrendStatsData["summary"];
  return {
    source: input.source, sourceLabel: TREND_STAT_SOURCES[input.source].label,
    sourceDescription: TREND_STAT_SOURCES[input.source].description,
    period: input.period, periodLabel: TREND_STAT_PERIODS[input.period].label,
    topic: input.topic, channelId: input.channelId,
    window: payload.window as TrendStatsData["window"], search: payload.search as TrendStatsData["search"],
    summary, coverage: payload.coverage as TrendStatsData["coverage"],
    series: payload.series as TrendStatsData["series"],
    topItems: ((payload.topItems ?? []) as Record<string, unknown>[]).map(feedItem),
    items: ((payload.items ?? []) as Record<string, unknown>[]).map(feedItem),
    pagination: { offset: input.offset, limit: TREND_PAGE_SIZE, total: summary.posts, hasMore: input.offset + TREND_PAGE_SIZE < summary.posts },
    status: payload.status as TrendStatsData["status"],
  };
}
