import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import {
  PROFILE_AVATAR_UPLOAD_MAX_BYTES,
  ProfileAvatarError,
  prepareProfileAvatar,
} from "@/lib/profile-avatar";
import { hasTrustedMutationOrigin } from "@/lib/request-origin";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

const MAX_MULTIPART_BYTES = PROFILE_AVATAR_UPLOAD_MAX_BYTES + 512 * 1024;

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  if (!hasTrustedMutationOrigin(req)) {
    return response(requestId, { ok: false, error: "forbidden_origin" }, 403);
  }
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { ok: false, error: "unauthorized" }, 401);

  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_MULTIPART_BYTES) {
    return response(requestId, { ok: false, error: "too_large" }, 413);
  }

  try {
    const form = await req.formData();
    const avatar = form.get("avatar");
    if (!(avatar instanceof File)) {
      return response(requestId, { ok: false, error: "missing_file" }, 422);
    }
    const prepared = await prepareProfileAvatar(await avatar.arrayBuffer(), avatar.type);
    const pool = getPool();
    const existing = (
      await pool.query<{ id: string }>(
        `select id from media_assets
          where user_id = $1 and kind = 'image' and sha256 = $2 and mime_type = $3
          order by id limit 1`,
        [user.id, prepared.sha256, prepared.mimeType],
      )
    ).rows[0];
    const assetId = existing
      ? Number(existing.id)
      : Number((
          await pool.query<{ id: string }>(
            `insert into media_assets
               (user_id, kind, file_name, mime_type, bytes, data, sha256)
             values ($1, 'image', $2, $3, $4, $5, $6)
             returning id`,
            [
              user.id,
              prepared.fileName,
              prepared.mimeType,
              prepared.data.byteLength,
              prepared.data,
              prepared.sha256,
            ],
          )
        ).rows[0]?.id);
    if (!Number.isSafeInteger(assetId) || assetId <= 0) throw new Error("avatar_asset_missing");

    return response(requestId, {
      ok: true,
      avatar: `/api/media/assets/${assetId}`,
      mimeType: prepared.mimeType,
      bytes: prepared.data.byteLength,
    });
  } catch (error) {
    if (error instanceof ProfileAvatarError) {
      const status = error.code === "too_large" ? 413 : 422;
      return response(requestId, { ok: false, error: error.code }, status);
    }
    console.error("[/api/settings/profile/avatar]", {
      requestId,
      errorName: error instanceof Error ? error.name : "Error",
    });
    return response(requestId, { ok: false, error: "unavailable" }, 503);
  }
}
