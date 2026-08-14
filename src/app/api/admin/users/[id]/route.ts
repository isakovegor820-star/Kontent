import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { normalizeAdminPeriod } from "@/lib/admin-dashboard";
import { loadAdminUserDetail } from "@/lib/admin-users";
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
  const userId = Number(id);
  if (!Number.isSafeInteger(userId) || userId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }

  try {
    const periodDays = normalizeAdminPeriod(req.nextUrl.searchParams.get("days"));
    const payload = await loadAdminUserDetail(getPool(), userId, periodDays);
    if (!payload) return NextResponse.json({ error: "user_not_found" }, { status: 404 });
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/users/:id]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_user_unavailable" }, { status: 503 });
  }
}
