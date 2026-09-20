import { nativeRequestProjectId } from "@/lib/native-project-request";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import { getSessionUser } from "@/lib/session";
import {
  ProjectAccessError,
  requireProjectPermission,
} from "@/lib/project-permissions";
import {
  parseMediaRange,
  postgresMediaStream,
  mediaObjectRangeStream,
  authorizedMediaStream,
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
    const pool = getPool();
    const membership = await requireProjectPermission(pool, user.id, nativeRequestProjectId(req), "project.read");
    const asset = (
      await pool.query<{
        storage_backend: "postgres" | "object";
        object_key: string | null;
        bytes: number;
        mime_type: string;
        file_name: string;
        sha256: string;
      }>(
        `select storage_backend, object_key, bytes, mime_type, file_name, sha256
           from media_assets where id = $1 and project_id = $2`,
        [assetId, membership.projectId],
      )
    ).rows[0];
    if (!asset) return assetJson(requestId, { error: "not_found" }, 404);
    if (!SAFE_MEDIA_TYPES.has(asset.mime_type)) {
      throw new Error("unsafe_stored_media_type");
    }

    const authorize = () => requireProjectPermission(pool, user.id, membership.projectId, "project.read");
    const etag = `"${asset.sha256}"`;
    const download = req.nextUrl.searchParams.get("download") === "1";
    const disposition = `${download ? "attachment" : "inline"}; filename="${asset.file_name.replace(/[^a-z0-9_.-]/gi, "-")}"`;
    const parsedRange = parseMediaRange(req.headers.get("range"), Number(asset.bytes));
    if (parsedRange && "error" in parsedRange) {
      return new Response(null, {
        status: 416,
        headers: { "cache-control": "private, no-store", "content-range": `bytes */${asset.bytes}`, etag, "x-request-id": requestId },
      });
    }
    const range = parsedRange ?? { start: 0, end: Number(asset.bytes) - 1, length: Number(asset.bytes) };
    const startedAt = Date.now();
    if (asset.storage_backend === "object" && !asset.object_key) throw new Error("object_key_missing");
    const source = asset.storage_backend === "object"
      ? await mediaObjectRangeStream({ key: asset.object_key!, start: range.start, end: range.end, signal: req.signal })
      : postgresMediaStream({
      pool,
      assetId,
      projectId: membership.projectId,
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
    try { await authorize(); } catch (error) { await source.cancel(error); throw error; }
    const stream = authorizedMediaStream(source, authorize, { maxBytes: range.length });
    return new Response(stream, {
      status: parsedRange ? 206 : 200,
      headers: {
        "content-type": asset.mime_type,
        "content-length": String(range.length),
        ...(parsedRange ? { "content-range": `bytes ${range.start}-${range.end}/${asset.bytes}` } : {}),
        "accept-ranges": "bytes",
        "content-disposition": disposition,
        "cache-control": "private, no-store",
        etag,
        "x-content-type-options": "nosniff",
        "x-request-id": requestId,
      },
    });
  } catch (error) {
    if (error instanceof ProjectAccessError) {
      return assetJson(requestId, { error: "project_access_denied" }, 403);
    }
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
