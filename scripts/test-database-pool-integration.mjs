import assert from "node:assert/strict";

import { resolveDatabasePoolConfig } from "../src/lib/db-pool-config.mjs";
import { MonitoredPgPool } from "../src/lib/monitored-pg-pool.mjs";

const connectionString = String(process.env.DATABASE_POOL_TEST_DATABASE_URL || "").trim();
if (!connectionString) throw new Error("DATABASE_POOL_TEST_DATABASE_URL is required");

const target = new URL(connectionString);
const localHosts = new Set(["127.0.0.1", "localhost", "::1"]);
const databaseName = target.pathname.replace(/^\/+|\/+$/gu, "");
if (!localHosts.has(target.hostname) || databaseName !== "aurora_e2e_real") {
  throw new Error("database pool integration requires local disposable aurora_e2e_real");
}

const config = resolveDatabasePoolConfig({
  NODE_ENV: "test",
  AURORA_RUNTIME_ROLE: "web",
  AURORA_DB_POOL_MAX_WEB: "1",
  AURORA_DB_CONNECTION_TIMEOUT_MS: "150",
  AURORA_DB_QUERY_TIMEOUT_MS: "1000",
  AURORA_DB_SLOW_QUERY_MS: "50",
  AURORA_DB_STATEMENT_TIMEOUT_MS: "250",
  AURORA_DB_IDLE_TRANSACTION_TIMEOUT_MS: "1000",
});
const pool = new MonitoredPgPool({
  connectionString,
  ssl: false,
  max: config.max,
  connectionTimeoutMillis: config.connectionTimeoutMillis,
  query_timeout: config.queryTimeoutMillis,
  statement_timeout: config.statementTimeoutMillis,
  idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMillis,
  idleTimeoutMillis: config.idleTimeoutMillis,
  maxLifetimeSeconds: config.maxLifetimeSeconds,
}, config);
let unexpectedPoolError = null;
pool.on("error", (error) => {
  unexpectedPoolError = error;
});

let heldClient = null;
let transactionClient = null;
try {
  heldClient = await pool.connect();
  const saturationStartedAt = performance.now();
  await assert.rejects(
    pool.connect(),
    /timeout exceeded when trying to connect|connection terminated due to connection timeout/iu,
  );
  const saturationWaitMs = performance.now() - saturationStartedAt;
  assert.ok(saturationWaitMs >= 100, "saturation timeout returned before the configured bound");
  assert.ok(saturationWaitMs < 2_000, "saturation wait was not bounded");
  heldClient.release();
  heldClient = null;

  transactionClient = await pool.connect();
  await transactionClient.query("begin");
  await assert.rejects(
    transactionClient.query("select pg_sleep(0.5)"),
    (error) => error instanceof Error && "code" in error && error.code === "57014",
  );
  await transactionClient.query("rollback");
  const recovery = await transactionClient.query("select 1 as ok");
  assert.equal(Number(recovery.rows[0]?.ok), 1);
  transactionClient.release();
  transactionClient = null;

  const snapshot = pool.auroraSnapshot();
  assert.equal(snapshot.metricsScope, "process");
  assert.equal(snapshot.acquireSamples, 3);
  assert.equal(snapshot.acquireTimeouts, 1);
  assert.equal(snapshot.acquireErrors, 1);
  assert.equal(snapshot.querySamples, 4);
  assert.equal(snapshot.queryTimeouts, 1);
  assert.equal(snapshot.queryErrors, 1);
  assert.ok(snapshot.slowQueries >= 1);
  assert.equal(snapshot.transactionSamples, 1);
  assert.equal(snapshot.activeTransactions, 0);
  assert.equal(snapshot.rolledBackTransactions, 1);
  assert.equal(snapshot.abandonedTransactions, 0);
  assert.equal(snapshot.transactionErrors, 0);
  assert.equal(unexpectedPoolError, null);

  console.log(JSON.stringify({
    ok: true,
    target: "local-disposable/aurora_e2e_real",
    checks: {
      acquireSaturationTimeout: true,
      statementTimeout: true,
      transactionRollback: true,
      connectionRecovery: true,
    },
    databasePool: snapshot,
  }, null, 2));
} finally {
  if (transactionClient) {
    await transactionClient.query("rollback").catch(() => undefined);
    transactionClient.release();
  }
  if (heldClient) heldClient.release();
  await pool.end().catch(() => undefined);
}
