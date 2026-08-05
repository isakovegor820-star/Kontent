// Д.5 — ручной запуск сбора статистики (кнопка «Обновить»). Сбор делает воркер.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/session";
import { getStatsQueue } from "@/lib/queue";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const limited = await checkRateLimit(`stats-collect:${user.id}`, 3, 60);
  if (!limited.allowed) return rateLimitResponse(limited);
  try {
    await getStatsQueue().add(
      "collect",
      { userId: user.id },
      {
        jobId: `stats-collect-${user.id}`,
        attempts: 2,
        backoff: { type: "fixed", delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[/api/stats/collect]", err);
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
