// База знаний: прочитать открытую страницу канала и сохранить посты как ОБРАЗЕЦ СТИЛЯ.
//
// Это голос, а не факты. Индексатор пометит куски kind='voice' — автопилот берёт их для
// стиля, но НЕ как источник фактов. Иначе одна прошлая выдумка модели («решение суда от
// 10 июля») навсегда стала бы «фактом из базы» и закольцевала враньё.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { resolveChannel } from "@/lib/autopilot";
import { fetchPublicPosts } from "@/lib/tg-public";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as { channelId?: number };

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    const ch = (
      await pool.query<{ handle: string | null; title: string | null }>(
        `select handle, title from channels where id = $1`,
        [channelId],
      )
    ).rows[0];
    if (!ch?.handle) return NextResponse.json({ ok: false, error: "no_handle" }, { status: 422 });

    const page = await fetchPublicPosts(ch.handle, 20);
    // Только осмысленные посты: служебные строки канала («Channel created») — не голос.
    const posts = (page.posts || []).map((t) => t.trim()).filter((t) => t.length >= 40);
    if (!posts.length) {
      return NextResponse.json({ ok: false, error: "no_posts" }, { status: 422 });
    }

    // Один источник на всё чтение. Перечитал канал — заменяем прежний срез стиля,
    // а не копим дубли: свежие посты вернее старых.
    await pool.query(`delete from knowledge_sources where channel_id = $1 and kind = 'channel'`, [
      channelId,
    ]);
    const ins = await pool.query<{ id: number }>(
      `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
       values ($1, $2, 'channel', $3, $4) returning id`,
      // Пустая строка между постами — граница куска: индексатор режет ровно по ней,
      // и каждый пост становится отдельным образцом стиля.
      [user.id, channelId, `Стиль канала «${ch.title || ch.handle}»`, posts.join("\n\n")],
    );

    await getStatsQueue()
      .add(
        "knowledge-index",
        { sourceId: Number(ins.rows[0].id) },
        { removeOnComplete: true, attempts: 3, backoff: { type: "fixed", delay: 20000 } },
      )
      .catch(() => {});

    return NextResponse.json({ ok: true, posts: posts.length });
  } catch (err) {
    console.error("[/api/knowledge/read-channel]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
