import { NextRequest, NextResponse } from "next/server";

import { isGrowthAccessError, loadGrowthBoard } from "@/lib/growth";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const requested = Number(req.nextUrl.searchParams.get("channel"));
    const board = await loadGrowthBoard({
      actorUserId: user.id,
      channelId: Number.isSafeInteger(requested) && requested > 0 ? requested : null,
    });
    return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isGrowthAccessError(error)) {
      return NextResponse.json({ error: "access_denied" }, { status: 403, headers: { "Cache-Control": "no-store" } });
    }
    console.error("[/api/growth]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "growth_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
