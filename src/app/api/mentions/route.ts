// Мониторинг упоминаний: GET — список упоминаний, POST — добавить query.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

// GET — последние упоминания + список queries
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();

    const queries = await pool.query(
      `select mq.id, mq.keyword, mq.networks, mq.is_active, mq.last_checked_at, mq.created_at,
              c.title as channel_title
         from mention_queries mq
         left join channels c on c.id = mq.channel_id
        where mq.user_id = $1
        order by mq.created_at desc`,
      [user.id],
    );

    const mentions = await pool.query(
      `select m.id, m.query_id, m.network, m.source_handle, m.source_title,
              m.post_url, m.text, m.author, m.posted_at, m.found_at,
              mq.keyword
         from mentions m
         join mention_queries mq on mq.id = m.query_id
        where mq.user_id = $1
        order by m.found_at desc
        limit 50`,
      [user.id],
    );

    return NextResponse.json({ queries: queries.rows, mentions: mentions.rows });
  } catch (err) {
    console.error("[/api/mentions] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

// POST — добавить query (ключевое слово для мониторинга)
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { keyword?: unknown; channelId?: unknown; networks?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const keyword = String(body.keyword ?? "").trim().slice(0, 100);
  if (!keyword) return NextResponse.json({ ok: false, error: "no_keyword" }, { status: 422 });
  if (keyword.length < 3) return NextResponse.json({ ok: false, error: "too_short" }, { status: 422 });

  const channelId = Number(body.channelId) || null;
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const networks = Array.isArray(body.networks) && body.networks.length
    ? body.networks.filter((n: unknown) => n === "tg" || n === "vk")
    : ["tg", "vk"];

  // Проверяем, что канал принадлежит юзеру
  const ch = await getPool().query(
    `select id from channels where id = $1 and user_id = $2`,
    [channelId, user.id],
  );
  if (!ch.rowCount) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  try {
    const r = await getPool().query(
      `insert into mention_queries (user_id, channel_id, keyword, networks)
       values ($1, $2, $3, $4)
       on conflict (channel_id, keyword) do update set is_active = true, networks = $4
       returning id`,
      [user.id, channelId, keyword, networks],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id });
  } catch (err) {
    console.error("[/api/mentions] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
