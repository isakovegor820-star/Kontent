import { createHash, randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { BoundedBodyError, readRequestBodyLimited } from "@/lib/bounded-request-body";
import { getPool } from "@/lib/db";
import { ProjectAccessError, requireSelectedProjectPermission } from "@/lib/project-permissions";
import { checkRateLimit, rateLimitResponse } from "@/lib/rate-limit";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";
import { inspectUploadedImage, InvalidUploadedImageError } from "@/lib/uploaded-image";
import { legalStudioJson } from "../../legal-visuals/_shared";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_MULTIPART_BYTES = MAX_IMAGE_BYTES + 256 * 1024;
const MIME_BY_FORMAT = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
} as const;

function present(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    kind: String(row.kind),
    fileName: String(row.file_name),
    mimeType: String(row.mime_type),
    bytes: Number(row.bytes),
    sha256: String(row.sha256),
    origin: String(row.origin),
    width: row.width_px == null ? null : Number(row.width_px),
    height: row.height_px == null ? null : Number(row.height_px),
    metadata: row.metadata ?? {},
    url: `/api/media/assets/${row.id}`,
    createdAt: new Date(row.created_at as string | number | Date).toISOString(),
  };
}

function safeName(name: string, extension: string) {
  const base = name.normalize("NFC").replace(/\.[^.]+$/u, "").replace(/[^\p{L}\p{N}._-]+/gu, "-").slice(0, 100) || "image";
  return `${base}.${extension}`;
}

function accessError(error: unknown, requestId: string) {
  if (error instanceof ProjectAccessError) return legalStudioJson({ ok: false, error: "access_denied" }, 403, requestId);
  console.error("[media-assets-api] request failed", { requestId, errorName: error instanceof Error ? error.name : "Error" });
  return legalStudioJson({ ok: false, error: "server" }, 500, requestId);
}

export async function GET(request: NextRequest) {
  const requestId = randomUUID();
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    const rows = (await pool.query<Record<string, unknown>>(
      `select id, kind, file_name, mime_type, bytes, sha256, origin,
              width_px, height_px, metadata, created_at
         from media_assets
        where project_id = $1 and kind = 'image'
        order by created_at desc, id desc limit 100`,
      [membership.projectId],
    )).rows;
    return legalStudioJson({ ok: true, assets: rows.map(present) }, 200, requestId);
  } catch (error) {
    return accessError(error, requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(request)) return legalStudioJson({ ok: false, error: "forbidden_origin" }, 403, requestId);
  const user = await getSessionUser(request);
  if (!user) return legalStudioJson({ ok: false, error: "unauthorized" }, 401, requestId);
  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "content.create");
    const [userRate, projectRate] = await Promise.all([
      checkRateLimit(`media-assets:upload:user:${user.id}`, 30, 3_600, { failureMode: "closed" }),
      checkRateLimit(`media-assets:upload:project:${membership.projectId}`, 120, 3_600, { failureMode: "closed" }),
    ]);
    if (!userRate.allowed) return rateLimitResponse(userRate);
    if (!projectRate.allowed) return rateLimitResponse(projectRate);

    const contentType = request.headers.get("content-type") || "";
    if (!/^multipart\/form-data;.*boundary=/iu.test(contentType)) {
      return legalStudioJson({ ok: false, error: "bad_multipart" }, 422, requestId);
    }
    const contentLength = Number(request.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
      return legalStudioJson({ ok: false, error: "payload_too_large" }, 413, requestId);
    }
    const body = await readRequestBodyLimited(request.body, MAX_MULTIPART_BYTES);
    const form = await new Response(body.buffer as ArrayBuffer, {
      headers: { "content-type": contentType },
    }).formData();
    const file = form.get("file");
    const alt = String(form.get("alt") || "").normalize("NFC").trim().slice(0, 240);
    if (!(file instanceof File) || file.size < 1 || file.size > MAX_IMAGE_BYTES) {
      return legalStudioJson({ ok: false, error: "invalid_image" }, 422, requestId);
    }
    const buffer = Buffer.from(await file.arrayBuffer());
    const info = await inspectUploadedImage(buffer);
    const format = info?.format as keyof typeof MIME_BY_FORMAT;
    const mimeType = MIME_BY_FORMAT[format];
    if (!info || !mimeType) {
      return legalStudioJson({ ok: false, error: "invalid_image" }, 422, requestId);
    }
    const sha256 = createHash("sha256").update(buffer).digest("hex");
    const existing = (await pool.query<Record<string, unknown>>(
      `select id, kind, file_name, mime_type, bytes, sha256, origin,
              width_px, height_px, metadata, created_at
         from media_assets
        where project_id = $1 and kind = 'image' and sha256 = $2 and mime_type = $3
        order by id limit 1`,
      [membership.projectId, sha256, mimeType],
    )).rows[0];
    if (existing) return legalStudioJson({ ok: true, asset: present(existing), duplicate: true }, 200, requestId);
    const inserted = (await pool.query<Record<string, unknown>>(
      `insert into media_assets (
         user_id, project_id, kind, file_name, mime_type, bytes, data, storage_backend,
         sha256, origin, width_px, height_px, metadata
       ) values ($1,$2,'image',$3,$4,$5,$6,'postgres',$7,'upload',$8,$9,$10::jsonb)
       returning id, kind, file_name, mime_type, bytes, sha256, origin,
                 width_px, height_px, metadata, created_at`,
      [user.id, membership.projectId, safeName(file.name, format === "jpeg" ? "jpg" : format),
        mimeType, buffer.byteLength, buffer, sha256, info.width, info.height,
        JSON.stringify({ alt })],
    )).rows[0];
    return legalStudioJson({ ok: true, asset: present(inserted), duplicate: false }, 201, requestId);
  } catch (error) {
    if (error instanceof ProjectAccessError) return accessError(error, requestId);
    if (error instanceof BoundedBodyError) {
      return legalStudioJson(
        { ok: false, error: error.code === "too_large" ? "payload_too_large" : "bad_multipart" },
        error.code === "too_large" ? 413 : 422,
        requestId,
      );
    }
    if (error instanceof InvalidUploadedImageError) {
      return legalStudioJson({ ok: false, error: "invalid_image" }, 422, requestId);
    }
    return accessError(error, requestId);
  }
}
