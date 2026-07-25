// Библиотека сохранённых постов. GET — список, POST — сохранить, DELETE — удалить.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 100);
  try {
    const params: unknown[] = [user.id];
    let where = "where user_id = $1";
    if (q) {
      params.push(`%${q}%`);
      where += ` and (text ilike $2 or note ilike $2 or exists (select 1 from unnest(tags) t where t ilike $2))`;
    }
    const r = await getPool().query(
      `select id, text, note, tags, created_at from saved_posts ${where} order by created_at desc limit 100`,
      params,
    );
    return NextResponse.json({ posts: r.rows });
  } catch (err) {
    console.error("[/api/library/posts] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { text?: unknown; note?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const text = String(body.text ?? "").trim().slice(0, 16384);
  if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  const note = body.note ? String(body.note).trim().slice(0, 300) : null;
  const tags = Array.isArray(body.tags)
    ? [...new Set(body.tags.map((t) => String(t).trim().slice(0, 40)).filter(Boolean))].slice(0, 10)
    : [];

  try {
    const r = await getPool().query(
      `insert into saved_posts (user_id, text, note, tags) values ($1, $2, $3, $4) returning id`,
      [user.id, text, note, tags],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id });
  } catch (err) {
    console.error("[/api/library/posts] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    await getPool().query(`delete from saved_posts where id = $1 and user_id = $2`, [id, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/library/posts] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
