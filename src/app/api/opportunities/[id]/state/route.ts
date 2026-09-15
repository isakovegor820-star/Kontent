import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { clearOpportunityState, isContentIntelligenceError, setOpportunityState } from "@/lib/content-intelligence";
import { ProjectAccessError } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };
const STATES = new Set(["saved", "dismissed", "used", "not_relevant"]);
const REASONS = new Set(["wrong_topic", "already_covered", "weak_source", "bad_timing", "other"]);

async function handlePOST(req: NextRequest, { params }: Context) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const opportunityId = Number((await params).id);
  if (!Number.isSafeInteger(opportunityId) || opportunityId <= 0) {
    return NextResponse.json({ error: "bad_opportunity" }, { status: 400 });
  }
  const body = await readJsonBodyValue(req).catch(() => null) as { state?: unknown; reasonCode?: unknown } | null;
  if (!body || typeof body.state !== "string" || !STATES.has(body.state)
    || (body.reasonCode != null && (typeof body.reasonCode !== "string" || !REASONS.has(body.reasonCode)))) {
    return NextResponse.json({ error: "bad_state" }, { status: 422 });
  }
  try {
    await setOpportunityState({
      actorUserId: user.id,
      opportunityId,
      state: body.state as "saved" | "dismissed" | "used" | "not_relevant",
      reasonCode: body.reasonCode as "wrong_topic" | "already_covered" | "weak_source" | "bad_timing" | "other" | undefined,
    });
    return NextResponse.json({ ok: true, state: body.state });
  } catch (error) {
    if (isContentIntelligenceError(error)) return NextResponse.json({ error: error.code }, { status: 404 });
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/opportunities/:id/state]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "state_unavailable" }, { status: 503 });
  }
}

async function handleDELETE(req: NextRequest, { params }: Context) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const opportunityId = Number((await params).id);
  if (!Number.isSafeInteger(opportunityId) || opportunityId <= 0) {
    return NextResponse.json({ error: "bad_opportunity" }, { status: 400 });
  }
  try {
    await clearOpportunityState({ actorUserId: user.id, opportunityId });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/opportunities/:id/state] DELETE", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "state_unavailable" }, { status: 503 });
  }
}

export const POST = withProjectRoute(handlePOST);
export const DELETE = withProjectRoute(handleDELETE);
