import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { getPool } from "@/lib/db";
import { getLegalVisualRender } from "@/lib/legal-visual-service";
import { getSessionUser } from "@/lib/session";
import { legalStudioError, legalStudioJson, positiveRouteId } from "../../../_shared";

export const runtime = "nodejs";
type Context = { params: Promise<{ id: string; operationId: string }> };

export async function GET(request: NextRequest, context: Context) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  const params = await context.params;
  const designId = positiveRouteId(params.id);
  const operationId = positiveRouteId(params.operationId);
  if (!designId || !operationId) return legalStudioJson({ ok: false, error: "bad_request" }, 400, requestId);
  try {
    const render = await getLegalVisualRender({
      pool: getPool(), actorUserId: user.id, designId, operationId,
    });
    return legalStudioJson({ ok: true, render }, 200, requestId);
  } catch (error) {
    return legalStudioError(error, requestId);
  }
}
