import { randomUUID } from "node:crypto";

import { readJsonBodyValue } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { buildServerLibraryDraftContext, LibraryDraftError } from "@/lib/library-drafts";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { createDraftForUser, DraftValidationError } from "@/lib/server-drafts";
import { getSessionUser } from "@/lib/session";
import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

function reply(body: Record<string, unknown>, status: number, requestId: string) {
  return NextResponse.json({ ...body, requestId }, {
    status,
    headers: { "x-request-id": requestId, "cache-control": "no-store" },
  });
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) return reply({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(req);
  if (!user) return reply({ ok: false, error: "unauthorized" }, 401, requestId);

  const body = await readJsonBodyValue(req).catch(() => null) as {
    itemKey?: unknown; channelId?: unknown; clientKey?: unknown;
  } | null;
  const channelId = Number(body?.channelId);
  const itemKey = String(body?.itemKey || "").trim();
  const clientKey = String(body?.clientKey || "").trim();
  if (!body || !Number.isSafeInteger(channelId) || channelId <= 0 || !itemKey || !clientKey) {
    return reply({ ok: false, error: "bad_request" }, 400, requestId);
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const input = await buildServerLibraryDraftContext({
      db: pool,
      userId: user.id,
      projectId: membership.projectId,
      channelId,
      itemKey,
      clientKey,
    });
    const result = await createDraftForUser(user.id, input, pool);
    return reply({ ok: true, draft: result.draft, created: result.created }, result.created ? 201 : 200, requestId);
  } catch (error) {
    if (error instanceof LibraryDraftError || error instanceof DraftValidationError) {
      console.warn("[/api/library/drafts POST] rejected", { requestId, code: error.code });
      return reply({ ok: false, error: error.code }, 422, requestId);
    }
    if (error instanceof ProjectAccessError) return reply({ ok: false, error: "access_denied" }, 403, requestId);
    console.error("[/api/library/drafts POST]", { requestId, errorName: error instanceof Error ? error.name : "Error" });
    return reply({ ok: false, error: "server" }, 500, requestId);
  }
}
