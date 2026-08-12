export function reconcileProjectExportOutbox(input: {
  pool: {
    query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
    connect(): Promise<{
      query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
      release(): void;
    }>;
  };
  enqueue(data: { operationId: number; projectId: number; snapshotHash: string }): Promise<unknown>;
  operationId?: number | null;
  limit?: number;
  now?: () => Date;
}): Promise<{ scanned: number; enqueued: number; failed: number }>;
export function expireProjectExportArtifacts(
  pool: Parameters<typeof reconcileProjectExportOutbox>[0]["pool"],
  limit?: number,
): Promise<{ expiredArtifacts: number }>;
