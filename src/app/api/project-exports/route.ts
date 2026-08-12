import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { processProjectExportOperation, ProjectExportOperationError } from "@/lib/project-export-operation.mjs";
import { reconcileProjectExportOutbox } from "@/lib/project-export-outbox.mjs";
import { enqueueProjectExportJob } from "@/lib/project-export-queue.mjs";
import {
  createProjectExportOperation,
  getProjectExportOperation,
  listProjectExportOperations,
  ProjectExportServiceError,
  type ProjectExportRequest,
} from "@/lib/project-export-service";
import { ProjectAccessError } from "@/lib/project-permissions";
import { checkRateLimit, clientIp, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { readProjectExportBody } from "./_shared";

export const runtime = "nodejs";

function safeRequestId(req: NextRequest): string {
  const supplied = req.headers.get("x-request-id")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{1,128}$/u.test(supplied) ? supplied : randomUUID();
}

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { "cache-control": "private, no-store", "x-request-id": requestId },
  });
}

function safeError(error: unknown, requestId: string) {
  if (error instanceof ProjectExportServiceError) {
    return response(requestId, { ok: false, error: error.code }, error.status);
  }
  if (error instanceof ProjectAccessError) {
    return response(requestId, { ok: false, error: "access_denied" }, 403);
  }
  console.error("[project-export-api]", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return response(requestId, { ok: false, error: "server", retryable: true }, 500);
}

export async function GET(req: NextRequest) {
  const requestId = safeRequestId(req);
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);
  try {
    const exports = await listProjectExportOperations(
      getPool(),
      user.id,
      req.nextUrl.searchParams.get("limit"),
    );
    return response(requestId, { ok: true, exports });
  } catch (error) {
    return safeError(error, requestId);
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return response(randomUUID(), { ok: false, error: "forbidden_origin" }, 403);
  }
  const requestId = safeRequestId(req);
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  const [userRate, ipRate] = await Promise.all([
    checkRateLimit(`project-export:user:${user.id}`, 30, 3_600, { failureMode: "closed" }),
    checkRateLimit(`project-export:ip:${clientIp(req)}`, 60, 3_600, { failureMode: "closed" }),
  ]);
  if (!userRate.allowed) return rateLimitResponse(userRate);
  if (!ipRate.allowed) return rateLimitResponse(ipRate);

  const parsed = await readProjectExportBody(req, ["kind", "format", "period", "filters", "previewHash"]);
  if (!parsed.ok) {
    const status = parsed.error === "body_too_large" ? 413 : parsed.error === "unsupported_media_type" ? 415 : 400;
    return response(requestId, { ok: false, error: parsed.error }, status);
  }
  const body = parsed.body as ProjectExportRequest;
  const pool = getPool();
  try {
    const created = await createProjectExportOperation({
      pool,
      actorUserId: user.id,
      requestKey: req.headers.get("idempotency-key"),
      body,
      requestId,
    });

    if (["pending", "queued", "retryable_failed"].includes(created.status)) {
      if (created.dispatch === "sync") {
        try {
          await processProjectExportOperation({
            pool,
            operationId: created.id,
            projectId: created.projectId,
            snapshotHash: created.snapshotHash,
          });
        } catch (error) {
          if (!(error instanceof ProjectExportOperationError) || !error.retryable) throw error;
          await reconcileProjectExportOutbox({
            pool,
            operationId: created.id,
            enqueue: (data) => enqueueProjectExportJob(data),
          });
        }
      } else {
        await reconcileProjectExportOutbox({
          pool,
          operationId: created.id,
          enqueue: (data) => enqueueProjectExportJob(data),
        });
      }
    }

    const operation = await getProjectExportOperation(pool, user.id, created.id);
    const active = ["pending", "queued", "rendering", "retryable_failed"].includes(operation.status);
    const status = active ? 202 : created.replayed ? 200 : 201;
    return response(requestId, {
      ok: operation.status !== "failed" && operation.status !== "expired",
      operation,
      replayed: created.replayed,
    }, status);
  } catch (error) {
    return safeError(error, requestId);
  }
}
