// Ручной запуск сбора RSS-лент: кнопка «Проверить сейчас» на экране RSS.
// Крон и так проверяет каждые 30 минут — здесь человеку даём контроль «прямо сейчас».
// jobId по юзеру: частые клики не плодят задачи, а сливаются в одну (паттерн /api/trends).

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });

  try {
    await getStatsQueue().add(
      "rss-now",
      { userId: user.id },
      {
        jobId: `rss-now-${user.id}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 2,
        backoff: { type: "fixed", delay: 15000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/rss/refresh] POST", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
