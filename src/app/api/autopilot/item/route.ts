// Д.9 — действие над одним постом плана: одобрить / отклонить / поправить текст.
// Правка сбрасывает streak (значит план не идеален — полный режим пока рано).

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { resolveChannel, schedulePost } from "@/lib/autopilot";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";

export const runtime = "nodejs";

interface PlanItem {
  i: number;
  scheduledAt: string;
  topic: string;
  draft: string;
  status: string;
  postId?: number;
}

export async function PATCH(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  let body: { index?: unknown; action?: unknown; draft?: unknown; channelId?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }
  const index = Number(body.index);
  const action = String(body.action);
  if (!Number.isInteger(index) || !["approve", "reject", "edit"].includes(action)) {
    return NextResponse.json({ ok: false, error: "bad_action" }, { status: 422 });
  }

  try {
    const pool = getPool();
    const channelId = await resolveChannel(user.id, Number(body.channelId) || null);
    if (!channelId) return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });

    // План ищем в пределах канала: иначе, открыв план канала Б, человек правил бы более
    // свежий план канала А — тот же список на экране, чужие посты в базе.
    const plan = (
      await pool.query<{ id: number; items: PlanItem[]; channel_id: number }>(
        `select id, items, channel_id from autopilot_plan
          where user_id = $1 and channel_id = $2 and status in ('pending', 'approved')
          order by created_at desc limit 1`,
        [user.id, channelId],
      )
    ).rows[0];
    if (!plan) return NextResponse.json({ ok: false, error: "no_plan" }, { status: 404 });

    const items = plan.items;
    const it = items.find((x) => x.i === index);
    if (!it) return NextResponse.json({ ok: false, error: "no_item" }, { status: 404 });

    let edited = false;

    if (action === "reject") {
      // Уже одобренный (в очереди) пост: снимаем задачу и отменяем ещё не вышедший пост,
      // иначе «убранный» пост всё равно опубликуется (ревью Д.9).
      if (it.postId) {
        const job = await getPublishQueue()
          .getJob(jobIdForPost(it.postId))
          .catch(() => null);
        if (job) await job.remove().catch(() => {});
        await pool.query(`delete from posts where id = $1 and status = 'scheduled'`, [it.postId]);
      }
      it.status = "rejected";
    } else if (action === "edit") {
      const next = String(body.draft ?? "").trim();
      if (next && next !== it.draft) {
        it.draft = next;
        edited = true;
        // Если пост уже одобрен и стоит в очереди — правим и сам запланированный пост,
        // иначе воркер опубликует старый текст (ревью Д.9).
        if (it.postId) {
          await pool.query(`update posts set text = $2 where id = $1 and status = 'scheduled'`, [
            it.postId,
            next,
          ]);
        }
      }
    } else if (action === "approve") {
      if (it.status === "pending" && !it.postId) {
        // Канал берём ИЗ ПЛАНА, а не отдельным запросом: пост уходит ровно в тот канал,
        // по брифу которого он написан. Отдельный select мог выбрать соседний канал.
        const t = new Date(it.scheduledAt).getTime();
        const at = t < Date.now() + 60_000 ? new Date(Date.now() + 120_000).toISOString() : it.scheduledAt;
        it.postId = await schedulePost(user.id, plan.channel_id, it.draft, at);
        it.scheduledAt = at;
        it.status = "approved";
      }
    }

    // Правку помечаем на плане (для честного streak при следующем «Одобрить всё»), а не глобально.
    await pool.query(
      `update autopilot_plan set items = $2, edited = edited or $3 where id = $1`,
      [plan.id, JSON.stringify(items), edited],
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/autopilot/item]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
