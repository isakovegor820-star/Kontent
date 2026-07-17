// Д.7 — данные для панели «Сними это».
//
// Старый /api/ideas отдавал ТОЛЬКО готовые идеи из залётов (медиана × 5). На живых данных
// таких залётов не бывает: в Telegram нет алгоритмической ленты, подписчик видит каждый пост,
// поэтому просмотры почти не гуляют — потолок по реальным каналам ×2–4, а не ×5. Страница
// оставалась пустой при полной базе постов.
//
// Здесь отдаём ВСЮ картину, чтобы панель всегда была живой и объясняла себя:
//   • статус слежки: сколько каналов, сколько постов, когда проверяли;
//   • норму каждого конкурента (медиану) — чтобы «×2.2 к норме» было проверяемо;
//   • рейтинг постов, посчитанный на лету, а не редкое событие из прошлого.
//
// Ratio считаем ТОЛЬКО по созревшим постам: свежий пост ещё набирает просмотры, и сравнивать
// его с отстоявшимся — сравнивать возраст, а не качество (у @bbcrussian пост за 0.3ч — 5810
// просмотров, за 16ч — 39000: разница в 6.7 раза чисто от времени).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel } from "@/lib/autopilot";
import { getStatsQueue } from "@/lib/queue";

export const runtime = "nodejs";

// Через столько часов просмотры почти не растут — пост можно честно сравнивать с другими.
const MATURE_HOURS = 48;
// Меньше пяти созревших постов — медиана не медиана. По такому каналу молчим.
const MIN_MATURE = 5;
// Сколько карточек отдаём в ленту.
const LIMIT = 12;

interface CompetitorRow {
  id: number;
  handle: string;
  title: string | null;
  subscribers: number | null;
  status: string;
  last_error: string | null;
  collected_at: string | null;
  posts: number;
}

interface ItemRow {
  id: number;
  competitor_id: number;
  handle: string;
  competitor_title: string | null;
  tg_msg_id: number;
  text: string | null;
  views: number;
  reactions: number | null;
  photo_url: string | null;
  media: string | null;
  posted_at: string;
  median: number;
  matured: number;
  ratio: string;
  idea_id: number | null;
  topic: string | null;
  hook: string | null;
  structure: string | null;
  why_it_worked: string | null;
  ai_status: string | null;
}

interface NormRow {
  competitor_id: number;
  median: string;
  matured: number;
}

/** Единая сборка ответа для обеих вкладок — иначе «Моя ниша» и «Насмотренность» разъедутся. */
function shape(
  sources: (CompetitorRow & { category?: string })[],
  items: (ItemRow & { category?: string })[],
  norms: NormRow[],
  scope: "niche" | "global",
  /** Сколько находок по теме ждёт подтверждения. Экран без этого числа врёт «не за кем
      следить», хотя разведка уже отработала и кандидаты лежат в одном клике. */
  waiting = 0,
  /** Тема канала из брифа — чтобы объяснить, ПО ЧЕМУ искали. */
  niche: string | null = null,
) {
  const normBy = new Map<number, { median: number; matured: number }>();
  for (const n of norms) {
    normBy.set(n.competitor_id, { median: Math.round(Number(n.median)), matured: n.matured });
  }

  const lastCollectedAt = sources
    .map((c) => c.collected_at)
    .filter(Boolean)
    .sort()
    .pop();

  return {
    scope,
    status: {
      competitors: sources.length,
      ready: sources.filter((c) => c.status === "ready").length,
      pending: sources.filter((c) => c.status === "pending").length,
      error: sources.filter((c) => c.status === "error").length,
      posts: sources.reduce((a, c) => a + c.posts, 0),
      lastCollectedAt: lastCollectedAt ?? null,
      matureHours: MATURE_HOURS,
      minMature: MIN_MATURE,
      waiting,
      niche,
    },
    competitors: sources.map((c) => ({
      id: c.id,
      handle: c.handle,
      title: c.title,
      subscribers: c.subscribers,
      status: c.status,
      lastError: c.last_error,
      category: c.category ?? null,
      posts: c.posts,
      // Норму показываем, только если созревших постов хватает на честную медиану.
      median: (normBy.get(c.id)?.matured ?? 0) >= MIN_MATURE ? (normBy.get(c.id)?.median ?? null) : null,
      matured: normBy.get(c.id)?.matured ?? 0,
      link: `https://t.me/${c.handle}`,
    })),
    items: items.map((it) => ({
      id: it.id,
      competitorId: it.competitor_id,
      handle: it.handle,
      competitorTitle: it.competitor_title,
      category: it.category ?? null,
      msgId: it.tg_msg_id,
      text: it.text,
      views: it.views,
      // Реакции по каналу могут быть выключены — тогда честно null, а не ноль.
      reactions: it.reactions || null,
      photoUrl: it.photo_url,
      media: it.media,
      postedAt: it.posted_at,
      median: Math.round(Number(it.median)),
      ratio: Number(it.ratio),
      link: `https://t.me/${it.handle}/${it.tg_msg_id}`,
      idea:
        it.idea_id && it.ai_status === "ready"
          ? { id: it.idea_id, topic: it.topic, hook: it.hook, structure: it.structure, why: it.why_it_worked }
          : null,
    })),
  };
}

