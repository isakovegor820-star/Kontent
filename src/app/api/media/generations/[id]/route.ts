import { NextRequest, NextResponse } from "next/server";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";

export const runtime = "nodejs";

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { id } = await ctx.params;
  const generationId = Number(id);
  if (!Number.isInteger(generationId) || generationId <= 0) {
    return NextResponse.json({ error: "bad_id" }, { status: 400 });
  }

  try {
    const row = (
      await getPool().query<{
        id: number;
        kind: "image" | "video";
        status: string;
        prompt: string;
        model: string;
        aspect_ratio: string;
        quality: string | null;
        seconds: number | null;
        style: string;
        output_asset_id: number | null;
        mime_type: string | null;
        bytes: number | null;
        error_code: string | null;
        error_message: string | null;
        created_at: Date;
        updated_at: Date;
        completed_at: Date | null;
      }>(
        `select g.id, g.kind, g.status, g.prompt, g.model, g.aspect_ratio, g.quality,
                g.seconds, g.style, g.output_asset_id, g.error_code, g.error_message,
                g.created_at, g.updated_at, g.completed_at, a.mime_type, a.bytes
           from media_generations g
           left join media_assets a on a.id = g.output_asset_id
          where g.id = $1 and g.user_id = $2`,
        [generationId, user.id],
      )
    ).rows[0];
    if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const assetId = row.output_asset_id ? String(row.output_asset_id) : null;
    return NextResponse.json({
      generation: {
        id: String(row.id),
        kind: row.kind,
        status: row.status,
        prompt: row.prompt,
        model: row.model,
        aspectRatio: row.aspect_ratio,
        quality: row.quality,
        seconds: row.seconds,
        style: row.style,
        assetId,
        assetUrl: assetId ? `/api/media/assets/${assetId}` : null,
        downloadUrl: assetId ? `/api/media/assets/${assetId}?download=1` : null,
        mimeType: row.mime_type,
        bytes: row.bytes,
        errorCode: row.error_code,
        errorMessage: row.error_message,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        completedAt: row.completed_at?.toISOString() ?? null,
      },
    });
  } catch (error) {
    console.error("[/api/media/generations/:id]", error);
    return NextResponse.json({ error: "server" }, { status: 500 });
  }
}

