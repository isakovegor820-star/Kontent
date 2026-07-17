// Д.9 — «Одобрить всё»: все pending-посты плана → в очередь публикации (Д.3) каскадом.
// Одобрение без правок увеличивает streak (для разблокировки полного режима через 2 недели).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel, schedulePost } from "@/lib/autopilot";

export const runtime = "nodejs";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  draft: string;
  status: string;
  postId?: number;
}

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    const pool = getPool();
    const body = (await req.json().catch(() => ({}))) as { channelId?: number };
    const channelId = await resolveChannel(user.id, body.channelId ?? null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    // Атомарно «заявляем» план: pending → approving. Только победитель гонки получит items —
    // повторный клик/вкладка/ретрай вернёт rowCount 0 и НЕ спланирует посты второй раз (ревью Д.9).
    // Канал в условии обязателен: иначе «Одобрить всё» на канале Б одобрило бы план канала А.
    const claim = await pool.query<{ id: number; items: PlanItem[]; edited: boolean; channel_id: number }>(
      `update autopilot_plan set status = 'approving'
        where status = 'pending'
          and id = (select id from autopilot_plan
                      where user_id = $1 and channel_id = $2 and status = 'pending'
                      order by created_at desc limit 1 for update skip locked)
        returning id, items, edited, channel_id`,
      [user.id, channelId],
    );
    if (claim.rowCount === 0) {
      return NextResponse.json({ ok: true, scheduled: 0, already: true });
    }
    const plan = claim.rows[0];

    const items = plan.items;
    let scheduled = 0;
    for (const it of items) {
      if (it.status !== "pending" || it.postId) continue; // уже запланирован — не дублируем
      const t = new Date(it.scheduledAt).getTime();
      const at = t < Date.now() + 60_000 ? new Date(Date.now() + 120_000).toISOString() : it.scheduledAt;
      it.postId = await schedulePost(user.id, plan.channel_id, it.draft, at);
      it.status = "approved";
      it.scheduledAt = at;
      scheduled++;
    }

    await pool.query(`update autopilot_plan set items = $2, status = 'approved' where id = $1`, [
      plan.id,
      JSON.stringify(items),
    ]);
    // Честный streak: неделя засчитывается, только если реально что-то запланировано И план
    // не редактировали. С правками — сбрасываем (ревью Д.9).
    // Streak — свой у каждого канала: доверие к автопилоту зарабатывается на конкретном канале,
    // и одобрения на одном не должны открывать полный режим на другом.
    await pool.query(
      `update autopilot_settings
          set approvals_streak = case when $3 and not $4 then approvals_streak + 1 else 0 end,
              updated_at = now()
        where user_id = $1 and channel_id = $2`,
      [user.id, plan.channel_id, scheduled > 0, plan.edited],
    );

    return NextResponse.json({ ok: true, scheduled });
  } catch (err) {
    console.error("[/api/autopilot/approve]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