/** Общие источники ниши («Насмотренность»): один список на всю платформу, свой не у каждого. */
async function globalScope() {
  const pool = getPool();

  const sources = (
    await pool.query<CompetitorRow & { category: string }>(
      `select s.id, s.handle, s.title, s.subscribers, s.status, s.last_error, s.collected_at,
              s.category,
              (select count(*)::int from trend_posts p where p.source_id = s.id) as posts
         from trend_sources s
        where s.enabled = true
        order by s.category, s.subscribers desc nulls last`,
    )
  ).rows;

  const items = (
    await pool.query<ItemRow & { category: string }>(
      `with mature as (
         select tp.id, tp.source_id as competitor_id, tp.tg_msg_id, tp.text, tp.views,
                tp.reactions, tp.photo_url, tp.media, tp.posted_at,
                s.handle, s.title as competitor_title, s.category
           from trend_posts tp
           join trend_sources s on s.id = tp.source_id and s.enabled = true
          where tp.views is not null and tp.posted_at is not null
            and tp.posted_at < now() - interval '${MATURE_HOURS} hours'
       ),
       med as (
         select competitor_id,
                percentile_cont(0.5) within group (order by views) as median,
                count(*)::int as matured
           from mature group by competitor_id
       )
       select m.*, md.median, md.matured,
              round((m.views / md.median)::numeric, 2) as ratio,
              null::bigint as idea_id, null::text as topic, null::text as hook,
              null::text as structure, null::text as why_it_worked, null::text as ai_status
         from mature m
         join med md on md.competitor_id = m.competitor_id
        where md.matured >= ${MIN_MATURE} and md.median > 0
        order by ratio desc, m.posted_at desc
        limit ${LIMIT}`,
    )
  ).rows;

  const norms = (
    await pool.query<{ competitor_id: number; median: string; matured: number }>(
      `select tp.source_id as competitor_id,
              percentile_cont(0.5) within group (order by tp.views) as median,
              count(*)::int as matured
         from trend_posts tp
         join trend_sources s on s.id = tp.source_id and s.enabled = true
        where tp.views is not null and tp.posted_at is not null
          and tp.posted_at < now() - interval '${MATURE_HOURS} hours'
        group by tp.source_id`,
    )
  ).rows;

  return { competitors: sources, items, norms };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const scope = req.nextUrl.searchParams.get("scope") === "global" ? "global" : "niche";

  try {
    const pool = getPool();

    if (scope === "global") {
      const g = await globalScope();
      return NextResponse.json(shape(g.competitors, g.items, g.norms, scope));
    }

    // «Твоя ниша» — ниша КАНАЛА: у двух каналов аккаунта разные соседи и разные нормы.
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json(shape([], [], [], scope));

    const competitors = (
      await pool.query<CompetitorRow>(
        `select c.id, c.handle, c.title, c.subscribers, c.status, c.last_error, c.collected_at,
                (select count(*)::int from competitor_posts p where p.competitor_id = c.id) as posts
           from competitors c
          where c.channel_id = $1 and c.network = 'tg'
          order by c.added_at`,
        [channelId],
      )
    ).rows;

    // Норма канала + рейтинг постов. Обе величины из одного набора созревших постов —
    // иначе «×2.2 к норме» считалось бы от медианы, в которую входят недосчитанные свежие.
    const items = (
      await pool.query<ItemRow>(
        `with mature as (
           select cp.id, cp.competitor_id, cp.tg_msg_id, cp.text, cp.views, cp.reactions,
                  cp.photo_url, cp.media, cp.posted_at,
                  c.handle, c.title as competitor_title
             from competitor_posts cp
             join competitors c on c.id = cp.competitor_id
            where c.channel_id = $1 and c.network = 'tg'
              and cp.views is not null and cp.posted_at is not null
              and cp.posted_at < now() - interval '${MATURE_HOURS} hours'
         ),
         med as (
           select competitor_id,
                  percentile_cont(0.5) within group (order by views) as median,
                  count(*)::int as matured
             from mature
            group by competitor_id
         )
         select m.*, md.median, md.matured,
                round((m.views / md.median)::numeric, 2) as ratio,
                i.id as idea_id, i.topic, i.hook, i.structure, i.why_it_worked, i.ai_status
           from mature m
           join med md on md.competitor_id = m.competitor_id
           left join content_ideas i on i.source_post_id = m.id and i.user_id = $2
          where md.matured >= ${MIN_MATURE} and md.median > 0
            and coalesce(i.status, 'new') <> 'dismissed'
          order by ratio desc, m.posted_at desc
          limit ${LIMIT}`,
        [channelId, user.id],
      )
    ).rows;

    // Норма по КАЖДОМУ каналу — отдельным запросом, а не из ленты: лента обрезана до LIMIT,
    // и канал, не попавший в топ, остался бы без нормы («25 из 5 постов» в списке слежки).
    const norms = (
      await pool.query<{ competitor_id: number; median: string; matured: number }>(
        `select cp.competitor_id,
                percentile_cont(0.5) within group (order by cp.views) as median,
                count(*)::int as matured
           from competitor_posts cp
           join competitors c on c.id = cp.competitor_id
          where c.channel_id = $1 and c.network = 'tg'
            and cp.views is not null and cp.posted_at is not null
            and cp.posted_at < now() - interval '${MATURE_HOURS} hours'
          group by cp.competitor_id`,
        [channelId],
      )
    ).rows;

    // Находки, ждущие подтверждения. Фильтр тот же, что на экране «Конкуренты»
    // (`on_topic is distinct from false`) — иначе экраны разошлись бы в счёте: тренды
    // обещали бы «нашёл 12», а Конкуренты показали бы один по теме.
    const waiting = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from competitor_suggestions
          where channel_id = $1 and status = 'new' and on_topic is distinct from false`,
        [channelId],
      )
    ).rows[0].n;

    // Тема из брифа — чтобы объяснить человеку, по чему вообще искали.
    const niche =
      (
        await pool.query<{ niche: string | null }>(
          `select niche from content_brief where channel_id = $1 and ready`,
          [channelId],
        )
      ).rows[0]?.niche ?? null;

    return NextResponse.json(shape(competitors, items, norms, scope, waiting, niche));
  } catch (err) {
    console.error("[/api/trends]", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

/** «Проверить сейчас» — ставим сбор в ту же очередь (Д.6): свои каналы или общие источники. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const scope = req.nextUrl.searchParams.get("scope") === "global" ? "global" : "niche";

  try {
    // Общие источники сбрасываем в 'pending' — воркер подхватит их обычным циклом:
    // отдельной задачи не нужно, список один на всех и обходится целиком.
    if (scope === "global") {
      const upd = await getPool().query(
        `update trend_sources set collected_at = null where enabled = true`,
      );
      return NextResponse.json({ ok: true, queued: upd.rowCount ?? 0, global: true });
    }

    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const rows = (
      await getPool().query<{ id: number }>(
        `select id from competitors where channel_id = $1 and network = 'tg'`,
        [channelId],
      )
    ).rows;
    if (!rows.length) {
      return NextResponse.json({ ok: false, error: "no_competitors" }, { status: 422 });
    }

    const queue = getStatsQueue();
    for (const r of rows) {
      // jobId по конкуренту: частые клики не плодят задачи, а сливаются в одну.
      await queue.add(
        "competitor",
        { id: r.id },
        { jobId: `competitor-${r.id}`, removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 15000 } },
      );
    }
    return NextResponse.json({ ok: true, queued: rows.length });
  } catch (err) {
    console.error("[/api/trends] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
