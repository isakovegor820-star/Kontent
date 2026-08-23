import { NextRequest, NextResponse } from "next/server";

import { ProjectAccessError } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { loadTodayBoard } from "@/lib/today";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const requested = Number(req.nextUrl.searchParams.get("channel"));
  try {
    const board = await loadTodayBoard({ actorUserId: user.id, channelId: Number.isSafeInteger(requested) && requested > 0 ? requested : null });
    return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/today]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "today_unavailable" }, { status: 503 });
  }
}
