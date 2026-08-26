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
  const rows = (
    await db.query(
      `select id
         from knowledge_sources
        where status = 'pending'
        order by added_at, id
        limit $1`,
      [limit],
    )
  ).rows;

  let accepted = 0;
  let failed = 0;
  for (const row of rows) {
    try {
      await enqueueKnowledgeIndex(queue, row.id);
      accepted += 1;
    } catch {
      failed += 1;
    }
  }
  return { scanned: rows.length, accepted, failed };
}
