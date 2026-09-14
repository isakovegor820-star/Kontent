import { NextRequest, NextResponse } from "next/server";

import { ProjectAccessError } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { loadTodayBoard, TodayError } from "@/lib/today";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const rawChannel = req.nextUrl.searchParams.get("channel");
  const requested = rawChannel == null ? null : Number(rawChannel);
  if (requested != null && (!Number.isSafeInteger(requested) || requested <= 0)) {
    return NextResponse.json({ error: "bad_channel" }, { status: 422, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const board = await loadTodayBoard({ actorUserId: user.id, channelId: requested });
    return NextResponse.json(board, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof TodayError) {
      const status = error.code === "channel_not_found" ? 404 : 422;
      return NextResponse.json({ error: error.code }, { status, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/today]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "today_unavailable" }, { status: 503 });
  }
}
