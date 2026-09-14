// База знаний: прочитать открытую страницу канала и сохранить посты как ОБРАЗЕЦ СТИЛЯ.
//
// Это голос, а не факты. Индексатор пометит куски kind='voice' — автопилот берёт их для
// стиля, но НЕ как источник фактов. Иначе одна прошлая выдумка модели («решение суда от
// 10 июля») навсегда стала бы «фактом из базы» и закольцевала враньё.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { enqueueKnowledgeIndex } from "@/lib/knowledge-index-queue.mjs";
import { resolveChannel } from "@/lib/autopilot";
import { fetchPublicPosts } from "@/lib/tg-public";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await readJsonBodyValue(req).catch(() => ({}))) as { channelId?: number };

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
    const tx = await pool.connect();
    let sourceId: number;
    try {
      await tx.query("begin");
      await tx.query(
        `delete from knowledge_sources
          where user_id = $1 and channel_id = $2 and kind = 'channel'`,
        [user.id, channelId],
      );
      const ins = await tx.query<{ id: number }>(
        `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
         values ($1, $2, 'channel', $3, $4) returning id`,
        // Пустая строка между постами — граница куска: индексатор режет ровно по ней,
        // и каждый пост становится отдельным образцом стиля.
        [user.id, channelId, `Стиль канала «${ch.title || ch.handle}»`, posts.join("\n\n")],
      );
      sourceId = Number(ins.rows[0].id);
      await tx.query("commit");
    } catch (err) {
      await tx.query("rollback").catch(() => {});
      throw err;
    } finally {
      tx.release();
    }

    await enqueueKnowledgeIndex(getStatsQueue(), sourceId)
      .catch(() => {});

    return NextResponse.json({ ok: true, posts: posts.length });
  } catch (err) {
    console.error("[/api/knowledge/read-channel]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
