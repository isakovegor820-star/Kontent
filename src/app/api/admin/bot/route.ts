import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { loadAdminBotData, probeAdminTelegramBot } from "@/lib/admin-bot";
import { normalizeAdminPeriod } from "@/lib/admin-dashboard";
import { getPool } from "@/lib/db";
import { probeRedisAndPublicationWorker } from "@/lib/readiness-probes";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  try {
    const periodDays = normalizeAdminPeriod(req.nextUrl.searchParams.get("days"));
    const [data, runtimeState, queue] = await Promise.all([
      loadAdminBotData(getPool(), periodDays),
      probeAdminTelegramBot(),
      probeRedisAndPublicationWorker(),
    ]);
    return NextResponse.json({
      ...data,
      checkedAt: new Date().toISOString(),
      runtime: runtimeState,
      workerState: queue.publicationWorker,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/bot]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "admin_bot_unavailable" }, { status: 503 });
  }
}
