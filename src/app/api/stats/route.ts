// Д.5 — данные аналитики для экрана. Всё из реальных снимков (post_stats/channel_stats).
// Чего нет в базе (охват, комментарии) — помечаем недоступным, не выдумываем.

import { NextRequest, NextResponse } from "next/server";
import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { plural } from "@/lib/utils";

export const runtime = "nodejs";

interface PostRow {
  id: number;
  text: string;
  published_at: string;
  /** Почему статистики нет: 'ok' | 'gone' (удалён) | 'private' (канал без публичной страницы) */
  stats_state: string | null;
  views: number | null;
  reactions: number | null;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ hasChannel: false });

  try {
    const pool = getPool();
    const channels = (
      await pool.query<{ id: number; title: string | null }>(
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
        `select p.id, p.text, p.published_at, p.stats_state, ps.views, ps.reactions
           from posts p
           left join lateral (
             select views, reactions from post_stats where post_id = p.id
             order by snapshot_date desc limit 1
           ) ps on true
          where p.channel_id = any($1) and p.status = 'published'
          order by p.published_at desc`,
        [chIds],
      )
    ).rows;

    const collectedAt = (
      await pool.query<{ t: string | null }>(
        `select max(collected_at) as t from channel_stats where channel_id = any($1)`,
        [chIds],
      )
    ).rows[0].t;

    // --- Человеческий вывод из реальных данных (не зашит) ---
    const withViews = posts.filter((p) => p.views != null) as (PostRow & { views: number })[];
    const totalViews = withViews.reduce((s, p) => s + p.views, 0);
    const avgViews = withViews.length ? Math.round(totalViews / withViews.length) : null;

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
      insight.push(`Лучший пост собрал ${best.views} ${vw(best.views)} — повтори этот формат.`);
      if (avgViews != null) insight.push(`В среднем ${avgViews} ${vw(avgViews)} на пост.`);

      // Лучшее время — час с наибольшим средним числом просмотров (нужно ≥3 поста).
      if (withViews.length >= 3) {
        const byHour = new Map<number, number[]>();
        for (const p of withViews) {
          const h = Number(
            new Date(p.published_at).toLocaleString("ru-RU", {
              timeZone: "Europe/Moscow",
              hour: "2-digit",
              hour12: false,
            }),
          );
          (byHour.get(h) ?? byHour.set(h, []).get(h)!).push(p.views);
        }
        let bestHour = -1;
        let bestAvg = -1;
        for (const [h, vs] of byHour) {
          const a = vs.reduce((s, v) => s + v, 0) / vs.length;
          if (a > bestAvg) {
            bestAvg = a;
            bestHour = h;
          }
        }
        if (bestHour >= 0) insight.push(`Лучшее время — около ${bestHour}:00 МСК.`);
      }
    }
    if (growth7d !== 0) {
      insight.push(`Подписчиков за неделю: ${growth7d > 0 ? "+" : ""}${growth7d}.`);
    }

    return NextResponse.json({
      hasChannel: true,
      channelTitle: channels[0].title,
      latestSubs,
      growth7d,
      subscriberSeries: subSeries,
      posts,
      totals: { published: posts.length, totalViews, avgViews },
      bestPost,
      insight: insight.length ? insight.join(" ") : null,
      // Честность: что Telegram отдаёт, а что нет.
      available: { views: true, reactions: true, reach: false, comments: false },
      collectedAt,
    });
  } catch (err) {
    console.error("[/api/stats]", err);
    return NextResponse.json({ hasChannel: false });
  }
}
