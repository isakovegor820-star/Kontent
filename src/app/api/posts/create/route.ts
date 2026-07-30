// Д.3 — создание поста. Сохраняем со статусом scheduled и кладём ОТЛОЖЕННУЮ задачу
// в очередь: задержка = сколько осталось до scheduled_at. Дальше пост живёт в очереди
// на сервере — компьютер пользователя больше не нужен.

import { NextRequest, NextResponse } from "next/server";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import { getPublishQueue, jobIdForPost } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: {
    channelId?: unknown;
    text?: unknown;
    scheduledAt?: unknown;
    media?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_request" }, { status: 400 });
  }

  const channelId = Number(body.channelId);
  const text = String(body.text ?? "").trim();
  const scheduledAtRaw = body.scheduledAt ? new Date(String(body.scheduledAt)) : null;

  if (!channelId) {
    return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
  }
  if (!text) {
    return NextResponse.json({ ok: false, error: "empty_text" }, { status: 422 });
  }
  if (!scheduledAtRaw || Number.isNaN(scheduledAtRaw.getTime())) {
    return NextResponse.json({ ok: false, error: "no_time" }, { status: 422 });
  }
  if (scheduledAtRaw.getTime() < Date.now() - 60_000) {
    return NextResponse.json({ ok: false, error: "past" }, { status: 422 });
  }

  try {
    const pool = getPool();

    // Канал должен принадлежать этому пользователю.
    const ch = await pool.query<{ id: number }>(
      `select id from channels where id = $1 and user_id = $2 and is_active = true`,
      [channelId, user.id],
    );
    if (ch.rowCount === 0) {
      return NextResponse.json({ ok: false, error: "no_channel" }, { status: 422 });
    }

    let media: string | null = null;
    if (body.media && typeof body.media === "object") {
      const candidate = body.media as { assetId?: unknown; kind?: unknown };
      const assetId = Number(candidate.assetId);
      if (Number.isInteger(assetId) && assetId > 0) {
        const owned = await pool.query<{ id: number; kind: "image" | "video" }>(
          `select id, kind from media_assets where id = $1 and user_id = $2`,
          [assetId, user.id],
        );
        if (owned.rowCount === 0) {
          return NextResponse.json({ ok: false, error: "bad_media" }, { status: 422 });
        }
        media = JSON.stringify({ assetId, kind: owned.rows[0].kind });
      }
    }
    const ins = await pool.query<{ id: number }>(
      `insert into posts (user_id, channel_id, text, media, scheduled_at, status)
       values ($1, $2, $3, $4, $5, 'scheduled') returning id`,
      [user.id, channelId, text, media, scheduledAtRaw.toISOString()],
    );
    const postId = ins.rows[0].id;

    // Отложенная задача: публиковать через (scheduled_at − сейчас).
    const delay = Math.max(0, scheduledAtRaw.getTime() - Date.now());
    await getPublishQueue().add(
      "publish",
      { postId },
      {
        delay,
        jobId: jobIdForPost(postId),
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return NextResponse.json({ ok: true, postId, scheduledAt: scheduledAtRaw.toISOString() });
  } catch (err) {
    console.error("[/api/posts/create]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
