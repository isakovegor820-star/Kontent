import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  parseMediaRange,
  postgresMediaStream,
  signedMediaObjectUrl,
} from "@/lib/media-storage.mjs";

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
        storage_backend: "postgres" | "object";
        object_key: string | null;
        bytes: number;
        mime_type: string;
        file_name: string;
        sha256: string;
      }>(
        `select storage_backend, object_key, bytes, mime_type, file_name, sha256
           from media_assets where id = $1 and user_id = $2`,
        [assetId, user.id],
      )
    ).rows[0];
    if (!asset) return assetJson(requestId, { error: "not_found" }, 404);
    if (!SAFE_MEDIA_TYPES.has(asset.mime_type)) {
      throw new Error("unsafe_stored_media_type");
    }

    const etag = `"${asset.sha256}"`;
    if (req.headers.get("if-none-match") === etag) {
      return new Response(null, {
        status: 304,
        headers: { etag, "cache-control": "private, max-age=3600", "x-request-id": requestId },
      });
    }

    const download = req.nextUrl.searchParams.get("download") === "1";
    const disposition = `${download ? "attachment" : "inline"}; filename="${asset.file_name.replace(/[^a-z0-9_.-]/gi, "-")}"`;
    if (asset.storage_backend === "object") {
      if (!asset.object_key) throw new Error("object_key_missing");
      const location = await signedMediaObjectUrl({ key: asset.object_key, fileName: asset.file_name, download });
      return new Response(null, {
        status: 307,
        headers: {
          location,
          etag,
          "cache-control": "private, no-store",
          "x-request-id": requestId,
        },
      });
    }
    const parsedRange = parseMediaRange(req.headers.get("range"), Number(asset.bytes));
    if (parsedRange && "error" in parsedRange) {
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${asset.bytes}`, etag, "x-request-id": requestId },
      });
    }
    const range = parsedRange ?? { start: 0, end: Number(asset.bytes) - 1, length: Number(asset.bytes) };
    const startedAt = Date.now();
    const stream = postgresMediaStream({
      pool: getPool(),
      assetId,
      userId: user.id,
      start: range.start,
      end: range.end,
      onFinish: (outcome) => console.info("[media_event]", {
        event: outcome === "failed" ? "media_stream_failed" : "media_stream_completed",
        requestId,
        assetId,
        backend: "postgres",
        bytes: range.length,
        outcome,
        latency: Date.now() - startedAt,
      }),
    });
    return new Response(stream, {
      status: parsedRange ? 206 : 200,
      headers: {
        "content-type": asset.mime_type,
        "content-length": String(range.length),
        ...(parsedRange ? { "content-range": `bytes ${range.start}-${range.end}/${asset.bytes}` } : {}),
        "accept-ranges": "bytes",
        "content-disposition": disposition,
        "cache-control": "private, max-age=3600",
        etag,
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
