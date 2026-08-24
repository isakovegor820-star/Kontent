// Нишевой радар: CRUD алертов по ключевым словам.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

// GET — список алертов юзера, POST — создать алерт
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const r = await getPool().query(
      `select a.id, a.channel_id, a.keyword, a.is_active, a.last_notified_at, a.created_at,
              c.title as channel_title,
              (select count(*)::int from niche_matches m where m.alert_id = a.id) as matches_count
         from niche_alerts a
         left join channels c on c.id = a.channel_id
        where a.user_id = $1
        order by a.created_at desc`,
      [user.id],
    );
    return NextResponse.json({ alerts: r.rows });
  } catch (err) {
    console.error("[/api/radar/alerts] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { keyword?: unknown; channelId?: unknown };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const keyword = String(body.keyword ?? "").trim().slice(0, 100);
  if (!keyword) return NextResponse.json({ ok: false, error: "no_keyword" }, { status: 422 });

  const channelId = Number(body.channelId) || null;
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  // Проверяем, что канал принадлежит юзеру
  const ch = await getPool().query(
    `select id from channels where id = $1 and user_id = $2`,
    [channelId, user.id],
  );
  if (!ch.rowCount) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  try {
    const r = await getPool().query(
      `insert into niche_alerts (user_id, channel_id, keyword)
       values ($1, $2, $3)
       on conflict (channel_id, keyword) do update set is_active = true
       returning id`,
      [user.id, channelId, keyword],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id });
  } catch (err) {
    console.error("[/api/radar/alerts] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

// DELETE — удалить алерт
export async function DELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    await getPool().query(`delete from niche_alerts where id = $1 and user_id = $2`, [id, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/radar/alerts] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
