import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { readJsonBodyLimited } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import {
  PRODUCT_EVENT_BATCH_LIMIT,
  PRODUCT_EVENT_BODY_LIMIT_BYTES,
  maybePruneExpiredProductEvents,
  persistAuroraProductEvents,
} from "@/lib/product-events";
import { validateAuroraProductEventDraft } from "@/lib/product-event-contract.mjs";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

function validEnvelope(value: unknown): value is { events: unknown[] } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1
    && Array.isArray(record.events)
    && record.events.length > 0
    && record.events.length <= PRODUCT_EVENT_BATCH_LIMIT;
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req, { requireBrowserOrigin: true })) {
    return response(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  const rate = await checkRateLimit(`product-events:${user.id}`, 240, 3_600, { failureMode: "closed" });
  if (!rate.allowed) {
    const limited = rateLimitResponse(rate);
    limited.headers.set("cache-control", "no-store");
    limited.headers.set("x-request-id", requestId);
    return limited;
  }

  const bodyResult = await readJsonBodyLimited(req, PRODUCT_EVENT_BODY_LIMIT_BYTES);
  if (!bodyResult.ok) return response(requestId, { ok: false, error: bodyResult.error }, bodyResult.status);
  if (!validEnvelope(bodyResult.value)) {
    return response(requestId, { ok: false, error: "product_event_batch_invalid" }, 400);
  }

  const nowMs = Date.now();
  const events = [];
  for (const draft of bodyResult.value.events) {
    const validated = validateAuroraProductEventDraft(draft, { nowMs });
    if (!validated.ok) {
      return response(requestId, {
        ok: false,
        error: validated.error,
        ...(validated.field ? { field: validated.field } : {}),
      }, 400);
    }
    events.push(validated.event);
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const result = await persistAuroraProductEvents({
      pool,
      actorUserId: user.id,
      projectId: membership.projectId,
      events,
      fallbackRequestId: requestId,
    });
    await maybePruneExpiredProductEvents(pool).catch((error) => {
      console.error("[product-events-retention]", {
        errorName: error instanceof Error ? error.name : "Error",
        code: "product_event_retention_unavailable",
      });
    });
    return response(requestId, { ok: true, ...result });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return response(requestId, { ok: false, error: "project_access_denied" }, 403);
    }
    console.error("[/api/product-events]", {
      errorName: error instanceof Error ? error.name : "Error",
      code: "product_event_store_unavailable",
    });
    return response(requestId, { ok: false, error: "product_event_store_unavailable" }, 503);
  }
}
