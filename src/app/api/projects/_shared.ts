import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

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

export async function readObjectBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    return objectBody(await req.json());
  } catch {
    return null;
  }
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
