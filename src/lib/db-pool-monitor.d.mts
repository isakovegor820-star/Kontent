import type { DatabasePoolConfig, DatabaseRuntimeRole } from "./db-pool-config.mjs";

export type DatabasePoolSnapshot = {
  schemaVersion: 1;
  role: DatabaseRuntimeRole;
  max: number;
  total: number;
  active: number;
  idle: number;
  waiting: number;
  acquireWaitP95Ms: number | null;
  acquireSamples: number;
  acquireTimeouts: number;
  acquireErrors: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionTimeoutMillis: number;
};

export class DatabasePoolMonitor {
  recordAcquire(waitMs: number, error?: unknown): void;
  snapshot(
    pool: Pick<import("pg").Pool, "totalCount" | "idleCount" | "waitingCount"> | null,
    config: DatabasePoolConfig,
  ): DatabasePoolSnapshot;
}
