// Д.5 — отправить недельный отчёт в Telegram-бот сейчас (обычно раз в неделю сам).

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    // attempts+backoff: если доставка сорвётся (воркер бросит ошибку), очередь повторит
    // отчёт через паузу — уведомление не теряется молча.
    await getStatsQueue().add(
      "report",
      { userId: user.id },
      {
        jobId: `report-${user.id}`,
        removeOnComplete: true,
        removeOnFail: true,
        attempts: 3,
        backoff: { type: "fixed", delay: 30000 },
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/stats/report]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
