import { withProjectRoute } from "@/lib/project-route";
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
import { knowledgeChannelSelector, knowledgeFailure, requireKnowledgeChannel, withKnowledgeChannel } from "@/lib/knowledge-access";
import { fetchPublicPosts } from "@/lib/tg-public";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

async function handlePOST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const body = (await readJsonBodyValue(req).catch(() => ({}))) as { channelId?: number };

  try {
    const ch = await requireKnowledgeChannel(getPool(), user.id, knowledgeChannelSelector(body.channelId), "content.edit");
    const channelId = ch.id;
    if (!ch?.handle) return NextResponse.json({ ok: false, error: "no_handle" }, { status: 422 });

    const page = await fetchPublicPosts(ch.handle, 20);
    // Только осмысленные посты: служебные строки канала («Channel created») — не голос.
    const posts = (page.posts || []).map((t) => t.trim()).filter((t) => t.length >= 40);
    if (!posts.length) {
      return NextResponse.json({ ok: false, error: "no_posts" }, { status: 422 });
    }

    // Один источник на всё чтение. Перечитал канал — заменяем прежний срез стиля,
    // а не копим дубли: свежие посты вернее старых.
    const sourceId = await withKnowledgeChannel(getPool(), user.id, channelId, "content.edit", async (tx, channel) => {
      await tx.query(`delete from knowledge_sources where channel_id = $1 and kind = 'channel'`, [channel.id]);
      const ins = await tx.query<{ id: number }>(
        `insert into knowledge_sources (user_id, channel_id, kind, title, raw_text)
         values ($1, $2, 'channel', $3, $4) returning id`,
        [user.id, channel.id, `Стиль канала «${channel.title || channel.handle}»`, posts.join("\n\n")],
      );
      return Number(ins.rows[0].id);
    });

    await enqueueKnowledgeIndex(getStatsQueue(), sourceId)
      .catch(() => {});

    return NextResponse.json({ ok: true, posts: posts.length });
  } catch (err) {
    const failure = knowledgeFailure(err);
    if (failure) return NextResponse.json({ ok: false, error: failure.error }, { status: failure.status });
    console.error("[/api/knowledge/read-channel]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const POST = withProjectRoute(handlePOST);
