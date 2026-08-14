import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { AudienceQuestionError } from "@/lib/audience-questions";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";

const BODY_LIMIT = 32 * 1024;

export function audienceQuestionJson(
  body: Record<string, unknown>,
  status = 200,
  requestId: string = randomUUID(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function audienceQuestionBody(
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

export function audienceQuestionBodyFailure(error: string, requestId: string) {
  const status = error === "unsupported_media_type" ? 415
    : error === "payload_too_large" ? 413
      : 400;
  return audienceQuestionJson({ ok: false, error }, status, requestId);
}

export function audienceQuestionRouteId(value: string) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function audienceQuestionApiError(error: unknown, requestId = randomUUID()) {
  if (error instanceof ProjectAccessError) {
    return audienceQuestionJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof AudienceQuestionError) {
    const status = error.code === "not_found" || error.code === "draft_not_found" ? 404
      : error.code === "version_conflict" || error.code === "invalid_status" ? 409
        : 422;
    return audienceQuestionJson({ ok: false, error: error.code }, status, requestId);
  }
  console.error("[audience-questions-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return audienceQuestionJson({ ok: false, error: "server" }, 500, requestId);
}
