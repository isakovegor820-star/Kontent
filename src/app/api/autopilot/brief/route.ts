// Д.9 — бриф контента: что за канал. Без него автопилот не запускается.
// GET отдаёт бриф + список рубрик для интерфейса, POST сохраняет.
// ready ставит только пользователь, подтвердив бриф глазами (честность).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { RUBRICS, briefComplete, normalizeBrief } from "@/lib/brief";
import { loadBrief, resolveChannel } from "@/lib/autopilot";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const channelId = await resolveChannel(user.id, Number(req.nextUrl.searchParams.get("channel")) || null);
    if (!channelId) return NextResponse.json({ brief: null, rubrics: RUBRICS });
    return NextResponse.json({ brief: await loadBrief(user.id, channelId), rubrics: RUBRICS, channelId });
  } catch (err) {
    console.error("[/api/autopilot/brief] GET", err);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  // Бриф описывает КАНАЛ, а не человека: «о чём канал» у двух каналов разное по определению.
  const channelId = await resolveChannel(user.id, Number((body as { channelId?: unknown })?.channelId) || null);
  if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

  const b = normalizeBrief(body);
  // Подтвердить можно только заполненный бриф — иначе ИИ снова начнёт выдумывать.
  if (b.ready && !briefComplete(b)) {
    return NextResponse.json({ ok: false, error: "incomplete" }, { status: 422 });
  }

  try {
    await getPool().query(
      `insert into content_brief (user_id, channel_id, niche, audience, rubrics, goal, cta, taboo, ready, source, updated_at)
            values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       on conflict (user_id, channel_id) do update
            set niche = excluded.niche, audience = excluded.audience, rubrics = excluded.rubrics,
                goal = excluded.goal, cta = excluded.cta, taboo = excluded.taboo,
                ready = excluded.ready, source = excluded.source, updated_at = now()`,
      [user.id, channelId, b.niche, b.audience, b.rubrics, b.goal, b.cta, b.taboo, b.ready, b.source],
    );
    return NextResponse.json({ ok: true, brief: b });
  } catch (err) {
    console.error("[/api/autopilot/brief] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
