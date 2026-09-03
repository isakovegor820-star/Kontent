import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { loadAdminAudit, normalizeAdminAuditQuery } from "@/lib/admin-audit";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  try {
    const payload = await loadAdminAudit(getPool(), normalizeAdminAuditQuery(req.nextUrl.searchParams));
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/audit]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_audit_unavailable" }, { status: 503 });
  }
}
