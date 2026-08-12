import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

import { loadMediaAssetBuffer } from "./media-storage.mjs";
import { createTenChatExportPackage } from "./tenchat-adapter.mjs";

type Queryable = Pick<PoolClient, "query">;

export type TenChatExportRequest = {
  text?: unknown;
  scheduledAt?: unknown;
  assetIds?: unknown;
  draftId?: unknown;
  draftVersion?: unknown;
};

type LoadedAsset = {
  file_name?: unknown;
  mime_type?: unknown;
  data?: unknown;
};

type AssetLoader = (input: {
  pool: Queryable;
  assetId: number;
  projectId: number;
  maxBytes: number;
}) => Promise<LoadedAsset | null>;

const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const MAX_PACKAGE_ASSET_BYTES = 50 * 1024 * 1024;
const TENCHAT_EXPORT_KEYS = new Set(["text", "scheduledAt", "assetIds", "draftId", "draftVersion"]);

export class TenChatExportServiceError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 422) {
    super(code);
    this.name = "TenChatExportServiceError";
    this.code = code;
    this.status = status;
  }
}

function positiveAssetIds(value: unknown): number[] {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > 10) {
    throw new TenChatExportServiceError("tenchat_asset_count_invalid");
  }
  const ids = value.map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0) || new Set(ids).size !== ids.length) {
    throw new TenChatExportServiceError("tenchat_asset_ids_invalid");
  }
  return ids;
}

function normalizedText(value: unknown): string {
  if (typeof value !== "string") throw new TenChatExportServiceError("tenchat_text_invalid");
  const text = value.replace(/\u0000/gu, "").trim();
  if (!text || text.length > 30_000) throw new TenChatExportServiceError("tenchat_text_invalid");
  return text;
}

function normalizedScheduledAt(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (typeof value !== "string") throw new TenChatExportServiceError("tenchat_scheduled_at_invalid");
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TenChatExportServiceError("tenchat_scheduled_at_invalid");
  return date.toISOString();
}

function positiveId(value: unknown, code: string): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new TenChatExportServiceError(code, 422);
  return id;
}

function packageError(error: unknown): never {
  const code = error instanceof Error ? error.message : "tenchat_export_failed";
  if (code.startsWith("tenchat_")) throw new TenChatExportServiceError(code);
  throw error;
}

export async function createTenChatExportForProject({
  pool,
  projectId,
  actorUserId,
  requestId,
  body,
  exportedAt = new Date(),
  loadAsset = loadMediaAssetBuffer as AssetLoader,
}: {
  pool: Queryable;
  projectId: number;
  actorUserId: number;
  requestId?: string | null;
  body: TenChatExportRequest;
  exportedAt?: Date;
  loadAsset?: AssetLoader;
}) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new TenChatExportServiceError("tenchat_export_request_invalid", 400);
  }
  if (Object.keys(body).some((key) => !TENCHAT_EXPORT_KEYS.has(key))) {
    throw new TenChatExportServiceError("tenchat_export_request_invalid", 400);
  }
  const text = normalizedText(body.text);
  const scheduledAt = normalizedScheduledAt(body.scheduledAt);
  const assetIds = positiveAssetIds(body.assetIds);
  const draftId = positiveId(body.draftId, "tenchat_draft_invalid");
  const draftVersion = positiveId(body.draftVersion, "tenchat_draft_revision_invalid");

  const revision = (await pool.query<{
    id: number | string;
    content_hash: string;
  }>(
    `select revision.id, revision.content_hash
       from draft_revisions revision
      where revision.project_id = $1
        and revision.draft_id = $2
        and revision.draft_version = $3
      limit 1`,
    [projectId, draftId, draftVersion],
  )).rows[0];
  if (!revision) throw new TenChatExportServiceError("tenchat_draft_revision_not_found", 409);

  const project = (await pool.query<{ name: string }>(
    "select name from projects where id = $1 and is_archived = false limit 1",
    [projectId],
  )).rows[0];
  if (!project?.name) throw new TenChatExportServiceError("project_not_found", 404);

  const assets = [];
  let totalBytes = 0;
  for (const assetId of assetIds) {
    const asset = await loadAsset({ pool, assetId, projectId, maxBytes: MAX_ASSET_BYTES });
    if (!asset?.data) throw new TenChatExportServiceError("tenchat_asset_not_found", 404);
    const data = Buffer.isBuffer(asset.data) ? asset.data : Buffer.from(asset.data as ArrayBuffer);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_PACKAGE_ASSET_BYTES) {
      throw new TenChatExportServiceError("tenchat_package_too_large", 413);
    }
    assets.push({
      fileName: String(asset.file_name || `media-${assetId}`),
      mimeType: String(asset.mime_type || ""),
      sha256: createHash("sha256").update(data).digest("hex"),
      data,
    });
  }

  try {
    const result = createTenChatExportPackage({
      projectName: project.name,
      text,
      scheduledAt,
      exportedAt: exportedAt.toISOString(),
      assets,
    });
    await pool.query(
      `insert into audit_events
         (project_id, actor_user_id, action, entity_type, entity_id,
          after_version, safe_data, request_id)
       values ($1, $2, 'tenchat.export.created', 'draft_revision', $3, $4, $5::jsonb, $6)`,
      [
        projectId,
        actorUserId,
        String(revision.id),
        draftVersion,
        JSON.stringify({
          draftId,
          draftVersion,
          contentHash: revision.content_hash,
          exportedTextSha256: createHash("sha256").update(text, "utf8").digest("hex"),
          packageSha256: result.sha256,
          assetCount: assets.length,
          mode: "export_only",
        }),
        requestId ?? null,
      ],
    );
    return result;
  } catch (error) {
    return packageError(error);
  }
}
