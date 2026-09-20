import { describe, expect, it } from "vitest";

import { DatabasePoolMonitor } from "./db-pool-monitor.mjs";
import { instrumentDatabaseClient } from "./db-query-monitor.mjs";

const config = {
  role: "web",
  max: 8,
  connectionTimeoutMillis: 2_000,
  queryTimeoutMillis: 30_000,
  slowQueryThresholdMillis: 10,
  statementTimeoutMillis: 30_000,
  idleInTransactionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  maxLifetimeSeconds: 300,
};

function fakeClient() {
  let clock = 0;
  let releases = 0;
  const durations = new Map([
    ["select slow", 20],
    ["begin", 5],
    ["select in transaction", 30],
    ["commit", 5],
    ["rollback", 5],
    ["select timeout", 15],
  ]);
  const client = {
    query(input, values, callback) {
      const actualCallback = typeof values === "function" ? values : callback;
      const text = typeof input === "string" ? input : input.text;
      clock += durations.get(text.toLowerCase()) || 1;
      const error = text.toLowerCase() === "select timeout"
        ? Object.assign(new Error("canceling statement due to statement timeout"), { code: "57014" })
        : null;
      if (actualCallback) {
        actualCallback(error, error ? undefined : { rows: [] });
        return undefined;
      }
      return error ? Promise.reject(error) : Promise.resolve({ rows: [] });
    },
    release() {
      releases += 1;
    },
  };
  return { client, now: () => clock, releases: () => releases };
}

describe("database client monitoring", () => {
  it("records query and transaction duration without retaining SQL", async () => {
    const monitor = new DatabasePoolMonitor();
    const fake = fakeClient();
    const client = instrumentDatabaseClient(fake.client, monitor, {
      now: fake.now,
      slowQueryThresholdMillis: config.slowQueryThresholdMillis,
    });

    await client.query("select slow");
    await client.query("begin");
    await client.query("select in transaction");
    await client.query("commit");

    const snapshot = monitor.snapshot(null, config);
    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      metricsScope: "process",
      queryDurationP95Ms: 30,
      queryDurationMaxMs: 30,
      querySamples: 4,
      slowQueries: 2,
      queryTimeouts: 0,
      queryErrors: 0,
      transactionDurationP95Ms: 40,
      transactionDurationMaxMs: 40,
      transactionSamples: 1,
      activeTransactions: 0,
      committedTransactions: 1,
      rolledBackTransactions: 0,
      abandonedTransactions: 0,
      transactionErrors: 0,
    });
    expect(JSON.stringify(snapshot)).not.toContain("select slow");
    expect(JSON.stringify(snapshot)).not.toContain("select in transaction");
  });

  it("counts safe timeout/error outcomes and callback queries", async () => {
    const monitor = new DatabasePoolMonitor();
    const fake = fakeClient();
    const client = instrumentDatabaseClient(fake.client, monitor, {
      now: fake.now,
      slowQueryThresholdMillis: config.slowQueryThresholdMillis,
    });

    await expect(client.query("select timeout")).rejects.toMatchObject({ code: "57014" });
    await new Promise((resolve, reject) => {
      client.query("select slow", (error) => error ? reject(error) : resolve());
    });

    expect(monitor.snapshot(null, config)).toMatchObject({
      querySamples: 2,
      slowQueries: 2,
      queryTimeouts: 1,
      queryErrors: 1,
    });
  });

  it("marks an open transaction abandoned when its client is released", async () => {
    const monitor = new DatabasePoolMonitor();
    const fake = fakeClient();
    const client = instrumentDatabaseClient(fake.client, monitor, {
      now: fake.now,
      slowQueryThresholdMillis: config.slowQueryThresholdMillis,
    });

    await client.query("begin");
    expect(monitor.snapshot(null, config).activeTransactions).toBe(1);
    client.release();

    expect(fake.releases()).toBe(1);
    expect(monitor.snapshot(null, config)).toMatchObject({
      activeTransactions: 0,
      transactionSamples: 1,
      abandonedTransactions: 1,
    });
  });
});
