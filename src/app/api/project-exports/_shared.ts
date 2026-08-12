import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";

const MAX_EXPORT_JSON_BODY_BYTES = 32 * 1024;

export type ProjectExportBodyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; error: "invalid_export_request" | "unsupported_media_type" | "body_too_large" };

export async function readProjectExportBody(
  request: Request,
  allowedKeys: readonly string[],
): Promise<ProjectExportBodyResult> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { ok: false, error: "unsupported_media_type" };
  }

  try {
    const bytes = await readRequestBodyLimited(request.body, MAX_EXPORT_JSON_BODY_BYTES);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { ok: false, error: "invalid_export_request" };
    }
    const body = value as Record<string, unknown>;
    const allowed = new Set(allowedKeys);
    if (!Object.keys(body).every((key) => allowed.has(key))) {
      return { ok: false, error: "invalid_export_request" };
    }
    return { ok: true, body };
  } catch (error) {
    if (error instanceof BoundedBodyError && error.code === "too_large") {
      return { ok: false, error: "body_too_large" };
    }
    return { ok: false, error: "invalid_export_request" };
  }
}
