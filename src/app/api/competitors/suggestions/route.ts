// Д.6+ — находки агента: «похоже, это твои соседи».
//
// Платформа НЕ добавляет их сама. Она приносит проверенный список с обоснованием — кто
// именно из твоей ниши на них ссылается — а решает человек. Это не вежливость: агент,
// который молча набивает список конкурентов, через неделю собирает досье не на тех.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { resolveChannel } from "@/lib/autopilot";
import { MAX_COMPETITORS } from "@/lib/competitors";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

interface Row {
  id: number;
  handle: string;
  title: string | null;
  description: string | null;
  subscribers: number | null;
  posts: number;
  last_post_at: Date | string | null;
  posts_per_week: number | string | null;
  mentioned_by: number;
  sources: string[];
  /** true — ИИ сверил с брифом и подтвердил нишу; null — движка не было, никто не судил */
  on_topic: boolean | null;
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ suggestions: [] });

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ suggestions: [], seeds: 0 });
    // on_topic = false — ИИ сверил посты кандидата с брифом и сказал «другая тема». Не
    // показываем: именно так сюда приезжали PR-агентство и софтверный блог — на них просто
    // кто-то сослался. null — движка не было, судить было некому: показываем, но честно помечаем.
    const rows = (
      await pool.query<Row>(
        // to_jsonb делает чтение обратно совместимым во время rolling deploy: если новая
        // колонка ещё не применена, PostgreSQL вернёт null вместо падения всего блока.
        `select s.id,
                s.handle,
                s.title,
                to_jsonb(s) ->> 'description' as description,
                s.subscribers,
                s.posts,
                (to_jsonb(s) ->> 'last_post_at')::timestamptz as last_post_at,
                (to_jsonb(s) ->> 'posts_per_week')::numeric as posts_per_week,
                s.mentioned_by,
                s.sources,
                s.on_topic
           from competitor_suggestions s
          where s.channel_id = $1 and s.status = 'new' and s.on_topic is distinct from false
          order by s.on_topic desc nulls last, s.mentioned_by desc, s.subscribers desc nulls last
          limit 24`,
        [channelId],
      )
    ).rows;

    // Сиды помогают графу упоминаний. Без них всё равно можно искать в интернете по брифу.
    const seeds = (
      await pool.query<{ n: number }>(
        `select (
           (select count(*) from competitors where channel_id = $1 and network = 'tg')
           + (select count(*) from channels where id = $1 and handle is not null)
         )::int as n`,
        [channelId],
      )
    ).rows[0].n;

    return NextResponse.json({
      suggestions: rows.map((r) => ({
        id: r.id,
        handle: r.handle,
        title: r.title,
        description: r.description,
        subscribers: r.subscribers,
        posts: r.posts,
        lastPostAt:
          r.last_post_at instanceof Date
            ? r.last_post_at.toISOString()
            : r.last_post_at,
        postsPerWeek: r.posts_per_week == null ? null : Number(r.posts_per_week),
        mentionedBy: r.mentioned_by,
        sources: r.sources ?? [],
        onTopic: r.on_topic,
        link: `https://t.me/${r.handle}`,
      })),
      seeds,
      channelId,
    });
  } catch (err) {
    console.error("[/api/competitors/suggestions]", err);
    return NextResponse.json(
      { suggestions: [], seeds: 0, error: "suggestions_unavailable" },
      { status: 503 },
    );
  }
}

/** Запустить поиск сейчас. Сам поиск делает воркер — он ходит наружу, не роут. */
export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    // Ищем соседей тому каналу, который человек сейчас смотрит.
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    await getStatsQueue().add(
      "discover",
      { userId: user.id, channelId },
      {
        jobId: `discover-${user.id}-${channelId}`,
        removeOnComplete: true,
        attempts: 2,
        backoff: { type: "fixed", delay: 15000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/competitors/suggestions] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

/** Принять находку (добавить в конкуренты) или отклонить. */
export async function PATCH(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { id?: unknown; action?: unknown };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const id = Number(body.id);
  const action = String(body.action);
  if (!Number.isInteger(id) || !["add", "dismiss"].includes(action)) {
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });
  }

  try {
    const pool = getPool();
    const sug = (
      await pool.query<{ handle: string; channel_id: number }>(
        `select handle, channel_id from competitor_suggestions
          where id = $1 and status = 'new'`,
        [id],
      )
    ).rows[0];
    if (!sug) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    // Находка принадлежит каналу проекта, а не человеку, который первым запустил
    // поиск. Любой текущий участник того же выбранного проекта должен иметь
    // возможность принять её; чужой канал по-прежнему отсекает серверный scope.
    const channelId = await resolveChannel(user.id, Number(sug.channel_id));
    if (channelId !== Number(sug.channel_id)) {
      return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });
    }

    if (action === "dismiss") {
      await pool.query(
        `update competitor_suggestions set status = 'dismissed'
          where id = $1 and channel_id = $2 and status = 'new'`,
        [id, channelId],
      );
      return NextResponse.json({ ok: true });
    }

    // Тот же лимит, что и при ручном добавлении: находки не должны его обходить.
    const cnt = (
      await pool.query<{ n: number }>(
        `select count(*)::int as n from competitors where channel_id = $1 and network = 'tg'`,
        [sug.channel_id],
      )
    ).rows[0].n;
    if (cnt >= MAX_COMPETITORS) {
      return NextResponse.json({ ok: false, error: "limit", limit: MAX_COMPETITORS }, { status: 409 });
    }

    // Канал берём из самой находки: её нашли и признали «своей темой» для конкретного канала.
    const ins = await pool.query<{ id: number }>(
      `insert into competitors (user_id, channel_id, network, handle, status)
       values ($1, $2, 'tg', $3, 'pending')
       on conflict (channel_id, network, handle) do nothing
       returning id`,
      [user.id, sug.channel_id, sug.handle],
    );
    await pool.query(
      `update competitor_suggestions set status = 'added'
        where id = $1 and channel_id = $2 and status = 'new'`,
      [id, channelId],
    );

    // Собираем досье сразу — иначе карточка висела бы пустой до следующего цикла.
    if (ins.rows[0]) {
      await getStatsQueue().add(
        "competitor",
        { id: ins.rows[0].id },
        { removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 15000 } },
      );
    }
    return NextResponse.json({ ok: true, handle: sug.handle });
  } catch (err) {
    console.error("[/api/competitors/suggestions] PATCH", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
