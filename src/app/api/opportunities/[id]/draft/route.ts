import { NextRequest, NextResponse } from "next/server";

import { createOpportunitySourceContext, isContentIntelligenceError } from "@/lib/content-intelligence";
import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function POST(req: NextRequest, context: RouteContext<"/api/opportunities/[id]/draft">) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await context.params;
  try {
    const result = await createOpportunitySourceContext({ actorUserId: user.id, opportunityId: Number(id) });
    return NextResponse.json(result, { status: result.created ? 201 : 200 });
  } catch (error) {
    if (isContentIntelligenceError(error)) {
      const status = error.code === "opportunity_not_found" ? 404 : error.code === "opportunity_stale" ? 409 : 422;
      return NextResponse.json({ error: error.code }, { status });
    }
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/opportunities/:id/draft]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "draft_context_unavailable" }, { status: 503 });
  }
}
