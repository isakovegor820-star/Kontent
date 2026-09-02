import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import {
  cancelAdminPublication,
  rescheduleAdminPublication,
  retryAdminPublication,
  type AdminPublicationActionResult,
} from "@/lib/admin-publications";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { getPublishQueue } from "@/lib/queue";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function httpStatusFor(result: AdminPublicationActionResult): number {
  switch (result.status) {
    case "queued":
    case "cancelled":
      return 200;
    case "not_found":
      return 404;
    case "in_progress":
    case "not_allowed":
      return 409;
    case "invalid_time":
      return 422;
    case "queue_unavailable":
      return 503;
  }
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  const body = await readJsonBodyValue(req).catch(() => null) as Record<string, unknown> | null;
  const postId = positiveId(body?.postId);
  if (!body || typeof body.action !== "string" || !postId) {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  try {
    const pool = getPool();
    let result: AdminPublicationActionResult;
    if (body.action === "retry") {
      result = await retryAdminPublication(pool, getPublishQueue(), { actorUserId: user.id, postId, requestId });
    } else if (body.action === "cancel") {
      result = await cancelAdminPublication(pool, {
        actorUserId: user.id,
        postId,
        requestId,
        reason: typeof body.reason === "string" ? body.reason : null,
      });
    } else if (body.action === "reschedule") {
      if (typeof body.scheduledAt !== "string") {
        return NextResponse.json({ error: "invalid_time" }, { status: 422, headers });
      }
      result = await rescheduleAdminPublication(pool, getPublishQueue(), {
        actorUserId: user.id,
        postId,
        scheduledAt: body.scheduledAt,
        requestId,
      });
    } else {
      return NextResponse.json({ error: "unknown_action" }, { status: 400, headers });
    }
    return NextResponse.json({ ...result, requestId }, { status: httpStatusFor(result), headers });
  } catch (error) {
    console.error("[/api/admin/publications/actions]", {
      action: body.action,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_publication_action_failed" }, { status: 503, headers });
  }
}
