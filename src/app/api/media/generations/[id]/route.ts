import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";

import { getPool } from "@/lib/db";
import type { MediaGenerationStatus } from "@/lib/media-generation.mjs";
import { reconcileStaleMediaGeneration } from "@/lib/media-generation-reconciliation";
import { getSessionUser } from "@/lib/session";
import {
  ProjectAccessError,
  requireSelectedProjectPermission,
} from "@/lib/project-permissions";

export const runtime = "nodejs";

function response(requestId: string, body: Record<string, unknown>, status = 200) {
  return NextResponse.json(
    { ...body, requestId },
    { status, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let requestId: string = randomUUID();
  const user = await getSessionUser(req);
  if (!user) return response(requestId, { error: "unauthorized" }, 401);
  const { id } = await ctx.params;
  const generationId = Number(id);
  if (!Number.isInteger(generationId) || generationId <= 0) {
    return response(requestId, { error: "bad_id" }, 400);
  }

  try {
    const pool = getPool();
    const membership = await requireSelectedProjectPermission(pool, user.id, "project.read");
    await reconcileStaleMediaGeneration(pool, {
      userId: user.id,
      projectId: membership.projectId,
      generationId,
    });
    const row = (
      await pool.query<{
        id: number;
        request_id: string;
        kind: "image" | "video";
        status: MediaGenerationStatus;
        prompt: string;
        negative_prompt: string | null;
        source_text: string | null;
        exact_text: string | null;
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
        `select g.id, g.request_id, g.kind, g.status, g.prompt, g.negative_prompt,
                coalesce(g.prompt_context->>'sourcePost', '') as source_text,
                coalesce(g.prompt_context->>'exactText', '') as exact_text,
                g.model, g.aspect_ratio, g.quality,
                g.seconds, g.style, g.output_asset_id, g.error_code, g.error_message,
                g.created_at, g.updated_at, g.completed_at, a.mime_type, a.bytes
           from media_generations g
           left join media_assets a
             on a.id = g.output_asset_id and a.project_id = g.project_id
          where g.id = $1 and g.project_id = $2`,
        [generationId, membership.projectId],
      )
    ).rows[0];
    if (!row) return response(requestId, { error: "not_found" }, 404);
    requestId = row.request_id;
    const assetId = row.output_asset_id ? String(row.output_asset_id) : null;
    return response(requestId, {
      generation: {
        id: String(row.id),
        requestId: row.request_id,
        kind: row.kind,
        status: row.status,
        prompt: row.prompt,
        negativePrompt: row.negative_prompt ?? "",
        sourceText: row.source_text ?? "",
        exactText: row.exact_text ?? "",
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
    if (error instanceof ProjectAccessError) {
      return response(requestId, { error: "project_access_denied" }, 403);
    }
    console.error("[media-api]", {
      event: "poll_failed",
      requestId,
      generationId,
      code: "server",
      errorName: error instanceof Error ? error.name : "Error",
    });
    return response(requestId, { error: "server", retryable: true }, 500);
  }
}
