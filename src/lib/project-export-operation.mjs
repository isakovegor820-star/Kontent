import { createHash } from "node:crypto";

import {
  projectExportFilename,
  projectExportHash,
  renderProjectExport,
} from "./project-export.mjs";

const MAX_POSTGRES_ARTIFACT_BYTES = 32 * 1024 * 1024;
const ARTIFACT_TTL_MS = 24 * 60 * 60 * 1_000;

export class ProjectExportOperationError extends Error {
  constructor(code, { retryable = false } = {}) {
    super(code);
    this.name = "ProjectExportOperationError";
    this.code = code;
    this.retryable = retryable;
  }
}

function validIdentity(operationId, projectId, snapshotHash) {
  return Number.isSafeInteger(operationId) && operationId > 0
    && Number.isSafeInteger(projectId) && projectId > 0
    && /^[0-9a-f]{64}$/u.test(snapshotHash);
}

function safeFailure(error) {
  if (error instanceof ProjectExportOperationError) return error;
  const message = error instanceof Error ? error.message : "";
  const terminal = /^(?:invalid|unsupported|project_export_filter|library_pdf_unicode_font)/u.test(message);
  return new ProjectExportOperationError(
    terminal ? "export_snapshot_invalid" : "export_render_failed",
    { retryable: !terminal },
  );
}

async function markFailure(pool, identity, failure, finalAttempt) {
  const terminal = finalAttempt || !failure.retryable;
  await pool.query(
    `update project_export_operations
        set status = $4, error_code = $5, error_message = $6,
            updated_at = now(), completed_at = case when $4 = 'failed' then now() else null end
      where id = $1 and project_id = $2 and snapshot_hash = $3
        and status in ('pending','queued','rendering','retryable_failed')`,
    [
      identity.operationId,
      identity.projectId,
      identity.snapshotHash,
      terminal ? "failed" : "retryable_failed",
      failure.code,
      terminal
        ? "Не удалось сформировать файл экспорта."
        : "Формирование файла будет повторено автоматически.",
    ],
  ).catch(() => {});
  if (terminal) {
    await pool.query(
      `update project_export_outbox
          set status = 'failed', last_error_code = $3,
              lease_token = null, lease_expires_at = null, updated_at = now()
        where operation_id = $1 and project_id = $2 and status <> 'cancelled'`,
      [identity.operationId, identity.projectId, failure.code],
    ).catch(() => {});
  }
}

function artifactMatches(row, artifact) {
  return row
    && String(row.sha256) === artifact.sha256
    && Number(row.byte_size) === artifact.bytes.byteLength
    && String(row.file_name) === artifact.fileName
    && String(row.mime_type) === artifact.mimeType;
}

