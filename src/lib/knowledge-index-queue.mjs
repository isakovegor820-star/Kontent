import { resolveEmbeddingConfig } from "./embedding-config.mjs";
export const KNOWLEDGE_INDEX_JOB = "knowledge-index";

function positiveSourceId(value) {
  const sourceId = Number(value);
  if (!Number.isSafeInteger(sourceId) || sourceId <= 0) {
    throw new Error("invalid_knowledge_source_id");
  }
  return sourceId;
}

export function knowledgeIndexJobId(value) {
  return `knowledge-source-${positiveSourceId(value)}`;
}

/**
 * Every producer uses one BullMQ identity per source. API retries and periodic database
 * reconciliation therefore converge instead of racing two index transactions.
 */
export async function enqueueKnowledgeIndex(queue, value) {
  const sourceId = positiveSourceId(value);
  const jobId = knowledgeIndexJobId(sourceId);
  await queue.add(
    KNOWLEDGE_INDEX_JOB,
    { sourceId },
    {
      jobId,
      attempts: 3,
      backoff: { type: "fixed", delay: 20_000 },
      removeOnComplete: true,
      // The pending DB row is the durable retry signal. Removing an exhausted job lets
      // the next reconciliation cycle enqueue the same deterministic identity again.
      removeOnFail: true,
    },
  );
  return { jobId };
}

/** Recover sources saved while Redis or the embedding provider was unavailable. */
export async function reconcilePendingKnowledgeSources(db, queue, options = {}) {
  const requestedLimit = Number(options.limit ?? 200);
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(1_000, Math.max(1, requestedLimit))
    : 200;
  const model = options.model ?? resolveEmbeddingConfig().identity;
  const rows = (
    await db.query(
      `with due as (
         select id from knowledge_sources
          where status <> 'error'
            and (next_retry_at is null or next_retry_at <= now())
            and (status = 'pending' or text_indexed_at is null or embedding_model is distinct from $2
              or (embedding_error_code is not null and next_retry_at is not null and embedding_attempts < 5))
          order by next_retry_at nulls first, last_attempt_at nulls first, id
          limit $1 for update skip locked
       ) update knowledge_sources source set next_retry_at=now()+interval '5 minutes'
         from due where source.id=due.id returning source.id`,
      [limit, model],
    )
  ).rows;

  let accepted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await enqueueKnowledgeIndex(queue, row.id);
      accepted += 1;
    } catch {
      // Keep the durable signal, release the enqueue lease with a bounded delay.
      await db.query("update knowledge_sources set next_retry_at=now()+interval '1 minute' where id=$1", [row.id]);
      failed += 1;
    }
  }
  return { scanned: rows.length, accepted, failed };
}
