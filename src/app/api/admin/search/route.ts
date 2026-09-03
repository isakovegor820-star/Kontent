import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import { searchAdminEntities } from "@/lib/admin-search";
import { getPool } from "@/lib/db";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }
  // Typed-ahead search is chatty; best-effort limiting keeps a stuck key from hammering the DB.
  const rate = await checkRateLimit(`admin-search:${user.id}`, 120, 60, { failureMode: "open" });
  if (!rate.allowed) {
    const limited = rateLimitResponse(rate);
    limited.headers.set("cache-control", "no-store");
    return limited;
  }

  try {
    const payload = await searchAdminEntities(getPool(), req.nextUrl.searchParams.get("q") ?? "");
    return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("[/api/admin/search]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "admin_search_unavailable" }, { status: 503 });
  }
}
