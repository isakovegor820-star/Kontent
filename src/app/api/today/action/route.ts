import { NextRequest, NextResponse } from "next/server";

import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { performTodaySmartAction, TodayActionError } from "@/lib/today-actions";
import type { TodaySmartAction } from "@/lib/today";

export const runtime = "nodejs";

const ACTIONS = new Set<TodaySmartAction["kind"]>([
  "create_opportunity_draft", "fill_calendar_gap", "continue_post", "improve_post",
]);

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await req.json() as Record<string, unknown>;
    const channelId = Number(body.channelId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TodayActionError("bad_channel");
    const fingerprint = String(body.fingerprint || "");
    if (!/^[0-9a-f]{64}$/u.test(fingerprint)) throw new TodayActionError("bad_fingerprint");
    const actionKind = String(body.actionKind || "") as TodaySmartAction["kind"];
    if (!ACTIONS.has(actionKind)) throw new TodayActionError("bad_action");
    const result = await performTodaySmartAction({
      actorUserId: user.id,
      channelId,
      fingerprint,
      actionKind,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (error instanceof TodayActionError) {
      const status = error.code === "action_not_found" ? 404
        : error.code === "action_changed" || error.code === "action_source_unavailable" ? 409
          : 422;
      return NextResponse.json({ error: error.code }, { status });
    }
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/today/action]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "action_unavailable" }, { status: 503 });
  }
}
