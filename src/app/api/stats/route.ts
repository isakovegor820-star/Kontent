// Д.5 — данные аналитики для экрана. Всё из реальных снимков (post_stats/channel_stats).
// Чего нет в базе (охват, комментарии) — помечаем недоступным, не выдумываем.

import { NextRequest, NextResponse } from "next/server";
import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { plural } from "@/lib/utils";
import { analyticsConfidence, summarizeAnalyticsCohort } from "@/lib/analytics-cohort";
import { summarizeBestPublishingTime } from "@/lib/best-publishing-time";

export const runtime = "nodejs";

interface PostRow {
  id: number;
  text: string;
  published_at: string;
  status: string;
  verification_state: string | null;
  /** Почему статистики нет: 'ok' | 'gone' (удалён) | 'private' (канал без публичной страницы) */
  stats_state: string | null;
  views: number | null;
  reactions: number | null;
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
    const channels = (
      await pool.query<{ id: string; title: string | null }>(
        `select id, title from channels where user_id = $1 and network = 'tg' and is_active = true`,
        [user.id],
      )
    ).rows;
    if (channels.length === 0) return NextResponse.json({ hasChannel: false });

    // Считаем по ОДНОМУ каналу, а не по всем сразу.
    // Раньше здесь было channel_id = any(все каналы): график подписчиков складывал
    // юридический канал с кофейным, а «лучшее время 19:00» выводилось из смешанной
    // аудитории — то есть было неверно сразу для обоих. Сумма подписчиков ещё имеет смысл,
    // а вот выводы «что зашло» и «когда постить» существуют только внутри одного канала.
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ hasChannel: false });
    const chIds = [channelId];

    // Ряд подписчиков по дням (сумма по каналам за дату) — для графика роста.
    const subSeries = (
      await pool.query<{ snapshot_date: string; subscribers: number }>(
        `select to_char(snapshot_date, 'YYYY-MM-DD') as snapshot_date,
                sum(subscribers)::int as subscribers
           from channel_stats where channel_id = any($1)
          group by snapshot_date order by snapshot_date`,
        [chIds],
      )
    ).rows;

    const latestSubs = subSeries.length ? subSeries[subSeries.length - 1].subscribers : null;

    const growth7d = (
      await pool.query<{ g: number }>(
        `select coalesce(sum(subscribers_delta), 0)::int as g
           from channel_stats where channel_id = any($1) and snapshot_date > current_date - 7`,
        [chIds],
      )
    ).rows[0].g;

    // Опубликованные посты + последние известные просмотры/реакции.
    const posts = (
      await pool.query<PostRow>(
        `select p.id, p.text, p.published_at, p.status, p.verification_state,
                p.stats_state, ps.views, ps.reactions
           from posts p
           left join lateral (
             select views, reactions from post_stats where post_id = p.id
             order by snapshot_date desc limit 1
           ) ps on true
          where p.channel_id = any($1)
            and p.status in ('published', 'published_unverified', 'missing', 'deleted_external')
            and p.published_at >= (
              date_trunc('day', now() at time zone 'Europe/Moscow') - interval '6 days'
            ) at time zone 'Europe/Moscow'
          order by p.published_at desc`,
        [chIds],
      )
    ).rows;

    const collectedAt = (
      await pool.query<{ t: string | null }>(
        `select greatest(
                  (select max(collected_at) from channel_stats where channel_id = any($1)),
                  (select max(s.collected_at)
                     from post_stats s join posts p on p.id = s.post_id
                    where p.channel_id = any($1))
                ) as t`,
        [chIds],
      )
    ).rows[0].t;

    // --- Человеческий вывод из реальных данных (не зашит) ---
    const cohort = summarizeAnalyticsCohort(posts);
    const verifiedPosts = cohort.verifiedPosts;
    const withViews = cohort.withMetrics;
    const totalViews = cohort.totalViews;
    const avgViews = cohort.avgViews;
    const confidence = analyticsConfidence(withViews.length);
    const bestTime = summarizeBestPublishingTime(withViews);

    const vw = (n: number) => plural(n, "просмотр", "просмотра", "просмотров");

    const insight: string[] = [];
    let bestPost: { text: string; views: number } | null = null;
    if (withViews.length === 1) {
      // Один пост — сравнивать не с чем, честно ставим точку отсчёта.
      const only = withViews[0];
      bestPost = { text: only.text, views: only.views };
      insight.push(
        `Первый пост набрал ${only.views} ${vw(only.views)} — это твоя точка отсчёта. ` +
          `Публикуй ещё, и я покажу, что заходит лучше.`,
      );
    } else if (withViews.length > 1) {
      const best = withViews.reduce((a, b) => (b.views > a.views ? b : a));
      bestPost = { text: best.text, views: best.views };
      insight.push(
        confidence === "low"
          ? `Пока лидирует пост с ${best.views} ${vw(best.views)}, но выборка из ${withViews.length} постов ещё слишком мала для рекомендации.`
          : `Лучший пост недели собрал ${best.views} ${vw(best.views)}; это наблюдение стоит проверить следующими публикациями.`,
      );
      if (avgViews != null) insight.push(`В среднем ${avgViews} ${vw(avgViews)} на пост.`);

      if (bestTime && bestTime.sampleSize >= 3) {
        insight.push(
          `Лучшее время — около ${bestTime.hour}:00 МСК; ` +
          `оценка по ${bestTime.sampleSize} ${plural(bestTime.sampleSize, "посту", "постам", "постам")} в этом часовом окне.`,
        );
      }
    }
    if (growth7d !== 0) {
      insight.push(`Подписчиков за неделю: ${growth7d > 0 ? "+" : ""}${growth7d}.`);
    }

    return NextResponse.json({
      hasChannel: true,
      channelTitle: channels.find((channel) => Number(channel.id) === channelId)?.title ?? null,
      latestSubs,
      growth7d,
      subscriberSeries: subSeries,
      posts: verifiedPosts,
      totals: {
        published: verifiedPosts.length,
        withMetrics: withViews.length,
        missing: cohort.missing,
        unverified: cohort.unverified,
        totalViews,
        avgViews,
      },
      cohort: {
        label: `${withViews.length} подтверждённых ${plural(withViews.length, "пост", "поста", "постов")} с метриками за 7 дней`,
        verifiedPosts: verifiedPosts.length,
        withMetrics: withViews.length,
        missing: cohort.missing,
        unverified: cohort.unverified,
        averageFormula: withViews.length ? `${totalViews} / ${withViews.length}` : null,
        confidence,
      },
      period: { days: 7, timeZone: "Europe/Moscow", label: "7 календарных дней" },
      bestPost,
      bestTime,
      insight: insight.length ? insight.join(" ") : null,
      // Честность: что Telegram отдаёт, а что нет.
      available: { views: true, reactions: true, reach: false, comments: false },
      collectedAt,
    });
  } catch (err) {
    console.error("[/api/stats]", { errorName: err instanceof Error ? err.name : "Error" });
    return NextResponse.json(
      { hasChannel: false, error: "stats_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
