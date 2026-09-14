import { NextRequest, NextResponse } from "next/server";

import { EvidenceProjectionError, loadEvidenceProjection, type EvidenceSubjectKind } from "@/lib/evidence-projection";
import { ProjectAccessError } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ kind: string; id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { kind, id } = await context.params;
  try {
    const evidence = await loadEvidenceProjection({ actorUserId: user.id, kind: kind as EvidenceSubjectKind, id: Number(id) });
    return NextResponse.json({ evidence }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof EvidenceProjectionError) return NextResponse.json({ error: error.code }, { status: error.code === "not_found" ? 404 : 400 });
    if (error instanceof ProjectAccessError) return NextResponse.json({ error: "access_denied" }, { status: 403 });
    console.error("[/api/evidence]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ error: "evidence_unavailable" }, { status: 503 });
  }
}
