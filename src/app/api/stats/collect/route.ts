// Д.5 — ручной запуск сбора статистики (кнопка «Обновить»). Сбор делает воркер.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    await getStatsQueue().add("collect", {}, { removeOnComplete: true });
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/stats/collect]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
