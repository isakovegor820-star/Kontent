import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  previewProjectExport,
  ProjectExportServiceError,
  type ProjectExportRequest,
} from "@/lib/project-export-service";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { readProjectExportBody } from "../_shared";

export const runtime = "nodejs";

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": requestId },
  });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return response(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  const [userRate, ipRate] = await Promise.all([
    checkRateLimit(`project-export-preview:user:${user.id}`, 120, 3_600, { failureMode: "closed" }),
    checkRateLimit(`project-export-preview:ip:${clientIp(req)}`, 240, 3_600, { failureMode: "closed" }),
  ]);
  if (!userRate.allowed) return rateLimitResponse(userRate);
  if (!ipRate.allowed) return rateLimitResponse(ipRate);

  const parsed = await readProjectExportBody(req, ["kind", "format", "period", "filters"]);
  if (!parsed.ok) {
    const status = parsed.error === "body_too_large" ? 413 : parsed.error === "unsupported_media_type" ? 415 : 400;
    return response(requestId, { ok: false, error: parsed.error }, status);
  }
  const body = parsed.body as ProjectExportRequest;
  try {
    const preview = await previewProjectExport({
      db: getPool(),
      actorUserId: user.id,
      body,
    });
    return response(requestId, { ok: true, preview });
  } catch (error) {
    if (error instanceof ProjectExportServiceError) {
      return response(requestId, { ok: false, error: error.code }, error.status);
    }
    if (error instanceof ProjectAccessError) {
      return response(requestId, { ok: false, error: "access_denied" }, 403);
    }
    console.error("[project-export-preview-api]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return response(requestId, { ok: false, error: "server", retryable: true }, 500);
  }
}
