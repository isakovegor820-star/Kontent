import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { projectExportContentDisposition } from "@/lib/project-export.mjs";
import {
  ProjectExportServiceError,
  resolveProjectExportDownload,
} from "@/lib/project-export-service";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, context: Context) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const rate = await checkRateLimit(`project-export:download:user:${user.id}`, 120, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const artifact = await resolveProjectExportDownload({
      pool: getPool(),
      actorUserId: user.id,
      operationId: (await context.params).id,
      token: req.headers.get("x-export-download-token"),
    });
    return new NextResponse(new Uint8Array(artifact.bytes), {
      status: 200,
      headers: {
        "content-type": artifact.mimeType,
        "content-disposition": projectExportContentDisposition(artifact.fileName),
        "content-length": String(artifact.bytes.byteLength),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
      },
    });
  } catch (error) {
    if (error instanceof ProjectExportServiceError) {
      return NextResponse.json({ ok: false, error: error.code }, {
        status: error.status,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "access_denied" }, { status: 403 });
    }
    console.error("[project-export-download-api]", { errorName: error instanceof Error ? error.name : "Error" });
    return NextResponse.json({ ok: false, error: "server" }, { status: 500 });
  }
}
