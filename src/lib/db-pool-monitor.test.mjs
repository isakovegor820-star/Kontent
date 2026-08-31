import { describe, expect, it } from "vitest";

import { DatabasePoolMonitor } from "./db-pool-monitor.mjs";

const config = {
  role: "web",
  max: 8,
  connectionTimeoutMillis: 2_000,
  queryTimeoutMillis: 30_000,
  statementTimeoutMillis: 30_000,
  idleInTransactionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  maxLifetimeSeconds: 300,
};

describe("database pool monitoring", () => {
  it("exports bounded pool counters and observed acquire p95", () => {
    const monitor = new DatabasePoolMonitor();
    for (const waitMs of [1, 2, 3, 20]) monitor.recordAcquire(waitMs);

    expect(monitor.snapshot({ totalCount: 7, idleCount: 2, waitingCount: 3 }, config)).toEqual({
      schemaVersion: 1,
      role: "web",
      max: 8,
      total: 7,
      active: 5,
      idle: 2,
      waiting: 3,
      acquireWaitP95Ms: 20,
      acquireSamples: 4,
      acquireTimeouts: 0,
      acquireErrors: 0,
      connectionTimeoutMillis: 2_000,
      queryTimeoutMillis: 30_000,
      statementTimeoutMillis: 30_000,
      idleInTransactionTimeoutMillis: 15_000,
    });
  });

  it("counts acquisition timeouts without serializing exception details", () => {
    const monitor = new DatabasePoolMonitor();
    monitor.recordAcquire(2_001, new Error("timeout exceeded when trying to connect"));
    const snapshot = monitor.snapshot(null, config);
    expect(snapshot).toMatchObject({ acquireTimeouts: 1, acquireErrors: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("timeout exceeded");
  });
});
