import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { getPool } from "./db";
import type { DraftAiValidation } from "./draft-types";
import { normalizeDraftAiValidation } from "./draft-review";
import type { Post } from "./types";

type Queryable = Pick<Pool | PoolClient, "query">;
type TransactionPool = Pick<Pool, "connect">;

export type GenerationOperationStatus =
  | "running"
  | "pending_ack"
  | "acknowledged"
  | "failed"
  | "retryable_failed";

export interface GenerationOperationInput {
  userId: number;
  aiUsageId: number;
  requestKey: string;
  serverRequestId: string;
  requestFingerprint: string;
  channelId: number;
  sourceContextId?: number | null;
  sourceContextVersion?: number | null;
  inputDraftId?: number | null;
  inputDraftVersion?: number | null;
  providerEngine: string;
  providerModel: string;
}

export interface GenerationArtifactResult {
  id: number;
  text: string;
  resultHash: string;
  validation: DraftAiValidation;
}

export interface ResolvedGenerationDraft extends GenerationArtifactResult {
  channelId: number;
  sourceContextId: number | null;
  sourceContextVersion: number | null;
  inputDraftId: number | null;
  inputDraftVersion: number | null;
  sourceRef: Post["sourceRef"] | null;
  purpose: "publishable" | "needs_review";
}

export class GenerationArtifactError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = "GenerationArtifactError";
  }
}

export function generationResultHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function generationBindingValid(input: {
  generationResultId: unknown;
  text: string;
  resultHash: unknown;
  receiptHash: unknown;
  aiValidation: unknown;
  receipt: unknown;
}): boolean {
  const validation = normalizeDraftAiValidation(input.aiValidation);
  const receipt = normalizeDraftAiValidation(input.receipt);
  return positiveId(input.generationResultId) != null
    && validation != null
    && receipt != null
    && typeof input.resultHash === "string"
    && input.resultHash === input.receiptHash
    && generationResultHash(input.text) === input.resultHash
    && JSON.stringify(validation) === JSON.stringify(receipt);
}

function positiveId(value: unknown): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function exactOptionalPair(id: unknown, version: unknown): [number | null, number | null] {
  const normalizedId = id == null ? null : positiveId(id);
  const normalizedVersion = version == null ? null : positiveId(version);
  if ((normalizedId == null) !== (normalizedVersion == null)) {
    throw new GenerationArtifactError("generation_binding_incomplete");
  }
  return [normalizedId, normalizedVersion];
}

function validFingerprint(value: string): boolean {
  return /^[0-9a-f]{64}$/u.test(value);
}

function validRequestKey(value: string): boolean {
  return /^[A-Za-z0-9:_-]{8,128}$/u.test(value);
}

function validRequestId(value: string): boolean {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value);
}

