import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";
import { TrackingServiceError } from "@/lib/tracking-service";

export const TRACKING_JSON_BODY_MAX_BYTES = 16 * 1024;

type TrackingBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "bad_request" | "payload_too_large" | "unsupported_media_type" };

export function trackingJson(body: Record<string, unknown>, status = 200, requestId: string = randomUUID()) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function readTrackingBodyResult(
  req: Request,
  allowedKeys?: readonly string[],
): Promise<TrackingBodyResult> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "unsupported_media_type" };
  }
  try {
    const bytes = await readRequestBodyLimited(req.body, TRACKING_JSON_BODY_MAX_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "bad_request" };
    }
    const body = value as Record<string, unknown>;
    if (allowedKeys) {
      const allowed = new Set(allowedKeys);
      if (Object.keys(body).some((key) => !allowed.has(key))) {
        return { ok: false, error: "bad_request" };
      }
    }
    return { ok: true, body };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BoundedBodyError && error.code === "too_large"
        ? "payload_too_large"
        : "bad_request",
    };
  }
}

export function trackingBodyFailure(
  result: Exclude<TrackingBodyResult, { ok: true }>,
  requestId: string,
) {
  const status = result.error === "unsupported_media_type" ? 415
    : result.error === "payload_too_large" ? 413
      : 400;
  return trackingJson({ ok: false, error: result.error }, status, requestId);
}

/** Keeps public keys and client addresses out of Redis key names and observability output. */
export function trackingRateKey(scope: string, ...parts: unknown[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => String(part ?? "")).join("\u0000"), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `tracking:${scope}:${digest}`;
}

export function trackingApiError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    return trackingJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof TrackingServiceError) {
    const status: Record<TrackingServiceError["code"], number> = {
      invalid_name: 422,
      invalid_template: 422,
      invalid_destination: 422,
      invalid_utm: 422,
      invalid_expiry: 422,
      invalid_idempotency_key: 400,
      idempotency_conflict: 409,
      invalid_origin: 422,
      invalid_window: 422,
      invalid_public_key: 400,
      invalid_attribution: 401,
      invalid_event: 422,
      tracker_not_connected: 409,
      verification_unavailable: 422,
      not_found: 404,
      version_conflict: 409,
      link_unavailable: 410,
    };
    return trackingJson({ ok: false, error: error.code }, status[error.code], requestId);
  }
  if (
    error && typeof error === "object" && "code" in error
    && String((error as { code?: unknown }).code) === "23505"
  ) return trackingJson({ ok: false, error: "name_conflict" }, 409, requestId);
  console.error("[tracking-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return trackingJson({ ok: false, error: "server" }, 500, requestId);
}

export function trackerCorsHeaders(origin: string) {
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, idempotency-key, x-aurora-project-key",
    "access-control-max-age": "600",
    "cache-control": "no-store",
    vary: "Origin",
  };
}
