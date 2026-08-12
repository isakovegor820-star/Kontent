import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import {
  EditorialConflictError,
  EditorialNotFoundError,
  EditorialValidationError,
} from "@/lib/editorial-approval";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";

const MAX_EDITORIAL_BODY_BYTES = 16 * 1024;

export function editorialRequestId(): string {
  return randomUUID();
}

export function editorialJson(
  body: Record<string, unknown>,
  status = 200,
  requestId = editorialRequestId(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "private, no-store", "x-request-id": requestId } },
  );
}

export async function readEditorialBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readRequestBodyLimited(request.body, MAX_EDITORIAL_BODY_BYTES);
    const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    const allowed = new Set(allowedKeys);
    return Object.keys(body).every((key) => allowed.has(key)) ? body : null;
  } catch (error) {
    if (error instanceof BoundedBodyError || error instanceof SyntaxError) return null;
    throw error;
  }
}

export function editorialApiError(error: unknown, requestId: string) {
  if (error instanceof EditorialValidationError) {
    return editorialJson({ ok: false, error: error.code }, 422, requestId);
  }
  if (error instanceof EditorialNotFoundError) {
    return editorialJson({ ok: false, error: "not_found" }, 404, requestId);
  }
  if (error instanceof EditorialConflictError) {
    return editorialJson({ ok: false, error: error.code }, 409, requestId);
  }
  if (error instanceof ProjectAccessError) {
    return editorialJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  console.error("[editorial-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return editorialJson({ ok: false, error: "server" }, 500, requestId);
}
