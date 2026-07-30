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
import { isAutopilotBuildStale } from "@/lib/autopilot-build";

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
    let plan =
      (
        await pool.query(
          `select id, week_start, items, rules, status, created_at
             from autopilot_plan where user_id = $1 and channel_id = $2
             order by created_at desc limit 1`,
          [user.id, channelId],
        )
      ).rows[0] ?? null;

    // A queue job can survive while its worker is stopped. Without a deadline that left the
    // page polling `building` forever (the real incident lasted two days). Mark only the exact
    // placeholder we loaded, so a concurrent retry for the same channel cannot be touched.
    if (
      plan?.status === "building" &&
      isAutopilotBuildStale(plan.created_at, settings.post_frequency)
    ) {
      const expired = await pool.query(
        `update autopilot_plan set status = 'error'
          where id = $1 and user_id = $2 and channel_id = $3 and status = 'building'
          returning id`,
        [plan.id, user.id, channelId],
      );
      if (expired.rowCount) plan = { ...plan, status: "error", errorReason: "timeout" };
    }
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
