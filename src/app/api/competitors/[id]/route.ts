// Д.6 — досье конкурента. Всё из ОТКРЫТЫХ данных (competitor_posts, competitor_stats).
//
// Честность здесь важнее полноты:
//   • Реакции t.me/s/ почти не отдаёт (на живых данных — 1 пост из 70). Раньше досье
//     заявляло «реакции доступны» и считало вовлечённость реакции/просмотры — то есть
//     цифру из воздуха. Теперь available.reactions считается ПО ФАКТУ, а ER без реакций
//     не показываем вовсе.
//   • У мелких каналов (медиана 5 просмотров) любая статистика — шум. Помечаем thinData
//     и говорим об этом прямо, а не рисуем красивые выводы.
//   • Словесных выводов ИИ тут нет — aiInsight: null, пока не подключим отдельно.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

interface PostRow {
  id: number;
  tg_msg_id: number;
  text: string | null;
  views: number | null;
  reactions: number | null;
  media: string | null;
  posted_at: string | null;
  is_hit: boolean;
  hit_ratio: string | null;
}

// Те же пороги, что у воркера (worker.mjs): ниже этого статистика не значит ничего.
const MIN_POSTS_FOR_STATS = 8;
const MIN_MEDIAN_VIEWS = 20;

const mskHour = (iso: string): number =>
  Number(
    new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", hour: "2-digit", hour12: false }),
  );
/** День недели по МСК, 0 = понедельник. */
const mskWeekday = (iso: string): number => {
  const d = new Date(new Date(iso).toLocaleString("en-US", { timeZone: "Europe/Moscow" }));
  return (d.getDay() + 6) % 7;
};

