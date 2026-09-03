import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { loadAdminPublications, normalizeAdminPublicationsQuery } from "@/lib/admin-publications";
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
    const query = normalizeAdminPublicationsQuery(req.nextUrl.searchParams);
    const payload = await loadAdminPublications(getPool(), query);
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/publications]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_publications_unavailable" }, { status: 503 });
  }
}
