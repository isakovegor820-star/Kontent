import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const DEFAULT_SIGNED_URL_TTL_SECONDS = 300;
const DEFAULT_OBJECT_VIDEO_THRESHOLD = 20 * 1024 * 1024;
let cachedClient = null;
let cachedIdentity = "";

export function mediaObjectConfig(env = process.env) {
  const bucket = String(env.MEDIA_OBJECT_BUCKET || "").trim();
  const region = String(env.MEDIA_OBJECT_REGION || "").trim();
  if (!bucket || !region) return null;
  return {
    bucket,
    region,
    endpoint: String(env.MEDIA_OBJECT_ENDPOINT || "").trim() || undefined,
    forcePathStyle: String(env.MEDIA_OBJECT_FORCE_PATH_STYLE || "").toLowerCase() === "true",
  };
}

function s3(config) {
  const identity = JSON.stringify(config);
  if (!cachedClient || cachedIdentity !== identity) {
    cachedClient = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
    });
    cachedIdentity = identity;
  }
  return cachedClient;
}

export function chooseMediaStorageBackend({ kind, bytes, env = process.env }) {
  if (kind !== "video") return "postgres";
  const threshold = Number(env.MEDIA_OBJECT_VIDEO_THRESHOLD_BYTES || DEFAULT_OBJECT_VIDEO_THRESHOLD);
  if (!Number.isSafeInteger(threshold) || threshold < 1) throw new Error("invalid_media_object_threshold");
  if (bytes < threshold) return "postgres";
  if (!mediaObjectConfig(env)) throw Object.assign(new Error("object_storage_required"), {
    code: "object_storage_required",
  });
  return "object";
}

export async function putMediaObject({ userId, sha256, extension, mimeType, body, env = process.env }) {
  const config = mediaObjectConfig(env);
  if (!config) throw Object.assign(new Error("object_storage_not_configured"), { code: "object_storage_not_configured" });
  const safeExtension = String(extension).replace(/[^a-z0-9]/giu, "").slice(0, 8) || "bin";
  const key = `users/${Number(userId)}/media/${sha256}.${safeExtension}`;
  const response = await s3(config).send(new PutObjectCommand({
    Bucket: config.bucket,
    Key: key,
    Body: body,
    ContentType: mimeType,
    CacheControl: "private, max-age=3600",
    Metadata: { sha256 },
  }));
  return { key, etag: String(response.ETag || "").replaceAll('"', "") || null };
}

export async function signedMediaObjectUrl({ key, fileName, download = false, env = process.env }) {
  const config = mediaObjectConfig(env);
  if (!config) throw Object.assign(new Error("object_storage_not_configured"), { code: "object_storage_not_configured" });
  const safeName = String(fileName).replace(/[^a-z0-9_.-]/giu, "-");
  const disposition = `${download ? "attachment" : "inline"}; filename="${safeName}"`;
  return getSignedUrl(s3(config), new GetObjectCommand({
    Bucket: config.bucket,
    Key: key,
    ResponseContentDisposition: disposition,
  }), { expiresIn: DEFAULT_SIGNED_URL_TTL_SECONDS });
}

export async function deleteMediaObject(key, env = process.env) {
  const config = mediaObjectConfig(env);
  if (!config) throw Object.assign(new Error("object_storage_not_configured"), { code: "object_storage_not_configured" });
  await s3(config).send(new DeleteObjectCommand({ Bucket: config.bucket, Key: key }));
}

