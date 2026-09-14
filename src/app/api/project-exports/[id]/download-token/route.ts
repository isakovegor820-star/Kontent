import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  createProjectExportDownloadToken,
  ProjectExportServiceError,
} from "@/lib/project-export-service";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rate = await checkRateLimit(`project-export:token:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  const operationId = (await context.params).id;
  try {
    const result = await createProjectExportDownloadToken({
      pool: getPool(),
      actorUserId: user.id,
      operationId,
    });
    return NextResponse.json({
      ok: true,
      token: result.token,
      expiresAt: result.expiresAt,
      downloadUrl: `/api/project-exports/${encodeURIComponent(operationId)}/download`,
      tokenHeader: "x-export-download-token",
    }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ProjectExportServiceError) {
      return NextResponse.json({ ok: false, error: error.code }, { status: error.status });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[project-export-token-api]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
