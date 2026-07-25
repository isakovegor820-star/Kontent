// RSS-фид по id: DELETE — удалить, PATCH — пауза/возобновление, лимит.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Params) {
  const { id } = await params;
  const user = await _req ? await getSessionUser(_req) : null;
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const feedId = Number(id);
  if (!feedId) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  try {
    await getPool().query(`delete from rss_feeds where id = $1 and user_id = $2`, [feedId, user.id]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/rss/[id]] DELETE", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest, { params }: Params) {
  const { id } = await params;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const feedId = Number(id);
  if (!feedId) return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });

  let body: { isActive?: unknown; maxPerDay?: unknown; aiSummarize?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const sets: string[] = [];
  const vals: unknown[] = [];
  let i = 1;

  if (typeof body.isActive === "boolean") {
    sets.push(`is_active = $${i++}`);
    vals.push(body.isActive);
  }
  if (body.maxPerDay != null) {
    sets.push(`max_per_day = $${i++}`);
    vals.push(Math.min(Math.max(Number(body.maxPerDay) || 3, 1), 20));
  }
  if (typeof body.aiSummarize === "boolean") {
    sets.push(`ai_summarize = $${i++}`);
    vals.push(body.aiSummarize);
  }

  if (!sets.length) return NextResponse.json({ ok: false, error: "nothing" }, { status: 422 });

  vals.push(feedId, user.id);
  try {
    await getPool().query(
      `update rss_feeds set ${sets.join(", ")} where id = $${i++} and user_id = $${i}`,
      vals,
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/rss/[id]] PATCH", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
