import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { recordAdminObservation } from "@/lib/admin-observation-audit";
import { loadAdminSystemDiagnostics } from "@/lib/admin-system-diagnostics";
import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, { status, headers: { "cache-control": "no-store" } });
}

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return json({ error: "unauthorized" }, 401);
  if (!hasAuroraAdminAccess(user)) return json({ error: "access_denied" }, 403);

  // Keep diagnostics usable during the Redis incident they are meant to explain.
  // Authentication is fail-closed; rate limiting is best-effort for this read-only route.
  const rate = await checkRateLimit(`admin-system:${user.id}`, 120, 60, { failureMode: "open" });
  if (!rate.allowed) {
    const limited = rateLimitResponse(rate);
    limited.headers.set("cache-control", "no-store");
    return limited;
  }

  try {
    const diagnostics = await loadAdminSystemDiagnostics();
    await recordAdminObservation({
      db: getPool(),
      actorUserId: user.id,
      action: "admin.system.read",
      targetType: req.nextUrl.searchParams.get("component") ? "component" : "runtime",
      targetId: req.nextUrl.searchParams.get("component"),
      requestId: req.headers.get("x-request-id"),
    });
    return json(diagnostics);
  } catch (error) {
    console.error("[/api/admin/system]", {
      errorName: error instanceof Error ? error.name : "Error",
      code: "admin_system_unavailable",
    });
    return json({ error: "admin_system_unavailable" }, 503);
  }
}
