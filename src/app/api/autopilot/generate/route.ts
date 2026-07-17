// Д.9 — собрать план недели сейчас (кнопка «Собрать план») ДЛЯ ВЫБРАННОГО КАНАЛА.
// Строит воркер (ИИ + аналитика).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { ensureSettings, loadBrief, resolveChannel } from "@/lib/autopilot";
import { briefComplete } from "@/lib/brief";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();
    const body = (await req.json().catch(() => ({}))) as { channelId?: number };
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }

    // Без брифа ИИ не знает, о чём канал, и пишет наугад — план не собираем (ТЗ Д.9).
    const brief = await loadBrief(user.id, channelId);
    if (!brief.ready || !briefComplete(brief)) {
      return NextResponse.json({ ok: false, error: "no_brief" }, { status: 422 });
    }

    await ensureSettings(user.id, channelId);
    // Плейсхолдер «собираю» — интерфейс покажет процесс; воркер заменит его готовым планом.
    // Чистим только этот канал: у соседнего канала свой план, и он тут ни при чём.
    // Одной транзакцией: снести старый план и не вставить новый — значит оставить человека
    // ни с чем. Порознь эти два запроса ровно это и позволяют.
    const tx = await pool.connect();
    try {
      await tx.query("begin");
      await tx.query(
        `delete from autopilot_plan
          where user_id = $1 and channel_id = $2 and status in ('building', 'pending')`,
        [user.id, channelId],
      );
      await tx.query(
        `insert into autopilot_plan (user_id, channel_id, week_start, status)
         values ($1, $2, current_date, 'building')`,
        [user.id, channelId],
      );
      await tx.query("commit");
    } catch (err) {
      await tx.query("rollback").catch(() => {});
      throw err;
    } finally {
      tx.release();
    }

    await getStatsQueue().add(
      "autopilot-plan",
      { userId: user.id, channelId },
      { removeOnComplete: true, attempts: 2, backoff: { type: "fixed", delay: 20000 } },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/autopilot/generate]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
