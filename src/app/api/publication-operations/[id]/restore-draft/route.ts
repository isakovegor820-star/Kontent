import { NextRequest, NextResponse } from "next/server";

import {
  authorizePublicationOperation,
  PublicationOperationNotFoundError,
} from "@/app/api/publication-operations/_project-authorization";
import { getPool } from "@/lib/db";
import { ProjectAccessError } from "@/lib/project-permissions";
import { normalizeIdempotencyKey } from "@/lib/publication-idempotency";
import { restorePublicationDraft } from "@/lib/publication-lifecycle.mjs";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

type RestoreDraftRouteContext = { params: Promise<{ id: string }> };

export async function POST(
  req: NextRequest,
  ctx: RestoreDraftRouteContext,
) {
  if (!hasTrustedMutationOrigin(req)) {
    return NextResponse.json({ ok: false, error: "forbidden_origin" }, { status: 403 });
  }
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  const operationId = Number((await ctx.params).id);
  if (!Number.isSafeInteger(operationId) || operationId <= 0) {
    return NextResponse.json({ ok: false, error: "bad_operation" }, { status: 422 });
  }
  const idempotencyKey = normalizeIdempotencyKey(req.headers.get("idempotency-key"));
  if (!idempotencyKey) {
    return NextResponse.json({ ok: false, error: "idempotency_key_required" }, { status: 400 });
  }
  const body = (await req.json().catch(() => null)) as {
    expectedScheduleRevision?: unknown;
    expectedStatus?: unknown;
  } | null;
  const expectedStatus = typeof body?.expectedStatus === "string" ? body.expectedStatus : "";
  if (!expectedStatus) {
    return NextResponse.json({ ok: false, error: "expected_status_required" }, { status: 422 });
  }
  const pool = getPool();
  try {
    const { projectId } = await authorizePublicationOperation({
      db: pool,
      userId: user.id,
      operationId,
      permission: "content.publish",
      requireCreator: false,
    });
    const result = await restorePublicationDraft({
      pool,
      userId: user.id,
      projectId,
      operationId,
      expectedRevision: Number(body?.expectedScheduleRevision),
      expectedStatus,
      idempotencyKey,
      requestId: req.headers.get("x-request-id"),
    });
    if (result.ok && !result.replayed) {
      console.info("[publication_event]", {
        event: "publication_draft_restored",
        operationId,
        revision: result.scheduleRevision,
        status: result.status,
      });
    }
    return NextResponse.json(result, { status: result.ok ? 200 : (result.httpStatus ?? 500) });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return NextResponse.json({ ok: false, error: "forbidden" }, { status: 403 });
    }
    if (error instanceof PublicationOperationNotFoundError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 404 });
    }
    console.error("[/api/publication-operations/:id/restore-draft]", {
      code: error && typeof error === "object" && "code" in error ? String(error.code) : "unknown",
    });
    return NextResponse.json({ ok: false, error: "draft_not_restored" }, { status: 500 });
  }
}
