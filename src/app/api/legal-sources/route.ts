import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { listLegalSourceState } from "@/lib/legal-source-service";
import { listPublicLegalRssSources } from "@/lib/rss-catalog";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function reply(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return reply(requestId, { ok: false, error: "unauthorized" }, 401);

  try {
    const state = await listLegalSourceState(getPool(), user.id);
    const hasConnectableProvider = state.providers.some((provider) =>
      (provider.kind === "official_api" || provider.kind === "licensed_integration")
      && provider.capabilities.includes("connect"),
    );
    return reply(requestId, {
      ok: true,
      category: "Юридические источники",
      publicSources: listPublicLegalRssSources(),
      paidIntegrationsStatus: hasConnectableProvider ? "available" : "not_configured",
      ...state,
    });
  } catch (error) {
    console.error("[/api/legal-sources] GET", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
      code: typeof (error as { code?: unknown })?.code === "string"
        ? String((error as { code: string }).code).slice(0, 80)
        : "unavailable",
    });
    return reply(requestId, { ok: false, error: "unavailable" }, 503);
  }
}
