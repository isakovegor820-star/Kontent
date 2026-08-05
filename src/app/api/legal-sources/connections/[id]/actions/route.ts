import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { runLegalSourceAction } from "@/lib/legal-source-service";
import { parseLegalActionInput } from "@/lib/legal-sources";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function reply(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function POST(req: NextRequest, context: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return reply(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return reply(requestId, { ok: false, error: "unauthorized" }, 401);
  const connectionId = Number((await context.params).id);
  if (!Number.isSafeInteger(connectionId) || connectionId <= 0) {
    return reply(requestId, { ok: false, error: "bad_id" }, 400);
  }
  const raw = await req.json().catch(() => null);
  const parsed = parseLegalActionInput(raw, req.headers.get("idempotency-key"));
  if (!parsed.ok) {
    const status = parsed.error === "forbidden_credential_field" ? 422 : 400;
    return reply(requestId, { ok: false, error: parsed.error }, status);
  }

  try {
    const result = await runLegalSourceAction(getPool(), {
      userId: user.id,
      connectionId,
      requestKey: parsed.value.requestKey,
      action: parsed.value.action,
    });
    return reply(requestId, result.body, result.status);
  } catch (error) {
    console.error("[/api/legal-sources/connections/:id/actions] POST", {
      requestId,
      connectionId,
      action: parsed.value.action,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return reply(requestId, { ok: false, error: "unavailable", retryable: true }, 503);
  }
}