export async function loadMediaAssetBuffer({ pool, assetId, userId, maxBytes, env = process.env }) {
  const asset = (await pool.query(
    `select kind, file_name, mime_type, bytes, storage_backend, object_key
       from media_assets where id = $1 and user_id = $2`,
    [assetId, userId],
  )).rows[0];
  if (!asset) return null;
  if (Number(asset.bytes) > maxBytes) throw Object.assign(new Error("media_too_large"), { code: "media_too_large" });
  let data;
  if (asset.storage_backend === "object") {
    const config = mediaObjectConfig(env);
    if (!config || !asset.object_key) {
      throw Object.assign(new Error("object_storage_unavailable"), { code: "object_storage_unavailable" });
    }
    const response = await s3(config).send(new GetObjectCommand({ Bucket: config.bucket, Key: asset.object_key }));
    if (Number(response.ContentLength || 0) > maxBytes || !response.Body) {
      throw Object.assign(new Error("media_too_large"), { code: "media_too_large" });
    }
    data = Buffer.from(await response.Body.transformToByteArray());
  } else {
    data = (await pool.query(
      `select data from media_assets
        where id = $1 and user_id = $2 and storage_backend = 'postgres'`,
      [assetId, userId],
    )).rows[0]?.data;
  }
  if (!data || !data.byteLength || data.byteLength > maxBytes) {
    throw Object.assign(new Error("media_payload_invalid"), { code: "media_payload_invalid" });
  }
  return { ...asset, data: Buffer.from(data) };
}

export async function cleanupMediaObjectOrphans({ pool, limit = 25, env = process.env }) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_orphan_cleanup_limit");
  const client = await pool.connect();
  let deleted = 0;
  let retained = 0;
  let failed = 0;
  try {
    await client.query("begin");
    const rows = (await client.query(
      `select id, object_key, attempts from media_object_orphans
        where deleted_at is null and next_attempt_at <= now()
        order by id for update skip locked limit $1`,
      [limit],
    )).rows;
    for (const row of rows) {
      const referenced = (await client.query(
        "select 1 from media_assets where object_key = $1 limit 1",
        [row.object_key],
      )).rowCount > 0;
      if (referenced) {
        await client.query("update media_object_orphans set deleted_at = now(), last_error_code = 'still_referenced' where id = $1", [row.id]);
        retained += 1;
        continue;
      }
      try {
        await deleteMediaObject(row.object_key, env);
        await client.query("update media_object_orphans set deleted_at = now(), last_error_code = null where id = $1", [row.id]);
        deleted += 1;
      } catch (error) {
        await client.query(
          `update media_object_orphans
              set attempts = attempts + 1,
                  next_attempt_at = now() + make_interval(secs => least(3600, 30 * power(2, least(attempts, 7)))::int),
                  last_error_code = $2
            where id = $1`,
          [row.id, error?.code || "object_delete_failed"],
        );
        failed += 1;
      }
    }
    await client.query("commit");
    return { scanned: rows.length, deleted, retained, failed };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function parseMediaRange(value, bytes) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/u.exec(String(value).trim());
  if (!match || (!match[1] && !match[2]) || bytes <= 0) return { error: "invalid_range" };
  let start;
  let end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { error: "invalid_range" };
    start = Math.max(0, bytes - suffix);
    end = bytes - 1;
  } else {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : bytes - 1;
  }
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)
    || start < 0 || start >= bytes || end < start) return { error: "invalid_range" };
  end = Math.min(end, bytes - 1);
  return { start, end, length: end - start + 1 };
}

export function postgresMediaStream({ pool, assetId, userId, start, end, chunkBytes = 1024 * 1024, onFinish }) {
  let offset = start;
  let finished = false;
  const finish = (outcome) => {
    if (finished) return;
    finished = true;
    onFinish?.(outcome);
  };
  return new ReadableStream({
    async pull(controller) {
      if (offset > end) {
        controller.close();
        finish("completed");
        return;
      }
      const length = Math.min(chunkBytes, end - offset + 1);
      try {
        const row = (await pool.query(
          `select substring(data from $3 for $4) as chunk
             from media_assets
            where id = $1 and user_id = $2 and storage_backend = 'postgres'`,
          [assetId, userId, offset + 1, length],
        )).rows[0];
        if (!row?.chunk?.byteLength) throw new Error("media_chunk_missing");
        controller.enqueue(new Uint8Array(row.chunk));
        offset += row.chunk.byteLength;
      } catch (error) {
        finish("failed");
        controller.error(error);
      }
    },
    cancel() { finish("cancelled"); },
  });
}
