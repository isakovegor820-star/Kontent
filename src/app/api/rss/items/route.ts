// Журнал RSS-записей: что пришло из лент и что с этим стало (пост создан / лимит / в работе).
// Без этого экрана репостер — чёрный ящик: человек добавил ленту и не видит, работает ли она.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const rawChannelId = req.nextUrl.searchParams.get("channelId");
  const channelId = rawChannelId === null ? null : Number(rawChannelId);
  if (channelId !== null && (!Number.isSafeInteger(channelId) || channelId <= 0)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 400 });
  }

  try {
    const r = await getPool().query(
      `select i.id, i.feed_id, i.title, i.link, i.published_at, i.status, i.skip_reason,
              i.post_id, i.fetched_at,
              f.title as feed_title, p.status as post_status
         from rss_items i
         join rss_feeds f on f.id = i.feed_id
         left join posts p on p.id = i.post_id
        where f.user_id = $1
          and ($2::bigint is null or f.channel_id = $2)
        order by i.fetched_at desc
        limit 30`,
      [user.id, channelId],
    );
    return NextResponse.json({
      items: r.rows.map((item) => ({
        ...item,
        id: Number(item.id),
        feed_id: Number(item.feed_id),
        post_id: item.post_id == null ? null : Number(item.post_id),
      })),
    });
  } catch (err) {
    console.error("[/api/rss/items] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
