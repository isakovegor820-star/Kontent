import { describe, expect, it } from "vitest";

import { resolveDatabasePoolConfig } from "./db-pool-config.mjs";

describe("database pool configuration", () => {
  it("keeps local/test defaults bounded while allowing explicit overrides", () => {
    expect(resolveDatabasePoolConfig({ NODE_ENV: "test" })).toEqual({
      role: "shared",
      max: 3,
      connectionTimeoutMillis: 2_000,
      queryTimeoutMillis: 30_000,
      statementTimeoutMillis: 30_000,
      idleInTransactionTimeoutMillis: 15_000,
      idleTimeoutMillis: 10_000,
      maxLifetimeSeconds: 300,
    });
    expect(resolveDatabasePoolConfig({
      NODE_ENV: "test",
      AURORA_RUNTIME_ROLE: "worker",
      AURORA_DB_POOL_MAX_WORKER: "7",
      AURORA_DB_CONNECTION_TIMEOUT_MS: "1500",
    })).toMatchObject({ role: "worker", max: 7, connectionTimeoutMillis: 1_500 });
  });

  it("requires an explicit web/worker connection budget in production", () => {
    expect(() => resolveDatabasePoolConfig({
      NODE_ENV: "production",
      AURORA_RUNTIME_ROLE: "web",
    })).toThrowError("database_pool_max_not_configured:web");
    expect(resolveDatabasePoolConfig({
      NODE_ENV: "production",
      AURORA_RUNTIME_ROLE: "worker",
      AURORA_DB_POOL_MAX: "5",
    })).toMatchObject({ role: "worker", max: 5 });
    expect(() => resolveDatabasePoolConfig({ NODE_ENV: "production" }))
      .toThrowError("database_pool_max_not_configured:shared");
  });

  it("rejects an unknown role instead of silently using the shared budget", () => {
    expect(() => resolveDatabasePoolConfig({
      NODE_ENV: "production",
      AURORA_RUNTIME_ROLE: "typo",
      AURORA_DB_POOL_MAX: "5",
    })).toThrowError("database_runtime_role_invalid");
  });

  it("rejects zero, negative, excessive and non-integer values", () => {
    for (const value of ["0", "-1", "101", "2.5", "many"]) {
      expect(() => resolveDatabasePoolConfig({
        NODE_ENV: "test",
        AURORA_DB_POOL_MAX: value,
      })).toThrowError("database_pool_max_invalid");
    }
  });
});
