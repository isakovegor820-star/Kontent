import { Pool, type PoolClient, type PoolConfig } from "pg";

import type { DatabasePoolConfig } from "./db-pool-config.mjs";
import type { DatabasePoolMonitor, DatabasePoolSnapshot } from "./db-pool-monitor.mjs";

export class MonitoredPgPool extends Pool {
  readonly auroraConfig: DatabasePoolConfig;
  readonly monitor: DatabasePoolMonitor;

  constructor(
    options: PoolConfig,
    auroraConfig: DatabasePoolConfig,
    monitor?: DatabasePoolMonitor,
  );

  observeClient(client: PoolClient): PoolClient;
  auroraSnapshot(): DatabasePoolSnapshot;
}
