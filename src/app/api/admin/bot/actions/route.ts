import { NextRequest, NextResponse } from "next/server";

import { hasAuroraAdminAccess } from "@/lib/admin-access";
import {
  repairAdminTelegramConfiguration,
  sendAdminBotTest,
  setAdminBotAccess,
  setAdminBusinessAssistant,
} from "@/lib/admin-bot";
import { getPool } from "@/lib/db";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function positiveId(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function POST(req: NextRequest) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!hasAuroraAdminAccess(user)) {
    return NextResponse.json({ error: "access_denied" }, { status: 403 });
  }

  const body = await req.json().catch(() => null) as Record<string, unknown> | null;
  if (!body || typeof body.action !== "string") {
    return NextResponse.json({ error: "invalid_action" }, { status: 400 });
  }

  try {
    if (body.action === "repair_telegram_configuration") {
      const result = await repairAdminTelegramConfiguration(getPool(), { actorUserId: user.id });
      const status = result.status === "not_configured" ? 409 : result.status === "failed" ? 502 : 200;
      return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "test_delivery") {
      const targetUserId = positiveId(body.targetUserId);
      if (!targetUserId) return NextResponse.json({ error: "invalid_user_id" }, { status: 400 });
      const result = await sendAdminBotTest(getPool(), {
        actorUserId: user.id,
        targetUserId,
      });
      const status = result.status === "not_found" ? 404
        : ["not_linked", "disabled", "not_configured"].includes(result.status) ? 409
          : result.status === "failed" ? 502 : 200;
      return NextResponse.json(result, { status, headers: { "Cache-Control": "no-store" } });
    }

    if (body.action === "set_access") {
      const targetId = positiveId(body.targetId);
      const targetType = body.targetType === "user" || body.targetType === "project" ? body.targetType : null;
      if (!targetId || !targetType || typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "invalid_access_change" }, { status: 400 });
      }
      const result = await setAdminBotAccess(getPool(), {
        actorUserId: user.id,
        targetType,
        targetId,
        enabled: body.enabled,
        reason: typeof body.reason === "string" ? body.reason : undefined,
      });
      return NextResponse.json(result, {
        status: result.status === "not_found" ? 404 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    if (body.action === "set_business") {
      const projectId = positiveId(body.projectId);
      if (!projectId || typeof body.enabled !== "boolean") {
        return NextResponse.json({ error: "invalid_business_change" }, { status: 400 });
      }
      const result = await setAdminBusinessAssistant(getPool(), {
        actorUserId: user.id,
        projectId,
        enabled: body.enabled,
      });
      return NextResponse.json(result, {
        status: result.status === "not_connected" ? 409 : 200,
        headers: { "Cache-Control": "no-store" },
      });
    }

    return NextResponse.json({ error: "unknown_action" }, { status: 400 });
  } catch (error) {
    console.error("[/api/admin/bot/actions]", {
      action: body.action,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return NextResponse.json({ error: "admin_bot_action_failed" }, { status: 503 });
  }
}
