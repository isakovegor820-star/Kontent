import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { normalizeAdminPeriod } from "@/lib/admin-dashboard";
import { loadAdminProjectDetail } from "@/lib/admin-projects";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  const { id } = await context.params;
  const projectId = Number(id);
  if (!Number.isSafeInteger(projectId) || projectId <= 0) {
    return NextResponse.json({ error: "invalid_project_id" }, { status: 400 });
  }

  try {
    const periodDays = normalizeAdminPeriod(req.nextUrl.searchParams.get("days"));
    const payload = await loadAdminProjectDetail(getPool(), projectId, periodDays);
    if (!payload) return NextResponse.json({ error: "project_not_found" }, { status: 404 });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/projects/:id]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_project_unavailable" }, { status: 503 });
  }
}
