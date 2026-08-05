import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { connectLegalSource } from "@/lib/legal-source-service";
import { parseLegalConnectInput } from "@/lib/legal-sources";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function reply(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return reply(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return reply(requestId, { ok: false, error: "unauthorized" }, 401);
  const raw = await req.json().catch(() => null);
  const parsed = parseLegalConnectInput(raw, req.headers.get("idempotency-key"));
  if (!parsed.ok) {
    const status = parsed.error === "forbidden_credential_field" ? 422 : 400;
    return reply(requestId, { ok: false, error: parsed.error }, status);
  }

  try {
    const result = await connectLegalSource(getPool(), {
      userId: user.id,
      requestKey: parsed.value.requestKey,
      providerId: parsed.value.providerId,
      token: parsed.value.token,
    });
    return reply(requestId, result.body, result.status);
  } catch (error) {
    console.error("[/api/legal-sources/connections] POST", {
      requestId,
      providerId: parsed.value.providerId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return reply(requestId, { ok: false, error: "unavailable", retryable: true }, 503);
  }
}
