// RSS-ленты: GET — список фидов юзера, POST — добавить фид.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const r = await getPool().query(
      `select f.id, f.url, f.title, f.channel_id, f.is_active, f.ai_summarize, f.max_per_day,
              f.last_fetched_at, f.created_at, c.title as channel_title
         from rss_feeds f
         left join channels c on c.id = f.channel_id
        where f.user_id = $1
        order by f.created_at desc`,
      [user.id],
    );
    return NextResponse.json({ feeds: r.rows });
  } catch (err) {
    console.error("[/api/rss] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { url?: unknown; channelId?: unknown; aiSummarize?: unknown; maxPerDay?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const url = String(body.url ?? "").trim().slice(0, 500);
  if (!url || !/^https?:\/\//i.test(url)) {
    return NextResponse.json({ ok: false, error: "bad_url" }, { status: 422 });
  }

  const channelId = Number(body.channelId) || null;
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  // Проверяем, что канал принадлежит юзеру
  const ch = await getPool().query(
    `select id from channels where id = $1 and user_id = $2 and is_active`,
    [channelId, user.id],
  );
  if (!ch.rowCount) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const aiSummarize = body.aiSummarize !== false;
  const maxPerDay = Math.min(Math.max(Number(body.maxPerDay) || 3, 1), 20);

  // Проверяем, что фид живой (fetch с таймаутом)
  let title: string | null = null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { "user-agent": "Aurora-RSS/1.0" } });
    if (!res.ok) return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 422 });
    const xml = await res.text();
    // Достаём title канала из XML
    const m = xml.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").trim().slice(0, 200) : null;
  } catch {
    return NextResponse.json({ ok: false, error: "fetch_failed" }, { status: 422 });
  }

  try {
    const r = await getPool().query(
      `insert into rss_feeds (user_id, channel_id, url, title, ai_summarize, max_per_day)
       values ($1, $2, $3, $4, $5, $6)
       on conflict (user_id, url) do update set is_active = true, channel_id = $2
       returning id`,
      [user.id, channelId, url, title, aiSummarize, maxPerDay],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id, title });
  } catch (err) {
    console.error("[/api/rss] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
