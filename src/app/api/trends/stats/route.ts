import { NextRequest, NextResponse } from "next/server";

import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { TREND_BASELINE_DAYS, TREND_MATURE_HOURS, TREND_MIN_MATURE } from "@/lib/trend-period";
import {
  normalizeTrendTopic,
  parseTrendStatPeriod,
  parseTrendStatSource,
  TREND_STAT_PERIODS,
  TREND_STAT_SOURCES,
  trendPercentChange,
  type TrendStatSource,
} from "@/lib/trend-statistics";

export const runtime = "nodejs";

type StatsPayload = {
  summary?: Record<string, unknown>;
  previous?: Record<string, unknown>;
  series?: Record<string, unknown>[];
  topItems?: Record<string, unknown>[];
  from?: string;
  to?: string;
};

function asNumber(value: unknown) {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function sourceCte(source: TrendStatSource, topicParam: number) {
  const topicFilter = `($${topicParam} = '' or to_tsvector(
    'russian', coalesce(source_title, '') || ' ' || coalesce(text, '')
  ) @@ plainto_tsquery('russian', $${topicParam}))`;

  if (source === "internet") {
    return {
      params: "internet",
      sql: `base as (
        select distinct on (result.url)
               result.id::text as item_id,
               coalesce(result.handle, result.discovered_source_id::text, result.id::text) as source_id,
               coalesce(result.title, case when result.handle is not null then '@' || result.handle end, 'Telegram') as source_title,
               result.text,
               coalesce(result.views, 0)::bigint as views,
               coalesce(result.reactions, 0)::bigint as reactions,
               coalesce(result.posted_at, result.verified_at) as posted_at,
               case when result.result_type = 'trend' then 1.5::numeric end as trend_value,
               result.quality_score::numeric as quality_score,
               result.url,
               result.reason
          from radar_search_results result
          join radar_search_runs run
            on run.id = result.run_id and run.user_id = $1
         where result.user_id = $1
           and run.channel_id is not distinct from $2
           and result.result_type in ('post', 'trend')
           and result.verification_status = 'verified'
         order by result.url, result.verified_at desc, result.quality_score desc
      ), filtered as (
        select * from base
         where posted_at >= now() - interval '__PREVIOUS_INTERVAL__'
           and ${topicFilter}
      )`,
    } as const;
  }

  if (source === "collection") {
    return {
      params: "collection",
      sql: `norms as (
        select post.source_id,
               percentile_cont(0.5) within group (order by post.views) as median
          from trend_posts post
          join trend_sources source on source.id = post.source_id and source.enabled = true
         where post.views is not null
           and post.posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
           and post.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
           and post.collected_at >= post.posted_at + interval '${TREND_MATURE_HOURS} hours'
         group by post.source_id
        having count(*) >= ${TREND_MIN_MATURE}
      ), base as (
        select post.id::text as item_id,
               source.id::text as source_id,
               coalesce(source.title, '@' || source.handle) as source_title,
               post.text,
               coalesce(post.views, 0)::bigint as views,
               coalesce(post.reactions, 0)::bigint as reactions,
               post.posted_at,
               case when norms.median > 0 and post.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
                    then round((post.views / norms.median)::numeric, 2) end as trend_value,
               null::numeric as quality_score,
               'https://t.me/' || source.handle || '/' || post.tg_msg_id as url,
               'Публикация из редакционной подборки'::text as reason
          from trend_posts post
          join trend_sources source on source.id = post.source_id and source.enabled = true
          left join norms on norms.source_id = post.source_id
         where post.posted_at is not null
      ), filtered as (
        select * from base
         where posted_at >= now() - interval '__PREVIOUS_INTERVAL__'
           and ${topicFilter}
      )`,
    } as const;
  }

  return {
    params: "own",
    sql: `norms as (
      select post.competitor_id,
             percentile_cont(0.5) within group (order by post.views) as median
        from competitor_posts post
        join competitors competitor on competitor.id = post.competitor_id
       where competitor.channel_id = $1 and competitor.network = 'tg'
         and post.views is not null
         and post.posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
         and post.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
         and post.collected_at >= post.posted_at + interval '${TREND_MATURE_HOURS} hours'
       group by post.competitor_id
      having count(*) >= ${TREND_MIN_MATURE}
    ), base as (
      select post.id::text as item_id,
             competitor.id::text as source_id,
             coalesce(competitor.title, '@' || competitor.handle) as source_title,
             post.text,
             coalesce(post.views, 0)::bigint as views,
             coalesce(post.reactions, 0)::bigint as reactions,
             post.posted_at,
             case when norms.median > 0 and post.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
                  then round((post.views / norms.median)::numeric, 2) end as trend_value,
             null::numeric as quality_score,
             'https://t.me/' || competitor.handle || '/' || post.tg_msg_id as url,
             'Публикация добавленного конкурента'::text as reason
        from competitor_posts post
        join competitors competitor on competitor.id = post.competitor_id
        left join norms on norms.competitor_id = post.competitor_id
       where competitor.channel_id = $1 and competitor.network = 'tg'
         and post.posted_at is not null
    ), filtered as (
      select * from base
       where posted_at >= now() - interval '__PREVIOUS_INTERVAL__'
         and ${topicFilter}
    )`,
  } as const;
}

function analyticsSql(source: TrendStatSource, period: keyof typeof TREND_STAT_PERIODS) {
  const config = TREND_STAT_PERIODS[period];
  const topicParam = source === "internet" ? 3 : source === "collection" ? 1 : 2;
  const cte = sourceCte(source, topicParam).sql.replaceAll("__PREVIOUS_INTERVAL__", config.previousInterval);
  return `with ${cte},
    metrics as (
      select
        count(*) filter (where posted_at >= now() - interval '${config.interval}')::int as posts,
        count(distinct source_id) filter (where posted_at >= now() - interval '${config.interval}')::int as sources,
        coalesce(sum(views) filter (where posted_at >= now() - interval '${config.interval}'), 0)::bigint as views,
        coalesce(sum(reactions) filter (where posted_at >= now() - interval '${config.interval}'), 0)::bigint as reactions,
        coalesce(round(avg(views) filter (where posted_at >= now() - interval '${config.interval}')), 0)::bigint as avg_views,
        count(*) filter (
          where posted_at >= now() - interval '${config.interval}' and trend_value >= 1.5
        )::int as trends,
        count(*) filter (
          where posted_at >= now() - interval '${config.previousInterval}'
            and posted_at < now() - interval '${config.interval}'
        )::int as previous_posts,
        coalesce(sum(views) filter (
          where posted_at >= now() - interval '${config.previousInterval}'
            and posted_at < now() - interval '${config.interval}'
        ), 0)::bigint as previous_views
      from filtered
    ), buckets as (
      select generate_series(
        date_trunc('${config.bucket}', now() - interval '${config.interval}'),
        date_trunc('${config.bucket}', now()),
        interval '${config.step}'
      ) as bucket
    ), series as (
      select bucket,
             count(filtered.item_id)::int as posts,
             coalesce(sum(filtered.views), 0)::bigint as views
        from buckets
        left join filtered
          on filtered.posted_at >= bucket
         and filtered.posted_at < bucket + interval '${config.step}'
         and filtered.posted_at >= now() - interval '${config.interval}'
       group by bucket
       order by bucket
    ), top_items as (
      select item_id, source_title, text, url, posted_at, views, reactions,
             trend_value, quality_score, reason
        from filtered
       where posted_at >= now() - interval '${config.interval}'
       order by trend_value desc nulls last, quality_score desc nulls last,
                views desc, posted_at desc
       limit 6
    )
    select jsonb_build_object(
      'summary', jsonb_build_object(
        'posts', metrics.posts,
        'sources', metrics.sources,
        'views', metrics.views,
        'reactions', metrics.reactions,
        'avgViews', metrics.avg_views,
        'trends', metrics.trends,
        'engagementRate', case when metrics.views > 0
          then round((metrics.reactions::numeric / metrics.views::numeric) * 100, 2)
          else 0 end
      ),
      'previous', jsonb_build_object('posts', metrics.previous_posts, 'views', metrics.previous_views),
      'series', coalesce((select jsonb_agg(jsonb_build_object(
        'bucket', bucket, 'posts', posts, 'views', views
      ) order by bucket) from series), '[]'::jsonb),
      'topItems', coalesce((select jsonb_agg(to_jsonb(top_items) order by trend_value desc nulls last,
        quality_score desc nulls last, views desc, posted_at desc) from top_items), '[]'::jsonb),
      'from', now() - interval '${config.interval}',
      'to', now()
    ) as payload
    from metrics`;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const source = parseTrendStatSource(req.nextUrl.searchParams.get("source"));
  const period = parseTrendStatPeriod(req.nextUrl.searchParams.get("period"));
  const topic = normalizeTrendTopic(req.nextUrl.searchParams.get("topic"));

  try {
    let channelId: number | null = null;
    if (source !== "collection") {
      channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
      if (!channelId) {
        return NextResponse.json({ error: "no_channel" }, { status: 422 });
      }
    }

    const params = source === "internet"
      ? [user.id, channelId, topic]
      : source === "collection"
        ? [topic]
        : [channelId, topic];
    const result = await getPool().query<{ payload: StatsPayload }>(analyticsSql(source, period), params);
    const payload = result.rows[0]?.payload ?? {};
    const summary = payload.summary ?? {};
    const previous = payload.previous ?? {};
    const posts = asNumber(summary.posts);
    const views = asNumber(summary.views);
    const previousPosts = asNumber(previous.posts);
    const previousViews = asNumber(previous.views);

    return NextResponse.json({
      source,
      sourceLabel: TREND_STAT_SOURCES[source].label,
      sourceDescription: TREND_STAT_SOURCES[source].description,
      period,
      periodLabel: TREND_STAT_PERIODS[period].label,
      topic,
      channelId,
      window: { from: payload.from ?? null, to: payload.to ?? null },
      comparison: { previousPosts, previousViews },
      summary: {
        posts,
        sources: asNumber(summary.sources),
        views,
        reactions: asNumber(summary.reactions),
        avgViews: asNumber(summary.avgViews),
        trends: asNumber(summary.trends),
        engagementRate: asNumber(summary.engagementRate),
        postsChange: trendPercentChange(posts, previousPosts),
        viewsChange: trendPercentChange(views, previousViews),
      },
      series: (payload.series ?? []).map((item) => ({
        bucket: item.bucket,
        posts: asNumber(item.posts),
        views: asNumber(item.views),
      })),
      topItems: (payload.topItems ?? []).map((item) => ({
        id: String(item.item_id ?? ""),
        sourceTitle: item.source_title ?? null,
        text: item.text ?? null,
        url: item.url ?? null,
        postedAt: item.posted_at ?? null,
        views: asNumber(item.views),
        reactions: asNumber(item.reactions),
        ratio: item.trend_value == null ? null : asNumber(item.trend_value),
        qualityScore: item.quality_score == null ? null : asNumber(item.quality_score),
        reason: item.reason ?? null,
      })),
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    console.error("[/api/trends/stats]", error);
    return NextResponse.json({ error: "stats_unavailable" }, { status: 503 });
  }
}
