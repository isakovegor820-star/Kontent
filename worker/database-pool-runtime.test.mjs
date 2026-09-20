import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const source = await readFile(new URL("../worker.mjs", import.meta.url), "utf8");

describe("worker database pool runtime contract", () => {
  it("uses the shared monitored pool with worker-role limits and timeouts", () => {
    expect(source).toContain('process.env.AURORA_RUNTIME_ROLE = "worker"');
    expect(source).toContain('import { resolveDatabasePoolConfig } from "./src/lib/db-pool-config.mjs"');
    expect(source).toContain('import { MonitoredPgPool } from "./src/lib/monitored-pg-pool.mjs"');
    expect(source).toContain("const databasePoolConfig = resolveDatabasePoolConfig()");
    expect(source).toContain("const pool = new MonitoredPgPool({");
    expect(source).toContain("max: databasePoolConfig.max");
    expect(source).toContain("connectionTimeoutMillis: databasePoolConfig.connectionTimeoutMillis");
    expect(source).toContain("query_timeout: databasePoolConfig.queryTimeoutMillis");
    expect(source).toContain("statement_timeout: databasePoolConfig.statementTimeoutMillis");
    expect(source).toContain("idle_in_transaction_session_timeout: databasePoolConfig.idleInTransactionTimeoutMillis");
    expect(source).toContain("idleTimeoutMillis: databasePoolConfig.idleTimeoutMillis");
    expect(source).toContain("maxLifetimeSeconds: databasePoolConfig.maxLifetimeSeconds");
    expect(source).toContain('console.log("[worker] database pool snapshot", pool.auroraSnapshot())');
    expect(source).toContain("clearInterval(workerDatabasePoolReportTimer)");
    expect(source).not.toContain("new pg.Pool(");
  });
});
