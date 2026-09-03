import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import {
  revokeAdminAccountSessions,
  sendAdminPasswordReset,
  setAdminAccountAiLimit,
  setAdminAccountBlock,
  type AdminAccountActionResult,
} from "@/lib/admin-account-actions";
import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type Context = { params: Promise<{ id: string }> };

function httpStatusFor(result: AdminAccountActionResult): number {
  switch (result.status) {
    case "ok":
      return 200;
    case "not_found":
      return 404;
    case "self":
    case "protected":
    case "already":
      return 409;
    case "no_email":
    case "invalid_limit":
      return 422;
  }
}

function safeReason(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 500) : null;
}

export async function POST(req: NextRequest, context: Context) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  const { id } = await context.params;
  const targetUserId = Number(id);
  if (!Number.isSafeInteger(targetUserId) || targetUserId <= 0) {
    return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
  }
  const body = await readJsonBodyValue(req).catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  const headers = { "Cache-Control": "no-store", "x-request-id": requestId };
  const base = {
    actorUserId: user.id,
    targetUserId,
    requestId,
    isProtected: (candidate: { id: number; email: string | null }) => hasAuroraAdminAccess(candidate),
  };
  try {
    const pool = getPool();
    let result: AdminAccountActionResult;
    switch (body.action) {
      case "block":
        result = await setAdminAccountBlock(pool, { ...base, blocked: true, reason: safeReason(body.reason) });
        break;
      case "unblock":
        result = await setAdminAccountBlock(pool, { ...base, blocked: false, reason: safeReason(body.reason) });
        break;
      case "revoke_sessions":
        result = await revokeAdminAccountSessions(pool, { ...base, reason: safeReason(body.reason) });
        break;
      case "send_password_reset":
        result = await sendAdminPasswordReset(pool, base);
        break;
      case "set_ai_limit": {
        const limit = body.limit == null ? null : Number(body.limit);
        if (limit !== null && !Number.isFinite(limit)) {
          return NextResponse.json({ error: "invalid_limit" }, { status: 422, headers });
        }
        result = await setAdminAccountAiLimit(pool, { ...base, limit, reason: safeReason(body.reason) });
        break;
      }
      default:
        return NextResponse.json({ error: "unknown_action" }, { status: 400, headers });
    }
    return NextResponse.json({ ...result, requestId }, { status: httpStatusFor(result), headers });
  } catch (error) {
    console.error("[/api/admin/users/:id/actions]", {
      action: body.action,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_account_action_failed" }, { status: 503, headers });
  }
}
