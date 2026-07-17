// Д.3 — ручная повторная отправка поста (кнопка «Отправить снова» после сбоя).
// Возвращаем пост в очередь на публикацию сейчас; статус снова scheduled.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  const { id } = await ctx.params;
  const postId = Number(id);
  if (!postId) return NextResponse.json({ ok: false, error: "bad_id" }, { status: 400 });

  try {
    const pool = getPool();
    // Вернуть в работу можно свой пост, который упал, ждёт, или застрял в 'publishing'
    // (процесс умер во время отправки) — иначе такой пост не спасти (ревью).
    const upd = await pool.query<{ id: number }>(
      `update posts set status = 'scheduled', last_error = null
        where id = $1 and user_id = $2 and status in ('failed', 'scheduled', 'publishing')
        returning id`,
      [postId, user.id],
    );
    if (upd.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "not_retryable" }, { status: 422 });
    }

    await getPublishQueue().add(
      "publish",
      { postId },
      { jobId: `${jobIdForPost(postId)}-manual-${Date.now()}`, removeOnComplete: true },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/posts/:id/retry]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
