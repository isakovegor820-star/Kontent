import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { NextRequest, NextResponse } from "next/server";

import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import {
  setTodayRecommendationPreference,
  TodayError,
  type TodayRecommendationKind,
} from "@/lib/today";

export const runtime = "nodejs";

const RECOMMENDATION_KINDS = new Set<TodayRecommendationKind>([
  "opportunity", "calendar_gap", "result_success", "result_weak", "result_update",
]);

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const body = await readJsonBodyValue(req) as Record<string, unknown>;
    const channelId = Number(body.channelId);
    if (!Number.isSafeInteger(channelId) || channelId <= 0) throw new TodayError("bad_channel");
    const recommendationKind = String(body.recommendationKind || "") as TodayRecommendationKind;
    const state = body.state;
    if (!RECOMMENDATION_KINDS.has(recommendationKind)) throw new TodayError("bad_recommendation_kind");
    if (state !== "hidden" && state !== "active") throw new TodayError("bad_state");
    await setTodayRecommendationPreference({
      actorUserId: user.id,
      channelId,
      recommendationKind,
      state,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SyntaxError) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    if (error instanceof TodayError) return NextResponse.json({ error: error.code }, { status: error.code === "channel_not_found" ? 404 : 422 });
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/today/feedback]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "feedback_unavailable" }, { status: 503 });
  }
}
