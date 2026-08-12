import { randomUUID } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  const user = await getSessionUser(req);
  if (!user) {
    return NextResponse.json(
      { error: "unauthorized", requestId },
      { status: 401, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
  const { id } = await ctx.params;
  const assetId = Number(id);
  if (!Number.isSafeInteger(assetId) || assetId <= 0) {
    return NextResponse.json(
      { error: "bad_id", requestId },
      { status: 400, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
  const asset = (
    await getPool().query<{
      mime_type: string;
      file_name: string;
      sha256: string;
      data: Buffer;
    }>(
      `select asset.mime_type, asset.file_name, asset.sha256, asset.data
         from user_avatar_assets asset
        where asset.id = $1 and asset.user_id = $2
        limit 1`,
      [assetId, user.id],
    )
  ).rows[0];
  if (!asset) {
    return NextResponse.json(
      { error: "not_found", requestId },
      { status: 404, headers: { "cache-control": "no-store", "x-request-id": requestId } },
    );
  }
  const etag = `"${asset.sha256}"`;
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, {
      status: 304,
      headers: { etag, "cache-control": "private, max-age=3600", "x-request-id": requestId },
    });
  }
  return new Response(new Uint8Array(asset.data), {
    status: 200,
    headers: {
      "content-type": asset.mime_type,
      "content-length": String(asset.data.byteLength),
      "content-disposition": `inline; filename="${asset.file_name.replace(/[^a-z0-9_.-]/giu, "-")}"`,
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "x-request-id": requestId,
      etag,
    },
  });
}
