import { NextRequest, NextResponse } from "next/server";

import {
  GROWTH_TELEMETRY_EVENTS,
  isGrowthAccessError,
  recordGrowthTelemetry,
  type GrowthTelemetryEvent,
} from "@/lib/growth";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rate = await checkRateLimit(`growth-events:${user.id}`, 600, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const body = await req.json().catch(() => null) as {
    event?: unknown; moveId?: unknown; channelId?: unknown;
  } | null;
  const event = typeof body?.event === "string" && GROWTH_TELEMETRY_EVENTS.includes(body.event as GrowthTelemetryEvent)
    ? body.event as GrowthTelemetryEvent : null;
  const moveId = body?.moveId == null ? null : Number(body.moveId);
  const channelId = body?.channelId == null ? null : Number(body.channelId);
  if (!event
      || (moveId != null && (!Number.isSafeInteger(moveId) || moveId <= 0))
      || (channelId != null && (!Number.isSafeInteger(channelId) || channelId <= 0))) {
    return NextResponse.json({ ok: false, error: "bad_event" }, { status: 400 });
  }
  try {
    await recordGrowthTelemetry({ actorUserId: user.id, event, moveId, channelId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (isGrowthAccessError(error)) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    return NextResponse.json({ ok: false, error: "event_unavailable" }, { status: 503 });
  }
}
