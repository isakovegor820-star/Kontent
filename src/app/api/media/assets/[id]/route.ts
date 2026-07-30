import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const assetId = Number(id);
  if (!Number.isInteger(assetId) || assetId <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
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
    if (!asset) return NextResponse.json({ error: "not_found" }, { status: 404 });

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
      },
    });
  } catch (error) {
    console.error("[/api/media/assets/:id]", error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

