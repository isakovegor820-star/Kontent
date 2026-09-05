import { NextRequest, NextResponse } from "next/server";
import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { loadAdminAiSpend } from "@/lib/admin-operations-data";
import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
export async function GET(req: NextRequest) {
  try {
    const user = await getSessionUser(req);
    if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!hasAuroraAdminAccess(user)) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    return NextResponse.json(await loadAdminAiSpend(getPool(), req.nextUrl.searchParams), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "admin_data_unavailable" }, { status: 503 });
  }
}
