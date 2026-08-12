import type { Pool } from "pg";
export function reconcilePublicationOutbox(input: {
  pool: Pick<Pool, "connect" | "query">;
  enqueue: (
    postId: number,
    scheduledAt: Date,
    scheduleRevision: number,
    projectId: number,
  ) => Promise<unknown>;
  operationId?: number | null;
  limit?: number;
  now?: () => Date;
}): Promise<{
  scanned: number;
  enqueued: number;
  failed: number;
  statuses: Record<number, string>;
}>;
