import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { resolveProviderLiveWriteBoundary } from "@/lib/provider-write-boundary.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

/** Explicit terminal API path: it never queues work and never contacts TenChat. */
export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  try {
    await requireSelectedProjectPermission(getPool(), user.id, "content.publish");
    const boundary = resolveProviderLiveWriteBoundary("tenchat");
    return NextResponse.json({
      ok: false,
      error: boundary.error,
      code: boundary.code,
      terminal: boundary.terminal,
      retryable: boundary.retryable,
      livePublished: false,
      exportAvailable: boundary.exportAvailable,
      exportUrl: "/api/channels/tenchat/export",
      message: boundary.message,
    }, { status: 409, headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[tenchat-publish-boundary-api]", {
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ ok: false, error: "server", livePublished: false }, { status: 500 });
  }
}
