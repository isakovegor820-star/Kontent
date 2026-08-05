// Счётчик генераций ИИ на сегодня (ТЗ Д.8 — видимый лимит). Читают студия и сайдбар.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { AI_DAILY_LIMIT, aiUsedToday } from "@/lib/ai-usage";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ used: 0, limit: AI_DAILY_LIMIT });
  try {
    const used = await aiUsedToday(user.id);
    return NextResponse.json({ used, limit: AI_DAILY_LIMIT, status: "ok" });
  } catch (error) {
    console.error("[/api/ai/usage] usage unavailable", {
      name: error instanceof Error ? error.name : "error",
    });
    return NextResponse.json(
      {
        used: null,
        limit: AI_DAILY_LIMIT,
        status: "unknown",
        error: "usage_unavailable",
      },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
}
