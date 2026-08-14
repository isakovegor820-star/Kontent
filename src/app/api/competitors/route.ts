// Д.6 — список конкурентов пользователя со сводкой для карточек.
// Кроме цифр отдаём честные признаки: сколько залётов найдено и хватает ли вообще
// данных, чтобы этим цифрам верить (thin_data). Пороги — те же, что в воркере.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel } from "@/lib/autopilot";
import {
  MAX_COMPETITORS,
  competitorPostUrl,
  competitorProfileUrl,
  type CompetitorNetwork,
} from "@/lib/competitors";

export const runtime = "nodejs";

// Синхронно с worker.mjs: ниже этого статистика — шум.
const MIN_POSTS_FOR_STATS = 8;
const MIN_MEDIAN_VIEWS = 20;

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ competitors: [], limit: MAX_COMPETITORS });

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ competitors: [], limit: MAX_COMPETITORS });
    const rows = (
      await pool.query(
        `select c.id, c.network, c.handle, c.title, c.custom_title, c.avatar_url,
                c.subscribers, c.status, c.last_error, c.collected_at, c.is_active,
                c.connection_method, c.auto_added,
                (select count(*)::int from competitor_posts p where p.competitor_id = c.id) as posts_count,
                (select round(avg(views))::int from competitor_posts p
                   where p.competitor_id = c.id and p.views is not null) as avg_views,
                (select percentile_cont(0.5) within group (order by p.views) from competitor_posts p
                   where p.competitor_id = c.id and p.views is not null) as median_views,
                (select count(*)::int from competitor_posts p
                   where p.competitor_id = c.id and p.views is not null) as with_views,
                (select count(*)::int from competitor_posts p
                   where p.competitor_id = c.id and p.is_hit) as hits_count,
                (select round(avg(coalesce(p.like_count, p.reactions, 0) + coalesce(p.comments_count, 0)))::int
                   from competitor_posts p where p.competitor_id = c.id) as avg_interactions,
                (select coalesce(jsonb_agg(recent order by recent.posted_at desc nulls last), '[]'::jsonb)
                   from (
                     select p.id, coalesce(p.external_post_id, p.tg_msg_id::text) as external_post_id,
                            p.text, p.posted_at, p.permalink, p.media,
                            coalesce(p.thumbnail_url, p.photo_url) as thumbnail_url,
                            p.views, coalesce(p.like_count, p.reactions) as likes,
                            p.comments_count
                       from competitor_posts p
                      where p.competitor_id = c.id
                      order by p.posted_at desc nulls last, p.id desc
                      limit 3
                   ) recent) as latest_posts
           from competitors c
          where c.channel_id = $1 and c.network in ('tg','instagram')
          order by c.added_at desc`,
        [channelId],
      )
    ).rows;

    const competitors = rows.map((r) => {
      const network = r.network as CompetitorNetwork;
      const latestPosts = (Array.isArray(r.latest_posts) ? r.latest_posts : []).map((post: {
        external_post_id?: string | null;
        permalink?: string | null;
        [key: string]: unknown;
      }) => ({
        ...post,
        link: competitorPostUrl(network, r.handle, post.external_post_id, post.permalink),
      }));
      return {
        ...r,
        display_title: r.custom_title || r.title || `@${r.handle}`,
        profile_url: competitorProfileUrl(network, r.handle),
        latest_posts: latestPosts,
        median_views: r.median_views == null ? null : Math.round(Number(r.median_views)),
        // Данных мало — цифры показываем, но честно предупреждаем, что верить им нельзя.
        thin_data:
          network === "tg" && r.status === "ready" &&
          (r.with_views < MIN_POSTS_FOR_STATS || Number(r.median_views ?? 0) < MIN_MEDIAN_VIEWS),
      };
    });
    return NextResponse.json({ competitors, limit: MAX_COMPETITORS });
  } catch (err) {
    console.error("[/api/competitors]", err);
    return NextResponse.json({ competitors: [], limit: MAX_COMPETITORS });
  }
}
