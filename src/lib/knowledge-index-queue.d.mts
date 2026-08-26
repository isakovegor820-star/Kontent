export const KNOWLEDGE_INDEX_JOB: "knowledge-index";
export function knowledgeIndexJobId(sourceId: number | string): string;
export function enqueueKnowledgeIndex(
  queue: {
    add(name: string, data: { sourceId: number }, options: Record<string, unknown>): Promise<unknown>;
  },
  sourceId: number | string,
): Promise<{ jobId: string }>;
export function reconcilePendingKnowledgeSources(
  db: { query(sql: string, params: unknown[]): Promise<{ rows: Array<{ id: number | string }> }> },
  queue: {
    add(name: string, data: { sourceId: number }, options: Record<string, unknown>): Promise<unknown>;
  },
  options?: { limit?: number },
): Promise<{ scanned: number; accepted: number; failed: number }>;