/** Starts or safely resumes one server-owned generation state machine. */
export async function beginGenerationOperation(
  input: GenerationOperationInput,
  pool: TransactionPool = getPool(),
): Promise<number> {
  if (
    !positiveId(input.userId)
    || !positiveId(input.aiUsageId)
    || !positiveId(input.channelId)
    || !validRequestKey(input.requestKey)
    || !validRequestId(input.serverRequestId)
    || !validFingerprint(input.requestFingerprint)
  ) throw new GenerationArtifactError("bad_generation_operation");
  const [sourceContextId, sourceContextVersion] = exactOptionalPair(
    input.sourceContextId,
    input.sourceContextVersion,
  );
  const [inputDraftId, inputDraftVersion] = exactOptionalPair(
    input.inputDraftId,
    input.inputDraftVersion,
  );
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const channel = await tx.query(
      `select id from channels where id = $1 and user_id = $2 and is_active = true for share`,
      [input.channelId, input.userId],
    );
    if (channel.rowCount !== 1) throw new GenerationArtifactError("generation_channel_forbidden");
    if (sourceContextId != null) {
      const source = await tx.query<{ version: number | string; purpose: string }>(
        `select version, purpose from drafts where id = $1 and user_id = $2 for share`,
        [sourceContextId, input.userId],
      );
      if (
        source.rowCount !== 1
        || source.rows[0]?.purpose !== "source_context"
        || Number(source.rows[0]?.version) !== sourceContextVersion
      ) throw new GenerationArtifactError("generation_source_conflict");
    }
    if (inputDraftId != null) {
      const draft = await tx.query<{ version: number | string; purpose: string }>(
        `select d.version, d.purpose
           from drafts d
           join draft_destinations dd on dd.draft_id = d.id and dd.channel_id = $3
          where d.id = $1 and d.user_id = $2
          for share of d`,
        [inputDraftId, input.userId, input.channelId],
      );
      if (
        draft.rowCount !== 1
        || draft.rows[0]?.purpose === "source_context"
        || Number(draft.rows[0]?.version) !== inputDraftVersion
      ) throw new GenerationArtifactError("generation_input_conflict");
    }

    const existing = (await tx.query<{
      id: number | string;
      request_fingerprint: string;
      channel_id: number | string;
      source_context_id: number | string | null;
      source_context_version: number | string | null;
      input_draft_id: number | string | null;
      input_draft_version: number | string | null;
      status: GenerationOperationStatus;
    }>(
      `select id, request_fingerprint, channel_id, source_context_id, source_context_version,
              input_draft_id, input_draft_version, status
         from generation_operations
        where user_id = $1 and request_key = $2
        for update`,
      [input.userId, input.requestKey],
    )).rows[0];
    if (existing) {
      const sameBinding = existing.request_fingerprint === input.requestFingerprint
        && Number(existing.channel_id) === input.channelId
        && (existing.source_context_id == null ? null : Number(existing.source_context_id)) === sourceContextId
        && (existing.source_context_version == null ? null : Number(existing.source_context_version)) === sourceContextVersion
        && (existing.input_draft_id == null ? null : Number(existing.input_draft_id)) === inputDraftId
        && (existing.input_draft_version == null ? null : Number(existing.input_draft_version)) === inputDraftVersion;
      if (!sameBinding) throw new GenerationArtifactError("generation_operation_conflict");
      if (existing.status === "failed") throw new GenerationArtifactError("generation_terminal_failure");
      // A durable result already exists for pending_ack/acknowledged. The usage replay path
      // must return it; never reopen the provider call if those stores become temporarily
      // inconsistent.
      if (existing.status === "pending_ack") {
        throw new GenerationArtifactError("generation_result_pending_ack");
      }
      if (existing.status === "acknowledged") {
        throw new GenerationArtifactError("generation_already_acknowledged");
      }
      if (existing.status === "retryable_failed" || existing.status === "running") {
        await tx.query(
          `update generation_operations
              set ai_usage_id = $3, server_request_id = $4::uuid,
                  provider_engine = $5, provider_model = $6,
                  status = 'running', error_code = null, retryable = false, updated_at = now()
            where id = $1 and user_id = $2`,
          [existing.id, input.userId, input.aiUsageId, input.serverRequestId,
            input.providerEngine.slice(0, 80), input.providerModel.slice(0, 160)],
        );
      }
      await tx.query("commit");
      return Number(existing.id);
    }

    const inserted = await tx.query<{ id: number | string }>(
      `insert into generation_operations (
         user_id, ai_usage_id, request_key, server_request_id, request_fingerprint,
         channel_id, source_context_id, source_context_version,
         input_draft_id, input_draft_version, provider_engine, provider_model, status
       ) values ($1, $2, $3, $4::uuid, $5, $6, $7, $8, $9, $10, $11, $12, 'running')
       returning id`,
      [input.userId, input.aiUsageId, input.requestKey, input.serverRequestId,
        input.requestFingerprint, input.channelId, sourceContextId, sourceContextVersion,
        inputDraftId, inputDraftVersion, input.providerEngine.slice(0, 80), input.providerModel.slice(0, 160)],
    );
    await tx.query("commit");
    return Number(inserted.rows[0]?.id);
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

export async function failGenerationOperation(
  userId: number,
  serverRequestId: string,
  code: string,
  retryable: boolean,
  db: Queryable = getPool(),
): Promise<void> {
  if (!positiveId(userId) || !validRequestId(serverRequestId)) return;
  await db.query(
    `update generation_operations
        set status = $3, error_code = $4, retryable = $5, updated_at = now()
      where user_id = $1 and server_request_id = $2::uuid and status = 'running'`,
    [userId, serverRequestId, retryable ? "retryable_failed" : "failed", code.slice(0, 100), retryable],
  );
}

export async function lookupTerminalGenerationFailure(
  userId: number,
  requestKey: string,
  fingerprint: string,
  db: Queryable = getPool(),
): Promise<{ code: string; retryable: false } | null> {
  if (!positiveId(userId) || !validRequestKey(requestKey) || !validFingerprint(fingerprint)) return null;
  const row = (await db.query<{ request_fingerprint: string; error_code: string | null; status: string }>(
    `select request_fingerprint, error_code, status
       from generation_operations where user_id = $1 and request_key = $2`,
    [userId, requestKey],
  )).rows[0];
  if (!row) return null;
  if (row.request_fingerprint !== fingerprint) {
    throw new GenerationArtifactError("generation_operation_conflict");
  }
  return row.status === "failed"
    ? { code: row.error_code || "generation_validation_failed", retryable: false }
    : null;
}

/** Persists immutable provider output and a receipt bound to its exact SHA-256. */
export async function stageGenerationArtifact(
  input: {
    userId: number;
    serverRequestId: string;
    text: string;
    validation: unknown;
    providerResult: Record<string, unknown>;
  },
  pool: TransactionPool = getPool(),
): Promise<GenerationArtifactResult> {
  const validation = normalizeDraftAiValidation(input.validation);
  if (!validation) {
    throw new GenerationArtifactError("generation_validation_blocked");
  }
  const text = input.text.trim();
  if (!text) throw new GenerationArtifactError("generation_result_empty");
  const hash = generationResultHash(text);
  const tx = await pool.connect();
  try {
    await tx.query("begin");
    const operation = (await tx.query<{ id: number | string; status: GenerationOperationStatus }>(
      `select id, status from generation_operations
        where user_id = $1 and server_request_id = $2::uuid for update`,
      [input.userId, input.serverRequestId],
    )).rows[0];
    if (!operation || !["running", "pending_ack"].includes(operation.status)) {
      throw new GenerationArtifactError("generation_operation_not_running");
    }
    const inserted = await tx.query<{ id: number | string; text: string; result_hash: string }>(
      `insert into generation_results (operation_id, result_hash, text, provider_result)
       values ($1, $2, $3, $4::jsonb)
       on conflict (operation_id) do nothing
       returning id, text, result_hash`,
      [operation.id, hash, text, JSON.stringify(input.providerResult)],
    );
    const result = inserted.rows[0] ?? (await tx.query<{
      id: number | string; text: string; result_hash: string;
    }>(
      `select id, text, result_hash from generation_results where operation_id = $1 for share`,
      [operation.id],
    )).rows[0];
    if (!result || result.text !== text || result.result_hash !== hash) {
      throw new GenerationArtifactError("generation_result_conflict");
    }
    const receiptPayload = JSON.stringify(validation);
    await tx.query(
      `insert into validation_receipts (generation_result_id, result_hash, status, receipt)
       values ($1, $2, $3, $4::jsonb)
       on conflict (generation_result_id) do nothing`,
      [result.id, hash, validation.status, receiptPayload],
    );
    const receipt = (await tx.query<{ result_hash: string; status: string; receipt: unknown }>(
      `select result_hash, status, receipt from validation_receipts
        where generation_result_id = $1 for share`,
      [result.id],
    )).rows[0];
    if (
      !receipt
      || receipt.result_hash !== hash
      || receipt.status !== validation.status
      || JSON.stringify(normalizeDraftAiValidation(receipt.receipt)) !== JSON.stringify(validation)
    ) throw new GenerationArtifactError("generation_receipt_conflict");
    await tx.query(
      `update generation_operations set status = 'pending_ack', updated_at = now()
        where id = $1 and status in ('running', 'pending_ack')`,
      [operation.id],
    );
    await tx.query("commit");
    return { id: Number(result.id), text, resultHash: hash, validation };
  } catch (error) {
    await tx.query("rollback").catch(() => {});
    throw error;
  } finally {
    tx.release();
  }
}

/** Marks only an already-committed usage result as acknowledged and draft-eligible. */
export async function acknowledgeGenerationArtifact(
  userId: number,
  usageReservationKey: string,
  db: Queryable = getPool(),
): Promise<number | null> {
  if (!positiveId(userId) || !validRequestKey(usageReservationKey)) return null;
  const updated = await db.query<{ generation_result_id: number | string }>(
    `update generation_operations operation
        set status = 'acknowledged', acknowledged_at = coalesce(acknowledged_at, now()), updated_at = now()
       from ai_usage usage, generation_results result, validation_receipts receipt
      where operation.user_id = $1
        and operation.ai_usage_id = usage.id
        and usage.user_id = operation.user_id
        and usage.reservation_key = $2
        and usage.status = 'committed'
        and result.operation_id = operation.id
        and receipt.generation_result_id = result.id
        and receipt.result_hash = result.result_hash
        and operation.status in ('pending_ack', 'acknowledged')
      returning result.id as generation_result_id`,
    [userId, usageReservationKey],
  );
  const id = positiveId(updated.rows[0]?.generation_result_id);
  return id;
}

/** Resolves every trusted field from server data; client text/provenance never wins. */
export async function resolveGenerationDraft(
  userId: number,
  generationResultId: number,
  db: Queryable = getPool(),
): Promise<ResolvedGenerationDraft> {
  const id = positiveId(generationResultId);
  if (!positiveId(userId) || !id) throw new GenerationArtifactError("bad_generation_result");
  const row = (await db.query<{
    id: number | string;
    text: string;
    result_hash: string;
    receipt_hash: string;
    receipt_status: string;
    receipt: unknown;
    channel_id: number | string;
    source_context_id: number | string | null;
    source_context_version: number | string | null;
    input_draft_id: number | string | null;
    input_draft_version: number | string | null;
    source_ref: unknown;
    source_purpose: string | null;
    source_version: number | string | null;
  }>(
    `select result.id, result.text, result.result_hash, receipt.result_hash as receipt_hash,
            receipt.status as receipt_status, receipt.receipt, operation.channel_id,
            operation.source_context_id, operation.source_context_version,
            operation.input_draft_id, operation.input_draft_version,
            source.source_ref, source.purpose as source_purpose, source.version as source_version
       from generation_results result
       join generation_operations operation on operation.id = result.operation_id
       join validation_receipts receipt on receipt.generation_result_id = result.id
       join channels channel on channel.id = operation.channel_id
       left join drafts source on source.id = operation.source_context_id and source.user_id = operation.user_id
      where result.id = $1 and operation.user_id = $2 and operation.status = 'acknowledged'
        and channel.user_id = operation.user_id and channel.is_active = true`,
    [id, userId],
  )).rows[0];
  if (!row) throw new GenerationArtifactError("generation_result_forbidden");
  if (
    row.result_hash !== row.receipt_hash
    || generationResultHash(row.text) !== row.result_hash
  ) throw new GenerationArtifactError("generation_result_binding_invalid");
  const validation = normalizeDraftAiValidation(row.receipt);
  if (!validation || validation.status !== row.receipt_status) {
    throw new GenerationArtifactError("generation_receipt_invalid");
  }
  const sourceContextId = row.source_context_id == null ? null : Number(row.source_context_id);
  const sourceContextVersion = row.source_context_version == null ? null : Number(row.source_context_version);
  if (sourceContextId != null && (
    row.source_purpose !== "source_context"
    || Number(row.source_version) !== sourceContextVersion
  )) throw new GenerationArtifactError("generation_source_conflict");
  return {
    id: Number(row.id),
    text: row.text,
    resultHash: row.result_hash,
    validation,
    channelId: Number(row.channel_id),
    sourceContextId,
    sourceContextVersion,
    inputDraftId: row.input_draft_id == null ? null : Number(row.input_draft_id),
    inputDraftVersion: row.input_draft_version == null ? null : Number(row.input_draft_version),
    sourceRef: (row.source_ref ?? null) as Post["sourceRef"] | null,
    purpose: validation.status === "passed" ? "publishable" : "needs_review",
  };
}
