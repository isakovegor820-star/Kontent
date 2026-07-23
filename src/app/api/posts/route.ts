// Д.3/Д.4 — список реальных постов пользователя (для календаря).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ posts: [] });

  try {
    const rows = await getPool().query(
      `select p.id, p.text, p.media, p.scheduled_at, p.status, p.tg_message_id, p.vk_post_id,
              p.attempts, p.last_error, p.published_at, p.created_at,
              p.channel_id, c.network, c.title as channel_title, c.handle, c.vk_group_id
         from posts p
         join channels c on c.id = p.channel_id
        where p.user_id = $1
        order by p.scheduled_at nulls last, p.id desc
        limit 200`,
      [user.id],
    );
    return NextResponse.json({ posts: rows.rows });
  } catch (err) {
    console.error("[/api/posts]", err);
    return NextResponse.json({ posts: [] });
  }
}
