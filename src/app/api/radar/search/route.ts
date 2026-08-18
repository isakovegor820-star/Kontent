// Гибридный радар: локальная выдача возвращается сразу, внешний Telegram-discovery
// запускается отдельно и никогда не подменяет живую проверку источника текстом ИИ.

import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { resolveChannel } from "@/lib/autopilot";
import { getPool } from "@/lib/db";
import {
  normalizeRadarQuery,
  radarTsQuery,
  scoreRadarRelevance,
} from "@/lib/radar-search.mjs";
import { enqueueRadarSearch } from "@/lib/radar-search-queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Db = ReturnType<typeof getPool>;

type RunRow = {
  id: string | number;
  query: string;
  normalized_query: string;
  status: "queued" | "running" | "ready" | "partial" | "failed";
  stage: "queued" | "discovering" | "verifying" | "ranking" | "ready" | "failed";
  progress: number | string;
  provider: string | null;
  local_count: number | string;
  external_count: number | string;
  error_code: string | null;
  error_message: string | null;
  cache_expires_at: string | Date;
  created_at: string | Date;
  updated_at: string | Date;
  completed_at: string | Date | null;
};

function iso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function serializeRun(row: RunRow | undefined) {
  if (!row) return null;
  return {
    id: Number(row.id),
    query: row.query,
    normalizedQuery: row.normalized_query,
    status: row.status,
    stage: row.stage,
    progress: Number(row.progress),
    provider: row.provider,
    localCount: Number(row.local_count),
    externalCount: Number(row.external_count),
    errorCode: row.error_code,
    errorMessage: row.error_message,
    cacheExpiresAt: iso(row.cache_expires_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    completedAt: iso(row.completed_at),
  };
}

function serializeResult(row: Record<string, unknown>) {
  const origin = String(row.origin || row.provider || "local");
  const kind = String(row.kind || row.result_type || "post");
  const id = String(row.result_key || `${origin}:${row.id}`);
  return {
    id,
    actionId: row.action_id == null ? null : Number(row.action_id),
    kind,
    origin,
    title: row.title ?? row.source_title ?? null,
    handle: row.handle ?? row.source_handle ?? null,
    description: row.description ?? null,
    text: row.text ?? null,
    url: row.url ?? null,
    postedAt: iso(row.posted_at as string | Date | null),
    lastPostAt: iso(row.last_post_at as string | Date | null),
    verifiedAt: iso(row.verified_at as string | Date | null),
    subscribers: row.subscribers == null ? null : Number(row.subscribers),
    postsPerWeek: row.posts_per_week == null ? null : Number(row.posts_per_week),
    views: row.views == null ? null : Number(row.views),
    reactions: row.reactions == null ? null : Number(row.reactions),
    indexedPostsCount: row.indexed_posts_count == null ? null : Number(row.indexed_posts_count),
    score: Number(row.quality_score ?? row.score ?? 55),
    reason: row.reason ?? "Найдено в уже собранных данных",
    verified: row.verified == null ? origin !== "web-cache" : Boolean(row.verified),
  };
}

function deduplicateSerializedResults(items: ReturnType<typeof serializeResult>[]) {
  const results = new Map<string, ReturnType<typeof serializeResult>>();
  for (const item of items) {
    const canonicalUrl = typeof item.url === "string"
      ? item.url
        .toLowerCase()
        .replace("https://t.me/s/", "https://t.me/")
        .replace(/\/$/u, "")
      : null;
    const key = canonicalUrl || `${item.kind}:${item.id}`;
    const previous = results.get(key);
    if (!previous) {
      results.set(key, item);
      continue;
    }
    const itemPriority = item.score * 10 + (item.kind === "trend" ? 2 : item.kind === "post" ? 1 : 0);
    const previousPriority = previous.score * 10 + (previous.kind === "trend" ? 2 : previous.kind === "post" ? 1 : 0);
    const stronger = itemPriority > previousPriority ? item : previous;
    results.set(key, {
      ...stronger,
      actionId: item.actionId ?? previous.actionId,
      verified: item.verified || previous.verified,
      verifiedAt: item.verifiedAt ?? previous.verifiedAt,
    });
  }
  return [...results.values()]
    .sort((a, b) => b.score - a.score || Date.parse(b.postedAt || b.lastPostAt || "") - Date.parse(a.postedAt || a.lastPostAt || ""));
}

function deduplicateResults(rows: Record<string, unknown>[]) {
  return deduplicateSerializedResults(rows.map(serializeResult));
}

function isFocusedResult(row: Record<string, unknown>, query: string) {
  if (
    String(row.match_mode || "") === "semantic_content"
    && Number(row.relevance_score) >= 35
  ) {
    return true;
  }
  const relevance = scoreRadarRelevance(query, {
    title: row.title,
    handle: row.handle,
    description: row.description,
    posts: row.text || row.search_text ? [{ text: row.text || row.search_text }] : [],
  });
  return relevance >= 35;
}

async function searchLocal(pool: Db, userId: number, channelId: number | null, query: string) {
  const ownerId = channelId ?? userId;
  const ownerColumn = channelId ? "competitor.channel_id" : "competitor.user_id";
  const textQuery = radarTsQuery(query);
  if (!textQuery) return [];

  const [competitors, trends, directory, cached] = await Promise.all([
    pool.query(
      `select post.id, post.text, post.views, post.reactions, post.posted_at,
              competitor.title, competitor.handle,
              case when competitor.handle is null then null
                   else 'https://t.me/' || competitor.handle || '/' || post.tg_msg_id end as url,
              'post' as kind, 'competitor' as origin,
              'competitor-post:' || post.id as result_key,
              least(95, 55 + round(ts_rank(post.tsv, to_tsquery('russian', $2)) * 100))::int as quality_score,
              'Совпадение в постах добавленного конкурента' as reason,
              true as verified
         from competitor_posts post
         join competitors competitor on competitor.id = post.competitor_id
        where ${ownerColumn} = $1
          and post.tsv @@ to_tsquery('russian', $2)
        order by ts_rank(post.tsv, to_tsquery('russian', $2)) desc, post.posted_at desc nulls last`,
      [ownerId, textQuery],
    ),
    pool.query(
      `select post.id, post.text, post.views, post.reactions, post.posted_at,
              source.title, source.handle,
              'https://t.me/' || source.handle || '/' || post.tg_msg_id as url,
              'trend' as kind, 'trend' as origin,
              'trend-post:' || post.id as result_key,
              least(95, 55 + round(ts_rank(to_tsvector('russian', coalesce(post.text, '')), to_tsquery('russian', $1)) * 100))::int as quality_score,
              'Совпадение в редакционной ленте трендов' as reason,
              true as verified
         from trend_posts post
         join trend_sources source on source.id = post.source_id and source.enabled = true
        where to_tsvector('russian', coalesce(post.text, '')) @@ to_tsquery('russian', $1)
        order by ts_rank(to_tsvector('russian', coalesce(post.text, '')), to_tsquery('russian', $1)) desc,
                 post.posted_at desc nulls last`,
      [textQuery],
    ),
    pool.query(
      `select source.id, source.title, source.handle, source.description,
              source.canonical_url as url, source.subscribers, source.last_post_at,
              source.posts_per_week, source.verified_at, source.indexed_posts_count,
              source.content_sample as search_text,
              'channel' as kind, 'directory' as origin,
              'directory:' || source.id as result_key,
              least(96, 50 + round(ts_rank(source.content_tsv, to_tsquery('russian', $1)) * 100))::int as quality_score,
              case
                when source.tsv @@ to_tsquery('russian', $1)
                  then 'Тема совпала с названием или описанием проверенного канала'
                else 'Тема найдена в ' || source.indexed_posts_count || ' публичных публикациях канала'
              end as reason,
              true as verified
         from discovered_sources source
        where source.verification_status = 'verified' and source.is_public = true
          and source.content_tsv @@ to_tsquery('russian', $1)
        order by ts_rank(source.content_tsv, to_tsquery('russian', $1)) desc, source.verified_at desc`,
      [textQuery],
    ),
    pool.query(
      `select result.id, result.result_type as kind, result.provider as origin,
              result.title, result.handle, result.description, result.text, result.url,
              result.posted_at, result.last_post_at, result.verified_at,
              result.subscribers, result.posts_per_week, result.views, result.reactions,
              nullif(result.raw_data->>'indexedPostsCount', '')::integer as indexed_posts_count,
              result.raw_data->>'matchMode' as match_mode, result.relevance_score,
              result.quality_score, result.reason, result.id as action_id,
              'radar-result:' || result.id as result_key, true as verified
         from radar_search_results result
         join radar_search_runs run on run.id = result.run_id and run.user_id = $1
        where result.user_id = $1 and result.tsv @@ to_tsquery('russian', $2)
          and result.verification_status = 'verified'
          and result.created_at >= now() - interval '30 days'
        order by result.quality_score desc, result.created_at desc`,
      [userId, textQuery],
    ),
  ]);

  const focusedLocal = [...competitors.rows, ...trends.rows]
    .map((row) => ({
      ...row,
      quality_score: scoreRadarRelevance(query, {
        title: row.title,
        handle: row.handle,
        description: row.description,
        posts: [{ text: row.text || row.search_text }],
      }),
    }))
    .filter((row) => Number(row.quality_score) >= 35);
  const focusedDirectory = directory.rows.filter((row) => isFocusedResult(row, query));
  const focusedCached = cached.rows.filter((row) => isFocusedResult(row, query));

  return deduplicateResults([
    ...focusedLocal,
    ...focusedDirectory,
    ...focusedCached,
  ]);
}

async function loadRunResults(pool: Db, userId: number, runId: number, afterId = 0) {
  const run = (
    await pool.query<RunRow>(
      `select id, query, normalized_query, status, stage, progress, provider,
              local_count, external_count, error_code, error_message,
              cache_expires_at, created_at, updated_at, completed_at
         from radar_search_runs where id = $1 and user_id = $2`,
      [runId, userId],
    )
  ).rows[0];
  if (!run) return null;
  const results = await pool.query(
    `select id, id as action_id, result_type as kind, provider as origin, title, handle,
            description, text, url, posted_at, last_post_at, verified_at, subscribers,
            posts_per_week, views, reactions,
            nullif(raw_data->>'indexedPostsCount', '')::integer as indexed_posts_count,
            raw_data->>'matchMode' as match_mode, relevance_score,
            quality_score, reason,
            'radar-result:' || id as result_key, true as verified
       from radar_search_results
      where run_id = $1 and user_id = $2 and verification_status = 'verified'
        and id > $3
      order by id`,
    [runId, userId, afterId],
  );
  return {
    run: serializeRun(run),
    results: deduplicateResults(results.rows.filter((row) => isFocusedResult(row, run.normalized_query))),
    resultCursor: results.rows.reduce((cursor, row) => Math.max(cursor, Number(row.id) || 0), afterId),
  };
}

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  const pool = getPool();
  const runId = Number(req.nextUrl.searchParams.get("run"));
  try {
    if (Number.isSafeInteger(runId) && runId > 0) {
      const requestedCursor = Number(req.nextUrl.searchParams.get("after"));
      const afterId = Number.isSafeInteger(requestedCursor) && requestedCursor > 0 ? requestedCursor : 0;
      const payload = await loadRunResults(pool, user.id, runId, afterId);
      return payload ? json(payload) : json({ error: "not_found" }, 404);
    }

    const query = normalizeRadarQuery(req.nextUrl.searchParams.get("q"));
    if (!query) return json({ results: [], groups: { channels: 0, posts: 0, trends: 0 } });
    if (query.length < 2) return json({ error: "query_too_short" }, 422);
    const wantedChannel = Number(req.nextUrl.searchParams.get("channel")) || null;
    const channelId = await resolveChannel(user.id, wantedChannel);
    if (wantedChannel && !channelId) return json({ error: "channel_not_found" }, 422);
    const results = await searchLocal(pool, user.id, channelId, query);
    const latest = (
      await pool.query<RunRow>(
        `select id, query, normalized_query, status, stage, progress, provider,
                local_count, external_count, error_code, error_message,
                cache_expires_at, created_at, updated_at, completed_at
          from radar_search_runs
          where user_id = $1 and channel_id is not distinct from $2 and normalized_query = $3
            and (
              (status = 'queued' and updated_at > now() - interval '2 minutes')
              or (status = 'running' and updated_at > now() - interval '10 minutes')
              or (status in ('ready','partial') and cache_expires_at > now())
            )
          order by created_at desc limit 1`,
        [user.id, channelId, query],
      )
    ).rows[0];
    const latestPayload = latest ? await loadRunResults(pool, user.id, Number(latest.id)) : null;
    const combinedResults = deduplicateSerializedResults([
      ...results,
      ...(latestPayload?.results ?? []),
    ]);
    return json({
      channelId,
      query,
      results: combinedResults,
      run: latestPayload?.run ?? serializeRun(latest),
      resultCursor: latestPayload?.resultCursor ?? 0,
      // Внешний слой теперь не запасной. Он всегда расширяет локальную базу, потому что
      // несколько знакомых каналов не означают, что вся ниша уже найдена.
      shouldExpand: !latest,
      groups: {
        channels: combinedResults.filter((item) => item.kind === "channel").length,
        posts: combinedResults.filter((item) => item.kind === "post").length,
        trends: combinedResults.filter((item) => item.kind === "trend").length,
      },
    });
  } catch (error) {
    console.error("[/api/radar/search] GET", error);
    return json({ error: "search_unavailable" }, 503);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return json({ error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const query = normalizeRadarQuery(body.q);
  if (query.length < 2) return json({ error: "query_too_short" }, 422);
  const wantedChannel = Number(body.channelId) || null;
  const channelId = await resolveChannel(user.id, wantedChannel);
  if (wantedChannel && !channelId) return json({ error: "channel_not_found" }, 422);
  const requestKey = String(req.headers.get("idempotency-key") || body.requestKey || randomUUID())
    .trim()
    .slice(0, 128);
  if (!/^[a-zA-Z0-9:_-]{8,128}$/u.test(requestKey)) return json({ error: "bad_request_key" }, 422);
  const force = body.force === true;
  const pool = getPool();

  try {
    if (!force) {
      const cached = (
        await pool.query<RunRow>(
          `select id, query, normalized_query, status, stage, progress, provider,
                  local_count, external_count, error_code, error_message,
                  cache_expires_at, created_at, updated_at, completed_at
             from radar_search_runs
            where user_id = $1 and channel_id is not distinct from $2 and normalized_query = $3
              and status in ('ready','partial') and cache_expires_at > now()
            order by completed_at desc nulls last limit 1`,
          [user.id, channelId, query],
        )
      ).rows[0];
      if (cached) {
        const payload = await loadRunResults(pool, user.id, Number(cached.id));
        return json({ ok: true, cached: true, ...payload });
      }
    }

    const replay = (
      await pool.query<RunRow>(
        `select id, query, normalized_query, status, stage, progress, provider,
                local_count, external_count, error_code, error_message,
                cache_expires_at, created_at, updated_at, completed_at
           from radar_search_runs where user_id = $1 and request_key = $2`,
        [user.id, requestKey],
      )
    ).rows[0];
    if (replay) {
      if (replay.normalized_query !== query) return json({ error: "idempotency_conflict" }, 409);
      const payload = await loadRunResults(pool, user.id, Number(replay.id));
      return json({ ok: true, replayed: true, ...payload }, replay.status === "ready" ? 200 : 202);
    }

    const local = await searchLocal(pool, user.id, channelId, query);
    const inserted = await pool.query<RunRow>(
      `insert into radar_search_runs
         (user_id, channel_id, request_key, query, normalized_query, local_count)
       values ($1, $2, $3, $4, $5, $6)
       returning id, query, normalized_query, status, stage, progress, provider,
                 local_count, external_count, error_code, error_message,
                 cache_expires_at, created_at, updated_at, completed_at`,
      [user.id, channelId, requestKey, String(body.q).trim().slice(0, 200), query, local.length],
    );
    let run = inserted.rows[0];
    try {
      await enqueueRadarSearch({ runId: Number(run.id), userId: user.id });
      run = (
        await pool.query<RunRow>(
          `update radar_search_runs set queue_confirmed_at = now(), updated_at = now()
            where id = $1 and user_id = $2 and status = 'queued'
          returning id, query, normalized_query, status, stage, progress, provider,
                    local_count, external_count, error_code, error_message,
                    cache_expires_at, created_at, updated_at, completed_at`,
          [run.id, user.id],
        )
      ).rows[0] || run;
    } catch {
      run = (
        await pool.query<RunRow>(
          `update radar_search_runs
              set status = 'failed', stage = 'failed', progress = 100,
                  error_code = 'queue_unavailable',
                  error_message = 'Поиск в интернете временно недоступен. Локальные результаты сохранены.',
                  completed_at = now(), updated_at = now()
            where id = $1 and user_id = $2
          returning id, query, normalized_query, status, stage, progress, provider,
                    local_count, external_count, error_code, error_message,
                    cache_expires_at, created_at, updated_at, completed_at`,
          [run.id, user.id],
        )
      ).rows[0] || run;
      return json({ error: "queue_unavailable", run: serializeRun(run), results: local }, 503);
    }

    return json({ ok: true, cached: false, run: serializeRun(run), results: local }, 202);
  } catch (error) {
    console.error("[/api/radar/search] POST", error);
    return json({ error: "search_unavailable" }, 503);
  }
}
