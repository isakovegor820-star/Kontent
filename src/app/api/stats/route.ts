// Единый read model для «Результатов»: публикации, рост и публичные ориентиры
// конкурентов используют один канал, период, timezone и подтверждённый cohort.

import { NextRequest, NextResponse } from "next/server";

import {
  parseAnalyticsPeriodDays,
  subscriberGrowth,
  summarizeDashboardPeriod,
} from "@/lib/analytics-dashboard";
import { summarizeBestPublishingTime } from "@/lib/best-publishing-time";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { plural } from "@/lib/utils";

export const runtime = "nodejs";

interface PostRow {
  id: number | string;
  text: string;
  published_at: string;
  status: string;
  verification_state: string | null;
  stats_state: string | null;
  views: number | null;
  reactions: number | null;
  monthly_campaign_id: number | null;
  monthly_campaign_goal: string | null;
  monthly_item_id: number | null;
  monthly_item_title: string | null;
  period_bucket: "current" | "previous";
}

interface CompetitorRow {
  id: number | string;
  network: string;
  handle: string;
  title: string | null;
  custom_title: string | null;
  subscribers: number | null;
  status: string;
  collected_at: string | null;
  posts_count: number | string;
  with_views: number | string;
  median_views: number | string | null;
  avg_interactions: number | string | null;
  first_subscribers: number | string | null;
  latest_subscribers: number | string | null;
}

function reportPeriodLabel(days: number): string {
  return `${days} ${plural(days, "календарный день", "календарных дня", "календарных дней")}`;
}

