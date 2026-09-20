import pg from "pg";

import { DatabasePoolMonitor } from "./db-pool-monitor.mjs";
import { finalizeDatabaseClient, instrumentDatabaseClient } from "./db-query-monitor.mjs";

/**
 * One monitored pg Pool implementation shared by the web and the long-lived worker.
 * Keeping the connection boundary here prevents either runtime from silently losing
 * acquire/query/transaction metrics or the role-specific timeout configuration.
 */
export class MonitoredPgPool extends pg.Pool {
  constructor(options, auroraConfig, monitor = new DatabasePoolMonitor()) {
    super(options);
    this.auroraConfig = auroraConfig;
    this.monitor = monitor;
  }

  observeClient(client) {
    return instrumentDatabaseClient(client, this.monitor, {
      slowQueryThresholdMillis: this.auroraConfig.slowQueryThresholdMillis,
    });
  }

  connect(callback) {
    const startedAt = performance.now();
    if (typeof callback === "function") {
      return super.connect((error, client, done) => {
        this.monitor.recordAcquire(performance.now() - startedAt, error);
        const observedClient = client ? this.observeClient(client) : client;
        callback(error, observedClient, (release) => {
          if (observedClient) finalizeDatabaseClient(observedClient);
          done(release);
        });
      });
    }
    return super.connect().then(
      (client) => {
        this.monitor.recordAcquire(performance.now() - startedAt);
        return this.observeClient(client);
      },
      (error) => {
        this.monitor.recordAcquire(performance.now() - startedAt, error);
        throw error;
      },
    );
  }

  auroraSnapshot() {
    return this.monitor.snapshot(this, this.auroraConfig);
  }
}
