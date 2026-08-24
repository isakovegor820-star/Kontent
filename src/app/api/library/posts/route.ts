// Библиотека сохранённых постов. GET — список, POST — сохранить, DELETE — удалить.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { normalizeLibraryLabels } from "@/lib/library";
import { resolveLibraryChannel } from "@/lib/library-server";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const q = req.nextUrl.searchParams.get("q")?.trim().slice(0, 100);
  try {
    const channelId = await resolveLibraryChannel(
      user.id,
      Number(req.nextUrl.searchParams.get("channel")) || null,
    );
    if (!channelId) return NextResponse.json({ error: "no_channel" }, { status: 422 });

    const params: unknown[] = [user.id, channelId];
    let where = "where saved.user_id = $1 and saved.channel_id = $2";
    if (q) {
      params.push(`%${q}%`);
      where += ` and (saved.text ilike $3 or saved.note ilike $3 or saved.source_title ilike $3 or exists (select 1 from unnest(saved.tags) t where t ilike $3))`;
    }
    const r = await getPool().query(
      `select saved.id, saved.channel_id, saved.kind, saved.source_post_id,
              saved.source_title, saved.source_url, saved.text, saved.note,
              saved.tags, saved.created_at,
              source_post.competitor_id as source_competitor_id
         from saved_posts saved
         left join competitor_posts source_post on source_post.id = saved.source_post_id
         ${where}
        order by saved.created_at desc
        limit 100`,
      params,
    );
    return NextResponse.json({ channelId, posts: r.rows });
  } catch (err) {
    console.error("[/api/library/posts] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: {
    channelId?: unknown;
    kind?: unknown;
    sourcePostId?: unknown;
    text?: unknown;
    note?: unknown;
    tags?: unknown;
  };
  try {
    body = await readJsonBodyValue(req);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const kind = body.kind === "reference" ? "reference" : "own";
  const note = body.note ? String(body.note).trim().slice(0, 300) : null;
  const tags = normalizeLibraryLabels(body.tags);

  try {
    const channelId = await resolveLibraryChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    if (kind === "reference") {
      const sourcePostId = Number(body.sourcePostId);
      if (!sourcePostId) return NextResponse.json({ ok: false, error: "bad_reference" }, { status: 422 });
      const source = await getPool().query<{
        id: string;
        text: string;
        title: string | null;
        handle: string | null;
        tg_msg_id: string | null;
      }>(
        `select post.id, post.text, competitor.title, competitor.handle, post.tg_msg_id
           from competitor_posts post
           join competitors competitor on competitor.id = post.competitor_id
          where post.id = $1 and competitor.channel_id = $2
            and post.text is not null and length(post.text) > 0`,
        [sourcePostId, channelId],
      );
      if (!source.rows[0]) {
        return NextResponse.json({ ok: false, error: "reference_not_found" }, { status: 404 });
      }
      const item = source.rows[0];
      const handle = item.handle?.replace(/^@/u, "") ?? null;
      const sourceUrl = handle && item.tg_msg_id ? `https://t.me/${handle}/${item.tg_msg_id}` : null;
      const saved = await getPool().query(
        `insert into saved_posts
           (user_id, channel_id, kind, source_post_id, source_title, source_url, text, note, tags)
         values ($1, $2, 'reference', $3, $4, $5, $6, $7, $8)
         on conflict (user_id, channel_id, source_post_id) where source_post_id is not null
         do update set source_title = excluded.source_title,
                       source_url = excluded.source_url,
                       text = excluded.text
         returning id`,
        [user.id, channelId, sourcePostId, item.title || (handle ? `@${handle}` : "Конкурент"), sourceUrl, item.text, note, tags],
      );
      return NextResponse.json({ ok: true, id: saved.rows[0]?.id, channelId, kind });
    }

    const text = String(body.text ?? "").trim().slice(0, 16384);
    if (!text) return NextResponse.json({ ok: false, error: "empty" }, { status: 422 });
    const r = await getPool().query(
      `insert into saved_posts (user_id, channel_id, kind, text, note, tags)
       values ($1, $2, 'own', $3, $4, $5) returning id`,
      [user.id, channelId, text, note, tags],
    );
    return NextResponse.json({ ok: true, id: r.rows[0]?.id, channelId, kind });
  } catch (err) {
    console.error("[/api/library/posts] POST", err);
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
    await getPool().query(`delete from saved_posts where id = $1 and user_id = $2`, [id, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/library/posts] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
