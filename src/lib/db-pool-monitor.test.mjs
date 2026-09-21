import { describe, expect, it } from "vitest";

import { DatabasePoolMonitor } from "./db-pool-monitor.mjs";

const config = {
  role: "web",
  max: 8,
  connectionTimeoutMillis: 2_000,
  queryTimeoutMillis: 30_000,
  slowQueryThresholdMillis: 1_000,
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
      schemaVersion: 2,
      metricsScope: "process",
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
      recentAcquireErrors: 0,
      recentWindowMs: 60_000,
      lastAcquireErrorAt: null,
      queryDurationP95Ms: null,
      queryDurationMaxMs: null,
      querySamples: 0,
      slowQueries: 0,
      queryTimeouts: 0,
      queryErrors: 0,
      transactionDurationP95Ms: null,
      transactionDurationMaxMs: null,
      transactionSamples: 0,
      activeTransactions: 0,
      committedTransactions: 0,
      rolledBackTransactions: 0,
      abandonedTransactions: 0,
      transactionErrors: 0,
      connectionTimeoutMillis: 2_000,
      queryTimeoutMillis: 30_000,
      slowQueryThresholdMillis: 1_000,
      statementTimeoutMillis: 30_000,
      idleInTransactionTimeoutMillis: 15_000,
    });
  });

  it("exports process-scoped query and transaction aggregates", () => {
    const monitor = new DatabasePoolMonitor();
    monitor.recordQuery(12, undefined, 10);
    monitor.recordQuery(50, Object.assign(new Error("query read timeout"), { code: "57014" }), 10);
    monitor.recordTransactionStarted();
    monitor.recordTransaction(75, "rolled_back");

    expect(monitor.snapshot(null, { ...config, slowQueryThresholdMillis: 10 })).toMatchObject({
      metricsScope: "process",
      queryDurationP95Ms: 50,
      queryDurationMaxMs: 50,
      querySamples: 2,
      slowQueries: 2,
      queryTimeouts: 1,
      queryErrors: 1,
      transactionDurationP95Ms: 75,
      transactionDurationMaxMs: 75,
      transactionSamples: 1,
      activeTransactions: 0,
      committedTransactions: 0,
      rolledBackTransactions: 1,
      abandonedTransactions: 0,
      transactionErrors: 0,
    });
  });

  it("counts acquisition timeouts without serializing exception details", () => {
    const monitor = new DatabasePoolMonitor();
    monitor.recordAcquire(2_001, new Error("timeout exceeded when trying to connect"));
    const snapshot = monitor.snapshot(null, config);
    expect(snapshot).toMatchObject({ acquireTimeouts: 1, acquireErrors: 1 });
    expect(JSON.stringify(snapshot)).not.toContain("timeout exceeded");
  });

  it("recovers its current signal without deleting lifetime failures", () => {
    let now = 1_000_000;
    const monitor = new DatabasePoolMonitor(() => now);
    monitor.recordAcquire(2001, new Error("timeout exceeded when trying to connect"));
    expect(monitor.snapshot(null, config).recentAcquireErrors).toBe(1);
    now += 60_000;
    monitor.recordAcquire(1);
    expect(monitor.snapshot(null, config)).toMatchObject({ recentAcquireErrors: 0, acquireErrors: 1, acquireTimeouts: 1, lastAcquireErrorAt: new Date(1_000_000).toISOString() });
  });

  it("bounds duration samples while keeping monotonic counters", () => {
    const monitor = new DatabasePoolMonitor();
    for (let index = 0; index < 1_100; index += 1) {
      monitor.recordQuery(index, undefined, 10);
    }
    const snapshot = monitor.snapshot(null, { ...config, slowQueryThresholdMillis: 10 });
    expect(snapshot.querySamples).toBe(1_024);
    expect(snapshot.slowQueries).toBe(1_090);
    expect(snapshot.queryDurationMaxMs).toBe(1_099);
  });
});