const mean = (xs: number[]): number | null =>
  xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const cid = Number((await ctx.params).id);
  if (!Number.isInteger(cid)) return NextResponse.json({ error: "not_found" }, { status: 404 });

  try {
    const pool = getPool();
    const comp = (
      await pool.query(
        `select id, handle, title, subscribers, status, last_error, collected_at, added_at
           from competitors where id = $1 and user_id = $2 and network = 'tg'`,
        [cid, user.id],
      )
    ).rows[0];
    if (!comp) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const posts = (
      await pool.query<PostRow>(
        `select id, tg_msg_id, text, views, reactions, media, posted_at, is_hit, hit_ratio
           from competitor_posts where competitor_id = $1
          order by posted_at desc nulls last`,
        [cid],
      )
    ).rows;

    const subSeries = (
      await pool.query<{ date: string; subscribers: number }>(
        `select to_char(snapshot_date, 'YYYY-MM-DD') as date, subscribers
           from competitor_stats where competitor_id = $1 order by snapshot_date`,
        [cid],
      )
    ).rows;

    /* ---------------------------------------------------- базовые метрики */

    const withViews = posts.filter((p) => p.views != null) as (PostRow & { views: number })[];
    const views = withViews.map((p) => p.views);
    const avgViews = mean(views);
    const medianViews = median(views);
    const reachPct =
      comp.subscribers && avgViews ? Math.round((avgViews / comp.subscribers) * 100) : null;

    // Реакции заявляем доступными, только если они есть у большинства постов. На t.me/s/
    // их обычно нет — тогда и ER не считаем, а не выдумываем.
    const withReactions = posts.filter((p) => p.reactions != null);
    const reactionsAvailable = posts.length > 0 && withReactions.length / posts.length > 0.5;
    const avgReactions = reactionsAvailable
      ? mean(withReactions.map((p) => p.reactions as number))
      : null;
    const erPct =
      reactionsAvailable && avgViews && avgReactions != null
        ? Math.round((avgReactions / avgViews) * 1000) / 10
        : null;

    // Данных мало — выводам верить нельзя. Говорим об этом прямо и объясняем, почему.
    const thin = withViews.length < MIN_POSTS_FOR_STATS || medianViews < MIN_MEDIAN_VIEWS;
    const thinReason = !thin
      ? null
      : withViews.length < MIN_POSTS_FOR_STATS
        ? `Собрано всего ${withViews.length} постов с просмотрами — на такой выборке выводы случайны.`
        : `Медиана канала — ${medianViews} просмотров. На таких числах один случайный читатель уже «залёт», поэтому статистике верить нельзя.`;

    /* ---------------------------------------------------- ритм: частота, дни, часы */

    const times = posts
      .map((p) => p.posted_at)
      .filter(Boolean)
      .map((t) => new Date(t as string).getTime());
    let perWeek: number | null = null;
    let firstPostAt: string | null = null;
    let lastPostAt: string | null = null;
    if (times.length >= 2) {
      const spanDays = (Math.max(...times) - Math.min(...times)) / 86_400_000;
      perWeek = spanDays >= 1 ? Math.round((posts.length / (spanDays / 7)) * 10) / 10 : null;
      firstPostAt = new Date(Math.min(...times)).toISOString();
      lastPostAt = new Date(Math.max(...times)).toISOString();
    }

    const dated = withViews.filter((p) => p.posted_at) as (PostRow & {
      views: number;
      posted_at: string;
    })[];

    const byWeekday = Array.from({ length: 7 }, (_, day) => {
      const inDay = dated.filter((p) => mskWeekday(p.posted_at) === day);
      return { day, posts: inDay.length, avgViews: mean(inDay.map((p) => p.views)) };
    });

    const byHour = Array.from({ length: 24 }, (_, hour) => {
      const inHour = dated.filter((p) => mskHour(p.posted_at) === hour);
      return { hour, posts: inHour.length, avgViews: mean(inHour.map((p) => p.views)) };
    });

    // Лучший час: только там, где постов хватает на честное среднее (>=2), иначе это
    // просто «один удачный пост в 3 ночи» и вывод врёт.
    let bestHour: number | null = null;
    if (dated.length >= 5) {
      const solid = byHour.filter((h) => h.posts >= 2 && h.avgViews != null);
      const best = solid.sort((a, b) => (b.avgViews as number) - (a.avgViews as number))[0];
      bestHour = best ? best.hour : null;
    }

    /* ---------------------------------------------------- медиа-микс и длина */

    const MEDIA_LABELS: Record<string, string> = { text: "Только текст", photo: "С фото", video: "С видео" };
    const mediaMix = ["text", "photo", "video"]
      .map((m) => {
        const inM = withViews.filter((p) => (p.media ?? "text") === m);
        return {
          media: m,
          label: MEDIA_LABELS[m],
          posts: inM.length,
          share: withViews.length ? Math.round((inM.length / withViews.length) * 100) : 0,
          avgViews: mean(inM.map((p) => p.views)),
        };
      })
      .filter((m) => m.posts > 0);

    const LEN_BUCKETS: { label: string; min: number; max: number }[] = [
      { label: "до 300", min: 0, max: 300 },
      { label: "300–800", min: 300, max: 800 },
      { label: "800–1500", min: 800, max: 1500 },
      { label: "1500+", min: 1500, max: Infinity },
    ];
    const withText = withViews.filter((p) => p.text && p.text.length > 0);
    const lengthBuckets = LEN_BUCKETS.map((b) => {
      const inB = withText.filter((p) => {
        const len = (p.text as string).length;
        return len >= b.min && len < b.max;
      });
      return { label: b.label, posts: inB.length, avgViews: mean(inB.map((p) => p.views)) };
    }).filter((b) => b.posts > 0);

    /* ---------------------------------------------------- анатомия залёта */

    const hits = withViews.filter((p) => p.is_hit);
    const rest = withViews.filter((p) => !p.is_hit);
    const lenOf = (ps: typeof withViews) =>
      mean(ps.filter((p) => p.text).map((p) => (p.text as string).length));
    const topMedia = (ps: typeof withViews) => {
      const counts = new Map<string, number>();
      for (const p of ps) {
        const m = p.media ?? "text";
        counts.set(m, (counts.get(m) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      return top ? { media: top[0], label: MEDIA_LABELS[top[0]] ?? top[0], count: top[1] } : null;
    };
    const hitAnatomy = hits.length
      ? {
          count: hits.length,
          avgLen: lenOf(hits),
          restAvgLen: lenOf(rest),
          media: topMedia(hits),
          hours: [...new Set(hits.filter((p) => p.posted_at).map((p) => mskHour(p.posted_at as string)))].sort(
            (a, b) => a - b,
          ),
          avgRatio: hits.length
            ? Math.round((hits.reduce((s, p) => s + Number(p.hit_ratio ?? 0), 0) / hits.length) * 10) / 10
            : null,
        }
      : null;

    /* ---------------------------------------------------- вывод */

    const growth =
      subSeries.length >= 2 ? subSeries[subSeries.length - 1].subscribers - subSeries[0].subscribers : null;

    const withLink = (p: PostRow) => ({
      msgId: p.tg_msg_id,
      text: p.text,
      views: p.views,
      media: p.media ?? "text",
      isHit: p.is_hit,
      ratio: p.hit_ratio ? Number(p.hit_ratio) : null,
      postedAt: p.posted_at,
      link: `https://t.me/${comp.handle}/${p.tg_msg_id}`,
    });

    const topPosts = [...withViews]
      .sort((a, b) => b.views - a.views)
      .slice(0, 5)
      .map(withLink);

    return NextResponse.json({
      competitor: {
        id: comp.id,
        handle: comp.handle,
        title: comp.title,
        subscribers: comp.subscribers,
        status: comp.status,
        lastError: comp.last_error,
        collectedAt: comp.collected_at,
        addedAt: comp.added_at,
        link: `https://t.me/${comp.handle}`,
      },
      stats: {
        postsCount: posts.length,
        withViews: withViews.length,
        avgViews,
        medianViews,
        avgReactions,
        erPct,
        reachPct,
        perWeek,
        bestHour,
        growth,
        firstPostAt,
        lastPostAt,
        thinData: thin,
        thinReason,
      },
      rhythm: { byWeekday, byHour },
      mediaMix,
      lengthBuckets,
      hitAnatomy,
      subscriberSeries: subSeries,
      topPosts,
      posts: posts.slice(0, 20).map(withLink),
      // Честность: что открытые данные дают, а что нет. reactions — ПО ФАКТУ, не декларацией.
      available: {
        views: true,
        reactions: reactionsAvailable,
        reposts: false,
        comments: false,
      },
      aiInsight: null,
    });
  } catch (err) {
    console.error("[/api/competitors/[id]]", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const cid = Number((await ctx.params).id);
  if (!Number.isInteger(cid)) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  try {
    await getPool().query(`delete from competitors where id = $1 and user_id = $2`, [cid, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/competitors/[id]] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
