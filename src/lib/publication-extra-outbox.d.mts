export function reconcilePublicationExtraOutbox(input: {
  pool: {
    connect(): Promise<{
      query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
      release(): void;
    }>;
    query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount?: number }>;
  };
  enqueue(data: { operationId: number; projectId: number; fingerprint: string }): Promise<unknown>;
  operationId?: number | null;
  limit?: number;
  now?: () => Date;
}): Promise<{ scanned: number; enqueued: number; failed: number }>;
