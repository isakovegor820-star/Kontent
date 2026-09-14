import { requireSelectedProjectPermission } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
// Нишевой радар: CRUD алертов по ключевым словам.

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

// GET — список алертов юзера, POST — создать алерт
async function handleGET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "project.read");
    const r = await getPool().query(
      `select a.id, a.channel_id, a.keyword, a.is_active, a.last_notified_at, a.created_at,
              c.title as channel_title,
              (select count(*)::int from niche_matches m where m.alert_id = a.id) as matches_count
         from niche_alerts a
         left join channels c on c.id = a.channel_id
        where c.project_id = $1
        order by a.created_at desc`,
      [membership.projectId],
    );
    return NextResponse.json({ alerts: r.rows });
  } catch (err) {
    console.error("[/api/radar/alerts] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

async function handlePOST(req: NextRequest) {
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

  const membership = await requireSelectedProjectPermission(getPool(), user.id, "content.create");
  // Канал должен принадлежать проекту запроса.
  const ch = await getPool().query(
    `select id from channels where id = $1 and project_id = $2`,
    [channelId, membership.projectId],
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
async function handleDELETE(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!id) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    const membership = await requireSelectedProjectPermission(getPool(), user.id, "content.edit");
    await getPool().query(`delete from niche_alerts where id = $1 and exists (select 1 from channels channel where channel.id = niche_alerts.channel_id and channel.project_id = $2)`, [id, membership.projectId]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/radar/alerts] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export const GET = withProjectRoute(handleGET);
export const POST = withProjectRoute(handlePOST);
export const DELETE = withProjectRoute(handleDELETE);
