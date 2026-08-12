import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectMembershipMutationError } from "@/lib/project-context";
import { ProjectAccessError } from "@/lib/project-permissions";
import { ProjectTeamError } from "@/lib/project-team";

export function projectJson(body: Record<string, unknown>, status = 200, requestId: string = randomUUID()) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export function positiveRouteId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function objectBody(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export const PROJECT_JSON_BODY_MAX_BYTES = 16 * 1024;

export type ProjectBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "bad_request" | "payload_too_large" | "unsupported_media_type" };

export async function readProjectBody(
  req: Request,
  allowedKeys: readonly string[],
): Promise<ProjectBodyResult> {
  const contentType = req.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "unsupported_media_type" };
  }
  try {
    const bytes = await readRequestBodyLimited(req.body, PROJECT_JSON_BODY_MAX_BYTES);
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    const body = objectBody(parsed);
    if (!body) return { ok: false, error: "bad_request" };
    const allowed = new Set(allowedKeys);
    if (Object.keys(body).some((key) => !allowed.has(key))) {
      return { ok: false, error: "bad_request" };
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

export function projectBodyFailure(
  result: Exclude<ProjectBodyResult, { ok: true }>,
  requestId: string,
) {
  const status = result.error === "unsupported_media_type" ? 415
    : result.error === "payload_too_large" ? 413
      : 400;
  return projectJson({ ok: false, error: result.error }, status, requestId);
}

export function projectApiError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    if (error.code === "invalid_project_selector") {
      return projectJson({ ok: false, error: "bad_project" }, 400, requestId);
    }
    return projectJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof ProjectMembershipMutationError) {
    if (error.code === "member_not_found") {
      return projectJson({ ok: false, error: "member_not_found" }, 404, requestId);
    }
    if (error.code === "version_conflict") {
      return projectJson({ ok: false, error: "version_conflict" }, 409, requestId);
    }
    return projectJson({ ok: false, error: "last_owner" }, 409, requestId);
  }
  if (error instanceof ProjectTeamError) {
    const status: Record<ProjectTeamError["code"], number> = {
      invalid_name: 422,
      invalid_timezone: 422,
      invalid_email: 422,
      invalid_role: 422,
      invalid_ttl: 422,
      invalid_token: 400,
      invalid_idempotency_key: 400,
      idempotency_conflict: 409,
      invitation_pending: 409,
      invitation_not_found: 404,
      invitation_expired: 410,
      invitation_revoked: 410,
      invitation_used: 409,
      email_mismatch: 403,
      already_member: 409,
    };
    return projectJson({ ok: false, error: error.code }, status[error.code], requestId);
  }
  console.error("[project-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return projectJson({ ok: false, error: "server" }, 500, requestId);
}
