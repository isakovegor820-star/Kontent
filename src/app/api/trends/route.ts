import { NextRequest, NextResponse } from "next/server";
import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import { getStatsQueue } from "@/lib/queue";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import { normalizeRadarQuery } from "@/lib/radar-search.mjs";
import {
  TREND_BASELINE_DAYS,
  TREND_MATURE_HOURS,
  TREND_MIN_MATURE,
  TREND_PERIODS,
  parseTrendPeriod,
  type TrendPeriod,
} from "@/lib/trend-period";

export const runtime = "nodejs";

interface CompetitorRow {
  id: number;
  handle: string;
  title: string | null;
  subscribers: number | null;
  status: string;
  last_error: string | null;
  collected_at: string | Date | null;
  newest_post_at: string | Date | null;
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
  posted_at: string | Date;
  median: string | null;
  matured: number | null;
  ratio: string | null;
  is_mature: boolean;
  period_count: number;
  idea_id: number | null;
  topic: string | null;
  hook: string | null;
  structure: string | null;
  why_it_worked: string | null;
  ai_status: string | null;
  url?: string | null;
}

type TrendScope = "niche" | "internet" | "global";

interface NormRow {
  competitor_id: number;
  median: string;
  matured: number;
}

interface RefreshStateRow {
  id: number;
  status: string;
  last_error: string | null;
  collected_at: string | Date | null;
}

