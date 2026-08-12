import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BrandDictionaryError } from "@/lib/brand-dictionary-service";
import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";
import { TypographyServiceError } from "@/lib/typography-service";

const MAX_JSON_BODY_BYTES = 128 * 1024;

export function typographyJson(
  body: Record<string, unknown>,
  status = 200,
  requestId: string = randomUUID(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function readTypographyBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<Record<string, unknown> | null> {
  try {
    const bytes = await readRequestBodyLimited(request.body, MAX_JSON_BODY_BYTES);
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

export function typographyApiError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    return typographyJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof BrandDictionaryError) {
    const statuses: Record<BrandDictionaryError["code"], number> = {
      invalid_kind: 422,
      invalid_term: 422,
      invalid_replacement: 422,
      invalid_expansion: 422,
      invalid_entry_id: 400,
      version_conflict: 409,
      entry_not_found: 404,
      duplicate_term: 409,
    };
    return typographyJson({ ok: false, error: error.code }, statuses[error.code], requestId);
  }
  if (error instanceof TypographyServiceError) {
    const statuses: Record<TypographyServiceError["code"], number> = {
      invalid_text: 422,
      invalid_request_key: 400,
      invalid_draft: 404,
      dictionary_version_conflict: 409,
      stale_suggestions: 409,
      selection_conflict: 422,
      request_conflict: 409,
      run_not_found: 404,
      current_text_mismatch: 409,
      nothing_to_undo: 409,
    };
    return typographyJson({ ok: false, error: error.code }, statuses[error.code], requestId);
  }
  console.error("[typography-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return typographyJson({ ok: false, error: "server" }, 500, requestId);
}
