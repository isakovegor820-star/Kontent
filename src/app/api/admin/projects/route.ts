import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { loadAdminProjects, normalizeAdminProjectsQuery } from "@/lib/admin-projects";
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
    const query = normalizeAdminProjectsQuery(req.nextUrl.searchParams);
    const payload = await loadAdminProjects(getPool(), query);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/projects]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_projects_unavailable" }, { status: 503 });
  }
}