async function persistArtifact(pool, operation, artifact, now) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const current = (await client.query(
      `select status, snapshot_hash
         from project_export_operations
        where id = $1 and project_id = $2
        for update`,
      [operation.id, operation.projectId],
    )).rows[0];
    if (!current) throw new ProjectExportOperationError("export_operation_not_found");
    if (String(current.snapshot_hash) !== operation.snapshotHash) {
      throw new ProjectExportOperationError("export_snapshot_mismatch");
    }
    if (current.status === "expired") {
      await client.query("rollback");
      return { outcome: "terminal", status: "expired" };
    }
    let stored = (await client.query(
      `select id, file_name, mime_type, byte_size, sha256
         from project_export_artifacts
        where operation_id = $1 and project_id = $2`,
      [operation.id, operation.projectId],
    )).rows[0];
    if (!stored) {
      stored = (await client.query(
        `insert into project_export_artifacts
           (operation_id, project_id, file_name, mime_type, byte_size, sha256,
            storage_backend, data, expires_at)
         values ($1, $2, $3, $4, $5, $6, 'postgres', $7, $8)
         on conflict (operation_id) do nothing
         returning id, file_name, mime_type, byte_size, sha256`,
        [
          operation.id,
          operation.projectId,
          artifact.fileName,
          artifact.mimeType,
          artifact.bytes.byteLength,
          artifact.sha256,
          artifact.bytes,
          new Date(now.getTime() + ARTIFACT_TTL_MS),
        ],
      )).rows[0];
      if (!stored) {
        stored = (await client.query(
          `select id, file_name, mime_type, byte_size, sha256
             from project_export_artifacts
            where operation_id = $1 and project_id = $2`,
          [operation.id, operation.projectId],
        )).rows[0];
      }
    }
    if (!artifactMatches(stored, artifact)) {
      throw new ProjectExportOperationError("export_artifact_conflict");
    }
    await client.query(
      `update project_export_operations
          set status = 'ready', error_code = null, error_message = null,
              updated_at = now(), completed_at = coalesce(completed_at, now())
        where id = $1 and project_id = $2 and snapshot_hash = $3`,
      [operation.id, operation.projectId, operation.snapshotHash],
    );
    await client.query(
      `update project_export_outbox
          set status = 'cancelled', lease_token = null, lease_expires_at = null,
              last_error_code = null, updated_at = now()
        where operation_id = $1 and project_id = $2`,
      [operation.id, operation.projectId],
    );
    await client.query("commit");
    return { outcome: "ready", artifactId: Number(stored.id), sha256: artifact.sha256 };
  } catch (error) {
    await client.query("rollback").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** One idempotent render attempt, shared by the HTTP fast path and BullMQ worker. */
export async function processProjectExportOperation({
  pool,
  operationId,
  projectId,
  snapshotHash,
  finalAttempt = false,
  now = () => new Date(),
}) {
  const identity = {
    operationId: Number(operationId),
    projectId: Number(projectId),
    snapshotHash: String(snapshotHash ?? ""),
  };
  if (!validIdentity(identity.operationId, identity.projectId, identity.snapshotHash)) {
    throw new ProjectExportOperationError("invalid_export_job");
  }
  try {
    const claimed = (await pool.query(
      `update project_export_operations
          set status = 'rendering', error_code = null, error_message = null, updated_at = now()
        where id = $1 and project_id = $2 and snapshot_hash = $3
          and status in ('pending','queued','retryable_failed')
        returning id, project_id, export_kind, format, snapshot, snapshot_hash, status`,
      [identity.operationId, identity.projectId, identity.snapshotHash],
    )).rows[0];
    if (!claimed) {
      const current = (await pool.query(
        `select status, snapshot_hash
           from project_export_operations where id = $1 and project_id = $2`,
        [identity.operationId, identity.projectId],
      )).rows[0];
      if (!current) throw new ProjectExportOperationError("export_operation_not_found");
      if (String(current.snapshot_hash) !== identity.snapshotHash) {
        throw new ProjectExportOperationError("export_snapshot_mismatch");
      }
      return { outcome: "terminal", status: String(current.status) };
    }
    const snapshot = claimed.snapshot;
    if (projectExportHash(snapshot) !== identity.snapshotHash) {
      throw new ProjectExportOperationError("export_snapshot_corrupt");
    }
    const rendered = await renderProjectExport(String(claimed.format), snapshot);
    if (!rendered.bytes.byteLength || rendered.bytes.byteLength > MAX_POSTGRES_ARTIFACT_BYTES) {
      throw new ProjectExportOperationError("export_artifact_too_large");
    }
    const artifact = {
      bytes: Buffer.from(rendered.bytes),
      mimeType: rendered.contentType,
      sha256: createHash("sha256").update(rendered.bytes).digest("hex"),
      fileName: projectExportFilename(
        snapshot.project.name,
        snapshot.kind,
        snapshot.period,
        rendered.extension,
      ),
    };
    return await persistArtifact(pool, {
      id: identity.operationId,
      projectId: identity.projectId,
      snapshotHash: identity.snapshotHash,
    }, artifact, now());
  } catch (error) {
    const failure = safeFailure(error);
    await markFailure(pool, identity, failure, finalAttempt);
    throw failure;
  }
}
