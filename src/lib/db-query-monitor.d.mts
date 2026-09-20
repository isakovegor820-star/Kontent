import type { PoolClient } from "pg";

import type { DatabasePoolMonitor } from "./db-pool-monitor.mjs";

export type DatabaseClientMonitorOptions = {
  now?: () => number;
  slowQueryThresholdMillis: number;
};

export function instrumentDatabaseClient<T extends Pick<PoolClient, "query" | "release">>(
  client: T,
  monitor: DatabasePoolMonitor,
  options: DatabaseClientMonitorOptions,
): T;

export function finalizeDatabaseClient(client: Pick<PoolClient, "query" | "release">): void;
