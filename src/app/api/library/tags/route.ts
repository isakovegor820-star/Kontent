// Наборы хэштегов. GET — список, POST — создать, DELETE — удалить.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const r = await getPool().query(
      `select id, name, tags, created_at from hashtag_sets where user_id = $1 order by created_at desc`,
      [user.id],
    );
    return NextResponse.json({ sets: r.rows });
  } catch (err) {
    console.error("[/api/library/tags] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { name?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((t) => String(t).trim().slice(0, 50)).filter(Boolean))].slice(0, 30)
    : [];
  if (!tags.length) return NextResponse.json({ ok: false, error: "no_tags" }, { status: 422 });

  try {
    const r = await getPool().query(
      `insert into hashtag_sets (user_id, name, tags) values ($1, $2, $3)
       on conflict (user_id, name) do update set tags = excluded.tags
       returning id`,
      [user.id, name, tags],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id });
  } catch (err) {
    console.error("[/api/library/tags] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    await getPool().query(`delete from hashtag_sets where id = $1 and user_id = $2`, [id, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/library/tags] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
