// Журнал RSS-записей: что пришло из лент и что с этим стало (пост создан / лимит / в работе).
// Без этого экрана репостер — чёрный ящик: человек добавил ленту и не видит, работает ли она.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const r = await getPool().query(
      `select i.id, i.title, i.link, i.published_at, i.status, i.post_id, i.fetched_at,
              f.title as feed_title
         from rss_items i
         join rss_feeds f on f.id = i.feed_id
        where f.user_id = $1
        order by i.fetched_at desc
        limit 30`,
      [user.id],
    );
    return NextResponse.json({ items: r.rows });
  } catch (err) {
    console.error("[/api/rss/items] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}
