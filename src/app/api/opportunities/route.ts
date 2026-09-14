import { NextRequest, NextResponse } from "next/server";

import { isContentIntelligenceError, listOpportunitySnapshots, refreshOpportunitySnapshots } from "@/lib/content-intelligence";
import { ProjectAccessError } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
const channelId = (req: NextRequest) => {
  const value = Number(req.nextUrl.searchParams.get("channel"));
  return Number.isSafeInteger(value) && value > 0 ? value : null;
};

async function respond(req: NextRequest, refresh: boolean) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const opportunities = refresh
      ? await refreshOpportunitySnapshots({ actorUserId: user.id, channelId: channelId(req) })
      : await listOpportunitySnapshots({ actorUserId: user.id, channelId: channelId(req) });
    return NextResponse.json({ opportunities }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (isContentIntelligenceError(error)) {
      const status = error.code === "feature_disabled" ? 403 : error.code === "channel_not_found" ? 422 : 400;
      return NextResponse.json({ error: error.code }, { status });
    }
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/opportunities]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "opportunities_unavailable" }, { status: 503 });
  }
}

export async function GET(req: NextRequest) { return respond(req, false); }
export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  return respond(req, true);
}
