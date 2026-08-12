import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { LegalVideoScriptServiceError } from "@/lib/legal-video-script-service";
import { LegalVisualServiceError } from "@/lib/legal-visual-service";
import { ProjectAccessError } from "@/lib/project-permissions";

export function legalStudioJson(body: Record<string, unknown>, status = 200, requestId: string = randomUUID()) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export const LEGAL_STUDIO_JSON_BODY_MAX_BYTES = 128 * 1024;

export type LegalStudioBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "bad_request" | "payload_too_large" | "unsupported_media_type" };

export async function legalStudioBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<LegalStudioBodyResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "unsupported_media_type" };
  }
  try {
    const bytes = await readRequestBodyLimited(request.body, LEGAL_STUDIO_JSON_BODY_MAX_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "bad_request" };
    }
    const body = value as Record<string, unknown>;
    const allowed = new Set(allowedKeys);
    return Object.keys(body).every((key) => allowed.has(key))
      ? { ok: true, body }
      : { ok: false, error: "bad_request" };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof BoundedBodyError && error.code === "too_large"
        ? "payload_too_large"
        : "bad_request",
    };
  }
}

export function legalStudioBodyFailure(
  result: Exclude<LegalStudioBodyResult, { ok: true }>,
  requestId: string,
) {
  const status = result.error === "unsupported_media_type" ? 415
    : result.error === "payload_too_large" ? 413
      : 400;
  return legalStudioJson({ ok: false, error: result.error }, status, requestId);
}

export function positiveRouteId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function legalStudioError(error: unknown, requestId: string = randomUUID()) {
  if (error instanceof ProjectAccessError) {
    return legalStudioJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof LegalVisualServiceError) {
    const statuses: Record<LegalVisualServiceError["code"], number> = {
      invalid_request: 400,
      invalid_config: 422,
      invalid_brand_kit: 422,
      invalid_idempotency_key: 400,
      asset_not_found: 404,
      asset_mismatch: 422,
      draft_not_found: 404,
      approval_required: 409,
      not_found: 404,
      version_conflict: 409,
      idempotency_conflict: 409,
      unsafe_layout: 422,
    };
    return legalStudioJson(
      { ok: false, error: error.code, ...(error.code === "unsafe_layout" ? { issues: error.details } : {}) },
      statuses[error.code],
      requestId,
    );
  }
  if (error instanceof LegalVideoScriptServiceError) {
    const statuses: Record<LegalVideoScriptServiceError["code"], number> = {
      invalid_request: 400,
      invalid_idempotency_key: 400,
      draft_not_found: 404,
      approval_required: 409,
      empty_draft: 422,
      not_found: 404,
      version_conflict: 409,
      idempotency_conflict: 409,
      invalid_script: 422,
    };
    return legalStudioJson({ ok: false, error: error.code }, statuses[error.code], requestId);
  }
  console.error("[legal-studio-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return legalStudioJson({ ok: false, error: "server" }, 500, requestId);
}
