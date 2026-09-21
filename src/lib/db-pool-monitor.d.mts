import type { DatabasePoolConfig, DatabaseRuntimeRole } from "./db-pool-config.mjs";

export type DatabasePoolSnapshot = {
  schemaVersion: 2;
  metricsScope: "process";
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
  recentAcquireErrors: number;
  recentWindowMs: number;
  lastAcquireErrorAt: string | null;
  queryDurationP95Ms: number | null;
  queryDurationMaxMs: number | null;
  querySamples: number;
  slowQueries: number;
  queryTimeouts: number;
  queryErrors: number;
  transactionDurationP95Ms: number | null;
  transactionDurationMaxMs: number | null;
  transactionSamples: number;
  activeTransactions: number;
  committedTransactions: number;
  rolledBackTransactions: number;
  abandonedTransactions: number;
  transactionErrors: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
  slowQueryThresholdMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionTimeoutMillis: number;
};

export class DatabasePoolMonitor {
  constructor(now?: () => number);
  recordAcquire(waitMs: number, error?: unknown): void;
  recordQuery(durationMs: number, error: unknown, slowQueryThresholdMillis: number): void;
  recordTransactionStarted(): void;
  recordTransaction(
    durationMs: number,
    outcome: "committed" | "rolled_back" | "abandoned" | "failed",
  ): void;
  snapshot(
    pool: Pick<import("pg").Pool, "totalCount" | "idleCount" | "waitingCount"> | null,
    config: DatabasePoolConfig,
  ): DatabasePoolSnapshot;
}
