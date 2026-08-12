import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  getProjectExportOperation,
  ProjectExportServiceError,
  revokeProjectExportOperation,
} from "@/lib/project-export-service";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function json(body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": randomUUID() },
  });
}

function failure(error: unknown) {
  if (error instanceof ProjectExportServiceError) return json({ ok: false, error: error.code }, error.status);
  if (error instanceof ProjectAccessError) return json({ ok: false, error: "access_denied" }, 403);
  console.error("[project-export-operation-api]", { errorName: error instanceof Error ? error.name : "Error" });
  return json({ ok: false, error: "server" }, 500);
}

export async function GET(req: NextRequest, context: Context) {
  const user = await getSessionUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  try {
    const operation = await getProjectExportOperation(getPool(), user.id, (await context.params).id);
    return json({ ok: true, operation });
  } catch (error) {
    return failure(error);
  }
}

export async function DELETE(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return json({ ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return json({ ok: false, error: "unauthorized" }, 401);
  const rate = await checkRateLimit(`project-export:revoke:user:${user.id}`, 60, 3_600, { failureMode: "closed" });
  if (!rate.allowed) return rateLimitResponse(rate);
  try {
    const operation = await revokeProjectExportOperation({
      pool: getPool(),
      actorUserId: user.id,
      operationId: (await context.params).id,
    });
    return json({ ok: true, operation });
  } catch (error) {
    return failure(error);
  }
}
