import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { aiProviderHealthSnapshot } from "@/lib/ai-provider-health";
import { loadAdminDashboard, normalizeAdminPeriod, type AdminSystemState } from "@/lib/admin-dashboard";
import { getPool } from "@/lib/db";
import { probeAiConfiguration, probeRedisAndPublicationWorker } from "@/lib/readiness-probes";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function aiState(): AdminSystemState["ai"] {
  if (!probeAiConfiguration()) return "not_configured";
  const providers = aiProviderHealthSnapshot();
  if (providers.length === 0) return "unobserved";
  return providers.some((provider) => provider.state === "open" || provider.lastOutcome !== "success")
    ? "attention"
    : "healthy";
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  const periodDays = normalizeAdminPeriod(req.nextUrl.searchParams.get("days"));
  try {
    const [dashboard, queue] = await Promise.all([
      loadAdminDashboard(getPool(), periodDays),
      probeRedisAndPublicationWorker(),
    ]);
    return NextResponse.json({
      ...dashboard,
      checkedAt: new Date().toISOString(),
      system: {
        database: "up",
        redis: queue.redis,
        publicationWorker: queue.publicationWorker,
        ai: aiState(),
      } satisfies AdminSystemState,
    }, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    console.error("[/api/admin/overview]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_overview_unavailable" }, { status: 503 });
  }
}
