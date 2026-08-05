import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";
const SAFE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "video/mp4"]);

function assetJson(requestId: string, body: Record<string, unknown>, status: number) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return assetJson(requestId, { error: "unauthorized" }, 401);
  const { id } = await ctx.params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return assetJson(requestId, { error: "bad_id" }, 400);
  }

  try {
    const asset = (
      await getPool().query<{
        data: Buffer;
        mime_type: string;
        file_name: string;
        sha256: string;
      }>(
        `select data, mime_type, file_name, sha256 from media_assets where id = $1 and user_id = $2`,
        [assetId, user.id],
      )
    ).rows[0];
    if (!asset) return assetJson(requestId, { error: "not_found" }, 404);
    if (!SAFE_MEDIA_TYPES.has(asset.mime_type)) {
      throw new Error("unsafe_stored_media_type");
    }

    const download = req.nextUrl.searchParams.get("download") === "1";
    const disposition = `${download ? "attachment" : "inline"}; filename="${asset.file_name.replace(/[^a-z0-9_.-]/gi, "-")}"`;
    return new Response(new Uint8Array(asset.data), {
      headers: {
        "content-type": asset.mime_type,
        "content-length": String(asset.data.byteLength),
        "content-disposition": disposition,
        "cache-control": "private, max-age=3600",
        etag: `"${asset.sha256}"`,
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    console.error("[media-api]", {
      event: "asset_read_failed",
      requestId,
      assetId,
      code: "server",
      errorName: error instanceof Error ? error.name : "Error",
    });
    return assetJson(requestId, { error: "server" }, 500);
  }
}
