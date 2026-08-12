import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { getSessionUser } from "@/lib/session";
import { tenChatIntegrationReadiness } from "@/lib/tenchat-integration.mjs";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const user = await getSessionUser(request);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    await requireSelectedProjectPermission(getPool(), user.id, "project.read");
    return NextResponse.json(
      { ok: true, provider: tenChatIntegrationReadiness(process.env) },
      { headers: { "cache-control": "private, no-store" } },
    );
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[tenchat-readiness-api]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
