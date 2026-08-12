import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { ProjectAccessError } from "@/lib/project-permissions";
import { PublicationSettingsError } from "@/lib/publication-settings-service";

const MAX_PUBLICATION_SETTINGS_BODY_BYTES = 16 * 1024;

export function publicationSettingsJson(
  body: Record<string, unknown>,
  status = 200,
  requestId: string = randomUUID(),
) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function readPublicationSettingsBody(
  req: Request,
  allowedKeys: readonly string[],
) {
  const mediaType = req.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  if (mediaType !== "application/json") return null;
  try {
    const bytes = await readRequestBodyLimited(req.body, MAX_PUBLICATION_SETTINGS_BODY_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const body = value as Record<string, unknown>;
    const allowed = new Set(allowedKeys);
    return Object.keys(body).every((key) => allowed.has(key)) ? body : null;
  } catch (error) {
    if (error instanceof BoundedBodyError || error instanceof SyntaxError || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

export function publicationSettingsApiError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) {
    return publicationSettingsJson({ ok: false, error: "access_denied" }, 403, requestId);
  }
  if (error instanceof PublicationSettingsError) {
    const status: Record<PublicationSettingsError["code"], number> = {
      invalid_block_kind: 422,
      invalid_name: 422,
      invalid_body: 422,
      invalid_block_id: 400,
      invalid_block_selection: 422,
      multiple_first_comments: 422,
      invalid_fallback: 422,
      invalid_comments_mode: 422,
      invalid_review: 422,
      responsible_member_required: 422,
      draft_not_found: 404,
      block_not_found: 404,
      version_conflict: 409,
    };
    return publicationSettingsJson({ ok: false, error: error.code }, status[error.code], requestId);
  }
  console.error("[publication-settings-api] request failed", {
    requestId,
    errorName: error instanceof Error ? error.name : "Error",
  });
  return publicationSettingsJson({ ok: false, error: "server" }, 500, requestId);
}
