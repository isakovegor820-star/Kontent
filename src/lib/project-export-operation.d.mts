export class ProjectExportOperationError extends Error {
  readonly code: string;
  readonly retryable: boolean;
}
export function processProjectExportOperation(input: {
  pool: {
    query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
    connect(): Promise<{
      query(sql: string, values?: unknown[]): Promise<{ rowCount: number | null; rows: Array<Record<string, unknown>> }>;
      release(): void;
    }>;
  };
  operationId: number;
  projectId: number;
  snapshotHash: string;
  finalAttempt?: boolean;
  now?: () => Date;
}): Promise<
  | { outcome: "ready"; artifactId: number; sha256: string }
  | { outcome: "terminal"; status: string }
>;
