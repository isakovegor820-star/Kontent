import type { Pool } from "pg";

export function reconcileLegalVisualRenderOutbox(input: {
  pool: Pool;
  enqueue: (data: { operationId: number; projectId: number; configHash: string }) => Promise<unknown>;
  operationId?: number | null;
  limit?: number;
  now?: () => Date;
}): Promise<{ scanned: number; enqueued: number; failed: number }>;
