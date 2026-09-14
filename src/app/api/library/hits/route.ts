// Хиты ниши для Библиотеки: залетевшие посты конкурентов (is_hit) по активному каналу.
// Это «на что ориентироваться»: человек видит, что реально заходит у соседей,
// с цифрами и ссылкой на оригинал. Данные уже собирает разведка — здесь только витрина.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { resolveLibraryChannel } from "@/lib/library-server";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const channelId = await resolveLibraryChannel(
      user.id,
      Number(req.nextUrl.searchParams.get("channel")) || null,
    );
    if (!channelId) return NextResponse.json({ error: "no_channel" }, { status: 422 });

    const r = await getPool().query(
      `select p.id, p.competitor_id, p.text, p.views, p.reactions, p.hit_ratio, p.posted_at, p.media, p.tg_msg_id,
              c.title as source_title, c.handle
         from competitor_posts p
         join competitors c on c.id = p.competitor_id
        where c.channel_id = $1 and p.is_hit and p.text is not null and length(p.text) > 0
        order by p.hit_ratio desc nulls last, p.posted_at desc
        limit 30`,
      [channelId],
    );
    return NextResponse.json({ channelId, hits: r.rows });
  } catch (err) {
    console.error("[/api/library/hits] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