export async function GET(req: NextRequest) {
  let user;
  try {
    user = await getSessionUser(req);
  } catch (err) {
    console.error("[/api/stats] session unavailable", {
      errorName: err instanceof Error ? err.name : "Error",
    });
    return NextResponse.json(
      { hasChannel: false, error: "stats_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  if (!user) {
    return NextResponse.json(
      { hasChannel: false, error: "unauthorized" },
      { status: 401, headers: { "Cache-Control": "no-store" } },
    );
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const channels = (
      await pool.query<{ id: string; title: string | null; timezone: string }>(
        `select channel.id, channel.title, project.timezone
           from channels channel
           join projects project on project.id = channel.project_id
          where channel.project_id = $1 and channel.network = 'tg' and channel.is_active = true
          order by channel.id`,
        [membership.projectId],
      )
    ).rows;
    if (channels.length === 0) return NextResponse.json({ hasChannel: false });

    const requestedChannelId = Number(req.nextUrl.searchParams.get("channel"));
    const selectedChannel = Number.isSafeInteger(requestedChannelId) && requestedChannelId > 0
      ? channels.find((channel) => Number(channel.id) === requestedChannelId)
      : channels[0];
    if (!selectedChannel) return NextResponse.json({ hasChannel: false });

    const channelId = Number(selectedChannel.id);
    const timezone = selectedChannel.timezone || "Europe/Moscow";
    const days = parseAnalyticsPeriodDays(req.nextUrl.searchParams.get("days"));

    const subSeries = (
      await pool.query<{ snapshot_date: string; subscribers: number }>(
        `select to_char(stats.snapshot_date, 'YYYY-MM-DD') as snapshot_date,
                stats.subscribers::int as subscribers
           from channel_stats stats
           join channels channel
             on channel.id = stats.channel_id and channel.project_id = $2
          where stats.channel_id = $1
            and stats.snapshot_date >= ((now() at time zone $3)::date - ($4::int - 1))
          order by stats.snapshot_date`,
        [channelId, membership.projectId, timezone, days],
      )
    ).rows;

    const posts = (
      await pool.query<PostRow>(
        `select p.id, p.text, p.published_at, p.status, p.verification_state,
                p.stats_state, ps.views, ps.reactions,
                monthly.campaign_id as monthly_campaign_id,
                monthly.campaign_goal as monthly_campaign_goal,
                monthly.item_id as monthly_item_id,
                monthly.item_title as monthly_item_title,
                case when p.published_at >= (
                  date_trunc('day', now() at time zone $3) - (($4::int - 1) * interval '1 day')
                ) at time zone $3 then 'current' else 'previous' end as period_bucket
           from posts p
           left join lateral (
             select views, reactions
               from post_stats
              where project_id = p.project_id and post_id = p.id
              order by snapshot_date desc, collected_at desc, id desc
              limit 1
          ) ps on true
          left join lateral (
            select campaign.id as campaign_id, campaign.goal as campaign_goal,
                   item.id as item_id, item.title as item_title
              from monthly_campaign_items item
              join monthly_campaign_plans plan
                on plan.id = item.plan_id and plan.project_id = item.project_id
              join monthly_campaigns campaign
                on campaign.id = plan.campaign_id and campaign.project_id = item.project_id
             where item.post_id = p.id and item.project_id = p.project_id
             order by plan.revision desc, item.id desc
             limit 1
          ) monthly on true
          where p.channel_id = $1
            and p.project_id = $2
            and p.status in ('published', 'published_unverified', 'missing', 'deleted_external')
            and p.published_at >= (
              date_trunc('day', now() at time zone $3) - (($4::int * 2 - 1) * interval '1 day')
            ) at time zone $3
          order by p.published_at desc`,
        [channelId, membership.projectId, timezone, days],
      )
    ).rows;

    const competitorRows = (
      await pool.query<CompetitorRow>(
        `select competitor.id, competitor.network, competitor.handle, competitor.title,
                competitor.custom_title, competitor.subscribers, competitor.status,
                competitor.collected_at,
                count(post.id) filter (where post.posted_at >= (
                  date_trunc('day', now() at time zone $3) - (($4::int - 1) * interval '1 day')
                ) at time zone $3)::int as posts_count,
                count(post.views) filter (where post.views is not null and post.posted_at >= (
                  date_trunc('day', now() at time zone $3) - (($4::int - 1) * interval '1 day')
                ) at time zone $3)::int as with_views,
                percentile_cont(0.5) within group (order by post.views) filter (
                  where post.views is not null and post.posted_at >= (
                    date_trunc('day', now() at time zone $3) - (($4::int - 1) * interval '1 day')
                  ) at time zone $3
                ) as median_views,
                round(avg(coalesce(post.like_count, post.reactions, 0) + coalesce(post.comments_count, 0))
                  filter (where post.posted_at >= (
                    date_trunc('day', now() at time zone $3) - (($4::int - 1) * interval '1 day')
                  ) at time zone $3))::int as avg_interactions,
                (select snapshot.subscribers
                   from competitor_stats snapshot
                  where snapshot.competitor_id = competitor.id
                    and snapshot.snapshot_date >= ((now() at time zone $3)::date - ($4::int - 1))
                  order by snapshot.snapshot_date asc limit 1) as first_subscribers,
                (select snapshot.subscribers
                   from competitor_stats snapshot
                  where snapshot.competitor_id = competitor.id
                    and snapshot.snapshot_date >= ((now() at time zone $3)::date - ($4::int - 1))
                  order by snapshot.snapshot_date desc limit 1) as latest_subscribers
           from competitors competitor
           join channels owner_channel
             on owner_channel.id = competitor.channel_id and owner_channel.project_id = $2
           left join competitor_posts post on post.competitor_id = competitor.id
          where competitor.channel_id = $1
            and competitor.is_active = true
            and competitor.network in ('tg', 'instagram')
          group by competitor.id
          order by competitor.collected_at desc nulls last, competitor.id`,
        [channelId, membership.projectId, timezone, days],
      )
    ).rows;

    const collectedAt = (
      await pool.query<{ t: string | null }>(
        `select greatest(
                  (select max(stats.collected_at)
                     from channel_stats stats
                     join channels channel
                       on channel.id = stats.channel_id and channel.project_id = $2
                    where stats.channel_id = $1),
                  (select max(snapshot.collected_at)
                     from post_stats snapshot
                     join posts post
                       on post.id = snapshot.post_id and post.project_id = snapshot.project_id
                    where post.channel_id = $1 and post.project_id = $2),
                  (select max(competitor.collected_at)
                     from competitors competitor where competitor.channel_id = $1)
                ) as t`,
        [channelId, membership.projectId],
      )
    ).rows[0]?.t ?? null;

    const currentPosts = posts.filter((post) => post.period_bucket === "current");
    const previousPosts = posts.filter((post) => post.period_bucket === "previous");
    const summary = summarizeDashboardPeriod(currentPosts, previousPosts);
    const verifiedPosts = summary.current.verifiedPosts;
    const withViews = summary.current.withMetrics;
    const serializedPosts = verifiedPosts.map((post) => ({
      ...post,
      id: Number(post.id),
      engagementRate: post.views != null && post.views > 0 && Number.isFinite(post.reactions)
        ? Number((((post.reactions as number) / post.views) * 100).toFixed(1))
        : null,
    }));
    const subscriberDelta = subscriberGrowth(subSeries);
    const latestSubs = subSeries.at(-1)?.subscribers ?? null;
    const bestPostRow = withViews.length
      ? withViews.reduce((best, post) => post.views > best.views ? post : best)
      : null;
    const bestPost = bestPostRow ? {
      id: Number(bestPostRow.id),
      text: bestPostRow.text,
      views: bestPostRow.views,
      reactions: bestPostRow.reactions,
    } : null;
    const bestTime = summarizeBestPublishingTime(withViews);

    const insight: string[] = [];
    if (withViews.length === 1) {
      insight.push(`Первая подтверждённая публикация набрала ${withViews[0].views.toLocaleString("ru-RU")} ${plural(withViews[0].views, "просмотр", "просмотра", "просмотров")} — это точка отсчёта.`);
    } else if (withViews.length > 1) {
      const comparison = summary.comparisons.averageViewsPercent;
      if (comparison != null && Math.abs(comparison) >= 10) {
        insight.push(`Средние просмотры на публикацию ${comparison > 0 ? "выросли" : "снизились"} на ${Math.abs(comparison)}% к предыдущему периоду.`);
      } else if (bestPost) {
        insight.push(`Лучший результат периода — ${bestPost.views.toLocaleString("ru-RU")} ${plural(bestPost.views, "просмотр", "просмотра", "просмотров")}.`);
      }
    }
    if (subscriberDelta != null && subscriberDelta !== 0) {
      insight.push(`Подписчики: ${subscriberDelta > 0 ? "+" : ""}${subscriberDelta.toLocaleString("ru-RU")} за период.`);
    }

    const competitors = competitorRows.map((competitor) => {
      const firstSubscribers = competitor.first_subscribers == null ? null : Number(competitor.first_subscribers);
      const latestSubscribers = competitor.latest_subscribers == null ? null : Number(competitor.latest_subscribers);
      const withMetrics = Number(competitor.with_views ?? 0);
      return {
        id: Number(competitor.id),
        label: competitor.custom_title || competitor.title || `@${competitor.handle}`,
        network: competitor.network,
        handle: competitor.handle,
        subscribers: competitor.subscribers == null ? null : Number(competitor.subscribers),
        subscriberGrowth: firstSubscribers != null && latestSubscribers != null
          ? latestSubscribers - firstSubscribers
          : null,
        posts: Number(competitor.posts_count ?? 0),
        postsWithMetrics: withMetrics,
        medianViews: competitor.median_views == null ? null : Math.round(Number(competitor.median_views)),
        averageInteractions: competitor.avg_interactions == null ? null : Number(competitor.avg_interactions),
        confidence: withMetrics >= 10 ? "high" : withMetrics >= 5 ? "medium" : withMetrics >= 2 ? "low" : "insufficient",
        status: competitor.status,
        collectedAt: competitor.collected_at,
      };
    });

    return NextResponse.json({
      hasChannel: true,
      channelTitle: selectedChannel.title,
      latestSubs,
      growth7d: days === 7 ? subscriberDelta : null,
      subscriberGrowth: subscriberDelta,
      subscriberSeries: subSeries,
      posts: serializedPosts,
      totals: {
        published: verifiedPosts.length,
        withMetrics: withViews.length,
        missing: summary.current.missing,
        unverified: summary.current.unverified,
        totalViews: summary.current.totalViews,
        avgViews: summary.current.avgViews,
        medianViews: summary.medianViews,
        totalReactions: summary.totalReactions,
        engagementRate: summary.engagementRate,
      },
      comparisons: summary.comparisons,
      cohort: {
        label: `${withViews.length} из ${verifiedPosts.length} подтверждённых ${plural(verifiedPosts.length, "публикации", "публикаций", "публикаций")} с просмотрами`,
        verifiedPosts: verifiedPosts.length,
        withMetrics: withViews.length,
        missing: summary.current.missing,
        unverified: summary.current.unverified,
        averageFormula: withViews.length ? `${summary.current.totalViews} / ${withViews.length}` : null,
        confidence: summary.confidence,
      },
      period: { days, timeZone: timezone, label: reportPeriodLabel(days) },
      bestPost,
      bestTime,
      insight: insight.length ? insight.join(" ") : null,
      competitors,
      available: { views: true, reactions: true, subscribers: true, reach: false, comments: false },
      collectedAt,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    if (err instanceof ProjectAccessError) {
      return NextResponse.json(
        { hasChannel: false, error: "access_denied" },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    console.error("[/api/stats]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json(
      { hasChannel: false, error: "stats_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
