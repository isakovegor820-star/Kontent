// Наборы хэштегов. GET — список, POST — создать, DELETE — удалить.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { normalizeLibraryTags } from "@/lib/library";
import { resolveLibraryChannel } from "@/lib/library-server";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

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
      `select id, channel_id, name, tags, created_at
         from hashtag_sets where user_id = $1 and channel_id = $2 order by created_at desc`,
      [user.id, channelId],
    );
    return NextResponse.json({ channelId, sets: r.rows });
  } catch (err) {
    console.error("[/api/library/tags] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { channelId?: unknown; name?: unknown; tags?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const name = String(body.name ?? "").trim().slice(0, 80);
  if (!name) return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
  const tags = normalizeLibraryTags(body.tags);
  if (!tags.length) return NextResponse.json({ ok: false, error: "no_tags" }, { status: 422 });

  try {
    const channelId = await resolveLibraryChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    const r = await getPool().query(
      `insert into hashtag_sets (user_id, channel_id, name, tags) values ($1, $2, $3, $4)
       on conflict (user_id, channel_id, name) do update set tags = excluded.tags
       returning id`,
      [user.id, channelId, name, tags],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id, channelId });
  } catch (err) {
    console.error("[/api/library/tags] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
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
