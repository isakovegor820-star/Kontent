import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getLegalVideoProductionBrief } from "@/lib/legal-video-script-service";
import { getSessionUser } from "@/lib/session";
import { legalStudioError, legalStudioJson, positiveRouteId } from "../../../legal-visuals/_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const id = positiveRouteId((await context.params).id);
  if (!id) return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const { record, brief } = await getLegalVideoProductionBrief({
      pool: getPool(), actorUserId: user.id, scriptId: id,
    });
    return new NextResponse(brief, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "content-disposition": `attachment; filename="legal-video-${record.id}-r${record.revision}.txt"`,
        "cache-control": "private, no-store",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
