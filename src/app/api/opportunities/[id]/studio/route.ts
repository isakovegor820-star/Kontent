import { NextRequest, NextResponse } from "next/server";

import { getOpportunityStudioContext, isContentIntelligenceError } from "@/lib/content-intelligence";
import { ProjectAccessError } from "@/lib/project-permissions";
import { withProjectRoute } from "@/lib/project-route";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

async function handleGET(req: NextRequest, { params }: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const opportunityId = Number((await params).id);
  if (!Number.isSafeInteger(opportunityId) || opportunityId <= 0) {
    return NextResponse.json({ error: "bad_opportunity" }, { status: 400 });
  }
  try {
    const context = await getOpportunityStudioContext({ actorUserId: user.id, opportunityId });
    return NextResponse.json({ context });
  } catch (error) {
    if (isContentIntelligenceError(error)) {
      const status = error.code === "opportunity_not_found"
        ? 404
        : error.code === "opportunity_stale"
          ? 409
          : 422;
      return NextResponse.json({ error: error.code }, { status });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ error: "access_denied" }, { status: 403 });
    }
    console.error("[/api/opportunities/:id/studio]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "studio_context_unavailable" }, { status: 503 });
  }
}

export const GET = withProjectRoute(handleGET);
