import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { MonthlyCampaignServiceError } from "@/lib/monthly-campaign-service";
import { ProjectAccessError } from "@/lib/project-permissions";

export function monthlyCampaignJson(
  body: Record<string, unknown>,
  status = 200,
  requestId: string = randomUUID(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export function monthlyCampaignRequestId(): string {
  return randomUUID();
}

export type MonthlyCampaignBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "bad_request" | "unsupported_media_type" | "body_too_large"; status: 400 | 413 | 415 };

export async function readMonthlyCampaignBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<MonthlyCampaignBodyResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "unsupported_media_type", status: 415 };
  }
  try {
    const bytes = await readRequestBodyLimited(request.body, 32 * 1024);
    const body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { ok: false, error: "bad_request", status: 400 };
    }
    const record = body as Record<string, unknown>;
    const allowed = new Set(allowedKeys);
    return Object.keys(record).every((key) => allowed.has(key))
      ? { ok: true, body: record }
      : { ok: false, error: "bad_request", status: 400 };
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "too_large") {
      return { ok: false, error: "body_too_large", status: 413 };
    }
    return { ok: false, error: "bad_request", status: 400 };
  }
}

export function monthlyCampaignRouteId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function monthlyCampaignApiError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    return monthlyCampaignJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof MonthlyCampaignServiceError) {
    const status: Record<MonthlyCampaignServiceError["code"], number> = {
      invalid_brief: 422,
      invalid_timezone: 422,
      timezone_mismatch: 422,
      invalid_period: 422,
      invalid_rubrics: 422,
      invalid_practice_mix: 422,
      invalid_audience: 422,
      invalid_funnel_stage: 422,
      invalid_frequency: 422,
      invalid_important_date: 422,
      invalid_cta: 422,
      invalid_metric: 422,
      invalid_version: 400,
      invalid_idempotency_key: 400,
      idempotency_conflict: 409,
      not_found: 404,
      version_conflict: 409,
      stale_campaign: 409,
      rebuild_required: 409,
      invalid_items: 422,
      invalid_item: 422,
      duplicate_topics: 409,
      invalid_transition: 409,
      invalid_move: 422,
      regeneration_in_progress: 409,
      invalid_regeneration_scope: 422,
      no_regeneration_targets: 422,
      lineage_conflict: 409,
      invalid_channel: 422,
      archived: 409,
    };
    return monthlyCampaignJson({ ok: false, error: error.code }, status[error.code], requestId);
  }
  console.error("[monthly-campaign-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return monthlyCampaignJson({ ok: false, error: "server" }, 500, requestId);
}
