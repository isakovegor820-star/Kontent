// Д.9 — состояние автопилота ДЛЯ ВЫБРАННОГО КАНАЛА: настройки + последний план + бриф.
//
// Раньше всё это было на пользователе: одни настройки, один бриф, план без канала. При двух
// каналах автопилот молча писал в один из них по брифу другого, а второй не получал ничего.
// Теперь у каждого канала своё, а страница спрашивает состояние конкретного канала.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";

export const runtime = "nodejs";

const empty = { settings: null, plan: null, hasChannel: false, brief: null, channels: [], channelId: null };

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json(empty);

  try {
    const pool = getPool();

    // Список каналов нужен странице всегда: без него не нарисовать выбор.
    const channels = (
      await pool.query<{ id: string; title: string | null; handle: string | null }>(
        `select id, title, handle from channels
          where user_id = $1 and network = 'tg' and is_active = true order by id`,
        [user.id],
      )
    ).rows.map((c) => ({ ...c, id: Number(c.id) })); // bigint приезжает строкой — см. resolveChannel
    if (!channels.length) return NextResponse.json({ ...empty, channels: [] });

    const wanted = Number(req.nextUrl.searchParams.get("channel")) || null;
    const channelId = await resolveChannel(user.id, wanted);
    // Попросили чужой или отключённый канал — честная 404, а не тихая подмена на свой.
    if (!channelId) return NextResponse.json({ ...empty, channels }, { status: wanted ? 404 : 200 });

    const settings = await ensureSettings(user.id, channelId);
    const plan =
      (
        await pool.query(
          `select id, week_start, items, rules, status, created_at
             from autopilot_plan where user_id = $1 and channel_id = $2
             order by created_at desc limit 1`,
          [user.id, channelId],
        )
      ).rows[0] ?? null;
    const brief = await loadBrief(user.id, channelId);

    return NextResponse.json({
      settings,
      plan,
      hasChannel: true,
      brief,
      briefReady: brief.ready && briefComplete(brief),
      channels,
      channelId,
    });
  } catch (err) {
    console.error("[/api/autopilot]", err);
    return NextResponse.json(empty);
  }
}
