import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { AudienceAssistantError } from "@/lib/audience-assistant";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";

const BODY_LIMIT = 32 * 1024;

export function audienceAssistantJson(
  body: Record<string, unknown>,
  status = 200,
  requestId: string = randomUUID(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function audienceAssistantBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false; error: string }> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") return { ok: false, error: "unsupported_media_type" };
  try {
    const bytes = await readRequestBodyLimited(request.body, BODY_LIMIT);
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

export function audienceAssistantBodyFailure(error: string, requestId: string) {
  const status = error === "unsupported_media_type" ? 415
    : error === "payload_too_large" ? 413
      : 400;
  return audienceAssistantJson({ ok: false, error }, status, requestId);
}

export function audienceAssistantRouteId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function audienceAssistantApiError(error: unknown, requestId = randomUUID()) {
  if (error instanceof ProjectAccessError) {
    return audienceAssistantJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof AudienceAssistantError) {
    const status = error.code === "not_found" ? 404
      : ["version_conflict", "invalid_status", "delivery_in_progress", "delivery_unknown"]
          .includes(error.code) ? 409
        : error.code === "telegram_not_configured" ? 503
          : error.code === "telegram_rejected" ? 502
            : 422;
    return audienceAssistantJson({ ok: false, error: error.code }, status, requestId);
  }
  console.error(`[audience-assistant-api] ${JSON.stringify({
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  })}`);
  return audienceAssistantJson({ ok: false, error: "server" }, 500, requestId);
}
