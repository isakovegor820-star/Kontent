import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { TodayError, updateTodayItemState } from "@/lib/today";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await readJsonBodyValue(req) as Record<string, unknown>;
    const state = body.state;
    if (state !== "active" && state !== "snoozed" && state !== "done") {
      throw new TodayError("bad_state");
    }
    const channelId = Number(body.channelId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TodayError("bad_channel");
    await updateTodayItemState({
      actorUserId: user.id,
      channelId,
      fingerprint: String(body.fingerprint || ""),
      state,
      snoozedUntil: typeof body.snoozedUntil === "string" ? body.snoozedUntil : null,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TodayError) return NextResponse.json({ error: error instanceof TodayError ? error.code : "bad_request" }, { status: 422 });
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/today/state]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "state_unavailable" }, { status: 503 });
  }
}