function timestamp(value: string | Date | null) {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function periodSql(period: TrendPeriod) {
  if (period === "hits") {
    return {
      where: `b.posted_at >= now() - interval '30 days'
              and b.is_mature
              and md.matured >= ${TREND_MIN_MATURE}
              and md.median > 0`,
      order: "ratio desc nulls last, b.posted_at desc",
    };
  }
  if (period === "week") {
    return {
      where: "b.posted_at >= now() - interval '7 days'",
      order: "b.posted_at desc",
    };
  }
  return {
    where:
      "b.posted_at >= (date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow')",
    order: "b.posted_at desc",
  };
}

function shape(
  sources: (CompetitorRow & { category?: string })[],
  items: (ItemRow & { category?: string })[],
  norms: NormRow[],
  scope: TrendScope,
  period: TrendPeriod,
  waiting = 0,
  niche: string | null = null,
) {
  const normBy = new Map<number, { median: number; matured: number }>();
  for (const n of norms) {
    normBy.set(n.competitor_id, { median: Math.round(Number(n.median)), matured: n.matured });
  }

  // Берём самый старый timestamp среди источников: так один свежий канал не маскирует
  // остальные давно не проверенные. Если хотя бы один ещё не собран — общей даты пока нет.
  const collected = sources.map((source) => timestamp(source.collected_at)).filter((value): value is number => value != null);
  const published = sources.map((source) => timestamp(source.newest_post_at)).filter((value): value is number => value != null);
  const lastCollectedAt =
    sources.length > 0 && collected.length === sources.length
      ? new Date(Math.min(...collected)).toISOString()
      : null;
  const latestPostAt = published.length > 0 ? new Date(Math.max(...published)).toISOString() : null;

  return {
    scope,
    period,
    status: {
      competitors: sources.length,
      ready: sources.filter((source) => source.status === "ready").length,
      pending: sources.filter((source) => source.status === "pending").length,
      error: sources.filter((source) => source.status === "error").length,
      posts: sources.reduce((total, source) => total + source.posts, 0),
      periodPosts: items[0]?.period_count ?? 0,
      lastCollectedAt,
      latestPostAt,
      refreshEveryHours: 2,
      matureHours: TREND_MATURE_HOURS,
      minMature: TREND_MIN_MATURE,
      waiting,
      niche,
    },
    competitors: sources.map((source) => ({
      id: source.id,
      handle: source.handle,
      title: source.title,
      subscribers: source.subscribers,
      status: source.status,
      lastError: source.last_error,
      category: source.category ?? null,
      posts: source.posts,
      median:
        (normBy.get(source.id)?.matured ?? 0) >= TREND_MIN_MATURE
          ? (normBy.get(source.id)?.median ?? null)
          : null,
      matured: normBy.get(source.id)?.matured ?? 0,
      link: `https://t.me/${source.handle}`,
    })),
    items: items.map((item) => ({
      id: item.id,
      competitorId: item.competitor_id,
      handle: item.handle,
      competitorTitle: item.competitor_title,
      category: item.category ?? null,
      msgId: item.tg_msg_id,
      text: item.text,
      views: item.views,
      reactions: item.reactions ?? null,
      photoUrl: item.photo_url,
      media: item.media,
      postedAt: new Date(item.posted_at).toISOString(),
      median: item.median == null ? null : Math.round(Number(item.median)),
      ratio: item.ratio == null ? null : Number(item.ratio),
      isMature: item.is_mature,
      link: item.url || `https://t.me/${item.handle}/${item.tg_msg_id}`,
      idea:
        item.idea_id && item.ai_status === "ready"
          ? {
              id: item.idea_id,
              topic: item.topic,
              hook: item.hook,
              structure: item.structure,
              why: item.why_it_worked,
            }
          : null,
    })),
    meta: TREND_PERIODS[period],
  };
}

async function globalScope(period: TrendPeriod) {
  const pool = getPool();
  const window = periodSql(period);

  const sources = (
    await pool.query<CompetitorRow & { category: string }>(
      `select s.id, s.handle, s.title, s.subscribers, s.status, s.last_error, s.collected_at,
              s.category,
              (select count(*)::int from trend_posts p where p.source_id = s.id) as posts,
              (select max(p.posted_at) from trend_posts p where p.source_id = s.id) as newest_post_at
         from trend_sources s
        where s.enabled = true
        order by s.category, s.subscribers desc nulls last`,
    )
  ).rows;

  const items = (
    await pool.query<ItemRow & { category: string }>(
      `with base as (
         select tp.id, tp.source_id as competitor_id, tp.tg_msg_id, tp.text, tp.views,
                tp.reactions, tp.photo_url, tp.media, tp.posted_at,
                s.handle, s.title as competitor_title, s.category,
                (tp.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
                  and tp.collected_at >= tp.posted_at + interval '${TREND_MATURE_HOURS} hours') as is_mature
           from trend_posts tp
           join trend_sources s on s.id = tp.source_id and s.enabled = true
          where tp.views is not null and tp.posted_at is not null
       ),
       med as (
         select competitor_id,
                percentile_cont(0.5) within group (order by views) as median,
                count(*)::int as matured
           from base
          where is_mature and posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
          group by competitor_id
       ),
       candidates as (
         select b.*, md.median, md.matured,
                case when b.is_mature and md.matured >= ${TREND_MIN_MATURE} and md.median > 0
                     then round((b.views / md.median)::numeric, 2) end as ratio,
                null::bigint as idea_id, null::text as topic, null::text as hook,
                null::text as structure, null::text as why_it_worked, null::text as ai_status
           from base b
           left join med md on md.competitor_id = b.competitor_id
          where ${window.where}
       )
       select candidates.*, count(*) over()::int as period_count
         from candidates
        order by ${window.order.replaceAll("b.", "candidates.")}
        limit ${TREND_PERIODS[period].limit}`,
    )
  ).rows;

  const norms = (
    await pool.query<NormRow>(
      `select tp.source_id as competitor_id,
              percentile_cont(0.5) within group (order by tp.views) as median,
              count(*)::int as matured
         from trend_posts tp
         join trend_sources s on s.id = tp.source_id and s.enabled = true
        where tp.views is not null and tp.posted_at is not null
          and tp.posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
          and tp.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
          and tp.collected_at >= tp.posted_at + interval '${TREND_MATURE_HOURS} hours'
        group by tp.source_id`,
    )
  ).rows;

  return { competitors: sources, items, norms };
}

function internetPeriodSql(period: TrendPeriod) {
  if (period === "hits") {
    return {
      where: "base.posted_at >= now() - interval '30 days'",
      order: "case when base.result_type = 'trend' then 0 else 1 end, base.quality_score desc, base.views desc, base.posted_at desc",
    };
  }
  if (period === "week") {
    return {
      where: "base.posted_at >= now() - interval '7 days'",
      order: "base.posted_at desc, base.quality_score desc",
    };
  }
  return {
    where:
      "base.posted_at >= (date_trunc('day', now() at time zone 'Europe/Moscow') at time zone 'Europe/Moscow')",
    order: "base.posted_at desc, base.quality_score desc",
  };
}

async function internetScope(
  userId: number,
  channelId: number,
  period: TrendPeriod,
  query: string,
) {
  const pool = getPool();
  const sourceSql = `with latest as (
    select distinct on (result.url)
           result.id,
           coalesce(nullif(result.handle, ''), split_part(replace(result.url, 'https://t.me/s/', 'https://t.me/'), '/', 4)) as handle,
           result.title, result.subscribers, result.verified_at,
           coalesce(result.posted_at, result.verified_at) as posted_at
      from radar_search_results result
      join radar_search_runs run on run.id = result.run_id and run.user_id = $1
     where result.user_id = $1
       and run.channel_id = $2
       and result.verification_status = 'verified'
       and result.result_type in ('post', 'trend')
       and ($3 = '' or result.tsv @@ plainto_tsquery('russian', $3))
     order by result.url, result.verified_at desc, result.quality_score desc
  )
  select min(id)::int as id, handle,
         (array_agg(title order by verified_at desc) filter (where title is not null))[1] as title,
         max(subscribers)::int as subscribers,
         'ready'::text as status, null::text as last_error,
         max(verified_at) as collected_at,
         count(*)::int as posts,
         max(posted_at) as newest_post_at
    from latest
   where handle <> ''
   group by handle
   order by max(verified_at) desc`;

  const sources = (await pool.query<CompetitorRow>(sourceSql, [userId, channelId, query])).rows;
  const window = internetPeriodSql(period);
  const items = (
    await pool.query<ItemRow>(
      `with latest as (
         select distinct on (result.url)
                result.id,
                result.result_type,
                coalesce(nullif(result.handle, ''), split_part(replace(result.url, 'https://t.me/s/', 'https://t.me/'), '/', 4)) as handle,
                result.title, result.text, result.url, result.external_id,
                coalesce(result.views, 0)::int as views,
                result.reactions,
                coalesce(result.posted_at, result.verified_at) as posted_at,
                result.quality_score,
                result.verified_at
           from radar_search_results result
           join radar_search_runs run on run.id = result.run_id and run.user_id = $1
          where result.user_id = $1
            and run.channel_id = $2
            and result.verification_status = 'verified'
            and result.result_type in ('post', 'trend')
            and ($3 = '' or result.tsv @@ plainto_tsquery('russian', $3))
          order by result.url, result.verified_at desc, result.quality_score desc
       ), base as (
         select id::int as id,
                (min(id) over (partition by handle))::int as competitor_id,
                handle,
                coalesce(title, case when handle <> '' then '@' || handle end, 'Telegram') as competitor_title,
                case
                  when coalesce(external_id::text, split_part(regexp_replace(replace(url, 'https://t.me/s/', 'https://t.me/'), '[?#].*$', ''), '/', 5)) ~ '^[0-9]+$'
                  then coalesce(external_id::text, split_part(regexp_replace(replace(url, 'https://t.me/s/', 'https://t.me/'), '[?#].*$', ''), '/', 5))::int
                  else id::int
                end as tg_msg_id,
                text, views, reactions, null::text as photo_url, null::text as media,
                posted_at, null::numeric as median, null::int as matured,
                case when result_type = 'trend' then 1.5::numeric end as ratio,
                true as is_mature,
                null::bigint as idea_id, null::text as topic, null::text as hook,
                null::text as structure, null::text as why_it_worked, null::text as ai_status,
                url, result_type, quality_score
           from latest
          where handle <> ''
       )
       select base.*, count(*) over()::int as period_count
         from base
        where ${window.where}
        order by ${window.order}
        limit ${TREND_PERIODS[period].limit}`,
      [userId, channelId, query],
    )
  ).rows;

  return { competitors: sources, items, norms: [] as NormRow[] };
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const requestedScope = req.nextUrl.searchParams.get("scope");
  const scope: TrendScope = requestedScope === "global"
    ? "global"
    : requestedScope === "internet"
      ? "internet"
      : "niche";
  const period = parseTrendPeriod(req.nextUrl.searchParams.get("period"));
  const query = scope === "internet"
    ? normalizeRadarQuery(req.nextUrl.searchParams.get("q"))
    : "";

  try {
    const pool = getPool();

    if (scope === "global") {
      const global = await globalScope(period);
      return NextResponse.json(shape(global.competitors, global.items, global.norms, scope, period));
    }

    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json(shape([], [], [], scope, period));

    if (scope === "internet") {
      const internet = await internetScope(user.id, channelId, period, query);
      const niche = (
        await pool.query<{ niche: string | null }>(
          `select niche from content_brief where channel_id = $1 and ready`,
          [channelId],
        )
      ).rows[0]?.niche ?? null;
      return NextResponse.json(
        shape(internet.competitors, internet.items, internet.norms, scope, period, 0, niche),
      );
    }

    const competitors = (
      await pool.query<CompetitorRow>(
        `select c.id, c.handle, c.title, c.subscribers, c.status, c.last_error, c.collected_at,
                (select count(*)::int from competitor_posts p where p.competitor_id = c.id) as posts,
                (select max(p.posted_at) from competitor_posts p where p.competitor_id = c.id) as newest_post_at
           from competitors c
          where c.channel_id = $1 and c.network = 'tg'
          order by c.added_at`,
        [channelId],
      )
    ).rows;

    const window = periodSql(period);
    const items = (
      await pool.query<ItemRow>(
        `with base as (
           select cp.id, cp.competitor_id, cp.tg_msg_id, cp.text, cp.views, cp.reactions,
                  cp.photo_url, cp.media, cp.posted_at,
                  c.handle, c.title as competitor_title,
                  (cp.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
                    and cp.collected_at >= cp.posted_at + interval '${TREND_MATURE_HOURS} hours') as is_mature
             from competitor_posts cp
             join competitors c on c.id = cp.competitor_id
            where c.channel_id = $1 and c.network = 'tg'
              and cp.views is not null and cp.posted_at is not null
         ),
         med as (
           select competitor_id,
                  percentile_cont(0.5) within group (order by views) as median,
                  count(*)::int as matured
             from base
            where is_mature and posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
            group by competitor_id
         ),
         candidates as (
           select b.*, md.median, md.matured,
                  case when b.is_mature and md.matured >= ${TREND_MIN_MATURE} and md.median > 0
                       then round((b.views / md.median)::numeric, 2) end as ratio,
                  i.id as idea_id, i.topic, i.hook, i.structure, i.why_it_worked, i.ai_status
             from base b
             left join med md on md.competitor_id = b.competitor_id
             left join content_ideas i on i.source_post_id = b.id and i.user_id = $2
            where ${window.where}
              and coalesce(i.status, 'new') <> 'dismissed'
         )
         select candidates.*, count(*) over()::int as period_count
           from candidates
          order by ${window.order.replaceAll("b.", "candidates.")}
          limit ${TREND_PERIODS[period].limit}`,
        [channelId, user.id],
      )
    ).rows;

    const norms = (
      await pool.query<NormRow>(
        `select cp.competitor_id,
                percentile_cont(0.5) within group (order by cp.views) as median,
                count(*)::int as matured
           from competitor_posts cp
           join competitors c on c.id = cp.competitor_id
          where c.channel_id = $1 and c.network = 'tg'
            and cp.views is not null and cp.posted_at is not null
            and cp.posted_at >= now() - interval '${TREND_BASELINE_DAYS} days'
            and cp.posted_at < now() - interval '${TREND_MATURE_HOURS} hours'
            and cp.collected_at >= cp.posted_at + interval '${TREND_MATURE_HOURS} hours'
          group by cp.competitor_id`,
        [channelId],
      )
    ).rows;

    const waiting = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from competitor_suggestions
          where channel_id = $1 and status = 'new' and on_topic is distinct from false`,
        [channelId],
      )
    ).rows[0].n;

    const niche =
      (
        await pool.query<{ niche: string | null }>(
          `select niche from content_brief where channel_id = $1 and ready`,
          [channelId],
        )
      ).rows[0]?.niche ?? null;

    return NextResponse.json(shape(competitors, items, norms, scope, period, waiting, niche));
  } catch (err) {
    console.error("[/api/trends]", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const requestedScope = req.nextUrl.searchParams.get("scope");
  if (requestedScope === "internet") {
    return NextResponse.json({ ok: false, error: "unsupported_scope" }, { status: 422 });
  }
  const scope = requestedScope === "global" ? "global" : "niche";
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  }

  let operationId: number | null = null;
  try {
    const pool = getPool();
    const queue = getStatsQueue();
    const channelId = scope === "global"
      ? null
      : await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (scope === "niche" && !channelId) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }
    const fingerprint = scope === "global" ? "global" : `niche:${channelId}`;
    const inserted = await pool.query<{ id: string }>(
      `insert into trend_refresh_operations
         (user_id, idempotency_key, fingerprint, status)
       values ($1, $2, $3, 'dispatching')
       on conflict do nothing returning id`,
      [user.id, idempotencyKey, fingerprint],
    );
    if (inserted.rowCount === 1) {
      operationId = Number(inserted.rows[0].id);
    } else {
      const existing = (await pool.query<{
        id: string;
        idempotency_key: string;
        fingerprint: string;
        status: "dispatching" | "accepted" | "failed";
        queued_count: number;
      }>(
        `select id, idempotency_key, fingerprint, status, queued_count
           from trend_refresh_operations
          where user_id = $1 and (idempotency_key = $2 or (fingerprint = $3 and status = 'dispatching'))
          order by case when idempotency_key = $2 then 0 else 1 end limit 1`,
        [user.id, idempotencyKey, fingerprint],
      )).rows[0];
      if (!existing || existing.fingerprint !== fingerprint) {
        return NextResponse.json({ ok: false, error: "idempotency_conflict" }, { status: 409 });
      }
      operationId = Number(existing.id);
      if (existing.status === "accepted") {
        return NextResponse.json({
          ok: true,
          queued: Number(existing.queued_count),
          global: scope === "global" || undefined,
          replayed: true,
        });
      }
      if (existing.status === "dispatching") {
        return NextResponse.json({ ok: false, error: "request_in_progress" }, { status: 202 });
      }
      const reclaimed = await pool.query(
        `update trend_refresh_operations
            set status = 'dispatching', last_error_code = null, updated_at = now()
          where id = $1 and status = 'failed'`,
        [operationId],
      );
      if (reclaimed.rowCount !== 1) {
        return NextResponse.json({ ok: false, error: "request_in_progress" }, { status: 202 });
      }
    }

    if (scope === "global") {
      const refreshState = (
        await pool.query<RefreshStateRow>(
          `with before_state as materialized (
             select id, status, last_error, collected_at
               from trend_sources
              where enabled = true
              for update
           ), updated as (
             update trend_sources as current
                set collected_at = null, status = 'pending', last_error = null
               from before_state as previous
              where current.id = previous.id
          returning previous.id, previous.status, previous.last_error, previous.collected_at
           )
           select id, status, last_error, collected_at from updated`,
        )
      ).rows;

      try {
        await queue.add(
          "trend-now",
          {},
          {
            jobId: "trend-now",
            removeOnComplete: true,
            removeOnFail: true,
            attempts: 2,
            backoff: { type: "fixed", delay: 15000 },
          },
        );
      } catch (queueError) {
        try {
          await pool.query(
            `with before_state as (
               select *
                 from jsonb_to_recordset($1::jsonb)
                   as previous(id bigint, status text, last_error text, collected_at timestamptz)
             )
             update trend_sources as current
                set status = previous.status,
                    last_error = previous.last_error,
                    collected_at = previous.collected_at
               from before_state as previous
              where current.id = previous.id
                and current.status = 'pending'
                and current.collected_at is null`,
            [JSON.stringify(refreshState)],
          );
        } catch (restoreError) {
          console.error("[/api/trends] failed to restore global refresh state", restoreError);
        }
        throw queueError;
      }

      await pool.query(
        `update trend_refresh_operations
            set status = 'accepted', queued_count = $2, updated_at = now()
          where id = $1 and status = 'dispatching'`,
        [operationId, refreshState.length],
      );
      return NextResponse.json({ ok: true, queued: refreshState.length, global: true });
    }

    const rows = (
      await pool.query<RefreshStateRow>(
        `select id, status, last_error, collected_at
           from competitors
          where channel_id = $1 and network = 'tg'`,
        [channelId],
      )
    ).rows;
    if (!rows.length) {
      return NextResponse.json({ ok: false, error: "no_competitors" }, { status: 422 });
    }

    for (const row of rows) {
      await pool.query(
        `update competitors set status = 'pending', last_error = null where id = $1`,
        [row.id],
      );
      try {
        await queue.add(
          "competitor",
          { id: row.id },
          {
            jobId: `competitor-${row.id}`,
            removeOnComplete: true,
            attempts: 2,
            backoff: { type: "fixed", delay: 15000 },
          },
        );
      } catch (queueError) {
        try {
          await pool.query(
            `update competitors
                set status = $2, last_error = $3, collected_at = $4
              where id = $1
                and status = 'pending'
                and last_error is null
                and collected_at is not distinct from $4`,
            [row.id, row.status, row.last_error, row.collected_at],
          );
        } catch (restoreError) {
          console.error(`[/api/trends] failed to restore competitor ${row.id}`, restoreError);
        }
        throw queueError;
      }
    }
    await pool.query(
      `update trend_refresh_operations
          set status = 'accepted', queued_count = $2, updated_at = now()
        where id = $1 and status = 'dispatching'`,
      [operationId, rows.length],
    );
    return NextResponse.json({ ok: true, queued: rows.length });
  } catch (err) {
    console.error("[/api/trends] POST", err);
    if (operationId) {
      await getPool().query(
        `update trend_refresh_operations
            set status = 'failed', last_error_code = 'dispatch_failed', updated_at = now()
          where id = $1 and status = 'dispatching'`,
        [operationId],
      ).catch(() => {});
    }
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
