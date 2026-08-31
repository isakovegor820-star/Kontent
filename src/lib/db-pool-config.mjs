const RUNTIME_ROLES = new Set(["web", "worker", "shared"]);

const DEFAULTS = Object.freeze({
  max: 3,
  connectionTimeoutMillis: 2_000,
  queryTimeoutMillis: 30_000,
  statementTimeoutMillis: 30_000,
  idleInTransactionTimeoutMillis: 15_000,
  idleTimeoutMillis: 10_000,
  maxLifetimeSeconds: 300,
});

function boundedInteger(value, fallback, bounds, name) {
  if (value == null || String(value).trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < bounds.min || parsed > bounds.max) {
    throw new Error(`${name}_invalid`);
  }
  return parsed;
}

function runtimeRole(value) {
  const role = String(value || "shared").trim().toLowerCase();
  if (!RUNTIME_ROLES.has(role)) throw new Error("database_runtime_role_invalid");
  return role;
}

export function resolveDatabasePoolConfig(env = process.env) {
  const role = runtimeRole(env.AURORA_RUNTIME_ROLE);
  const roleMaxName = role === "web"
    ? "AURORA_DB_POOL_MAX_WEB"
    : role === "worker"
      ? "AURORA_DB_POOL_MAX_WORKER"
      : "AURORA_DB_POOL_MAX";
  const configuredMax = env[roleMaxName] || env.AURORA_DB_POOL_MAX;
  if (env.NODE_ENV === "production" && !String(configuredMax || "").trim()) {
    throw new Error(`database_pool_max_not_configured:${role}`);
  }

  return Object.freeze({
    role,
    max: boundedInteger(configuredMax, DEFAULTS.max, { min: 1, max: 100 }, "database_pool_max"),
    connectionTimeoutMillis: boundedInteger(
      env.AURORA_DB_CONNECTION_TIMEOUT_MS,
      DEFAULTS.connectionTimeoutMillis,
      { min: 100, max: 60_000 },
      "database_connection_timeout",
    ),
    queryTimeoutMillis: boundedInteger(
      env.AURORA_DB_QUERY_TIMEOUT_MS,
      DEFAULTS.queryTimeoutMillis,
      { min: 250, max: 300_000 },
      "database_query_timeout",
    ),
    statementTimeoutMillis: boundedInteger(
      env.AURORA_DB_STATEMENT_TIMEOUT_MS,
      DEFAULTS.statementTimeoutMillis,
      { min: 250, max: 300_000 },
      "database_statement_timeout",
    ),
    idleInTransactionTimeoutMillis: boundedInteger(
      env.AURORA_DB_IDLE_TRANSACTION_TIMEOUT_MS,
      DEFAULTS.idleInTransactionTimeoutMillis,
      { min: 250, max: 300_000 },
      "database_idle_transaction_timeout",
    ),
    idleTimeoutMillis: boundedInteger(
      env.AURORA_DB_IDLE_TIMEOUT_MS,
      DEFAULTS.idleTimeoutMillis,
      { min: 1_000, max: 300_000 },
      "database_idle_timeout",
    ),
    maxLifetimeSeconds: boundedInteger(
      env.AURORA_DB_MAX_LIFETIME_SECONDS,
      DEFAULTS.maxLifetimeSeconds,
      { min: 30, max: 3_600 },
      "database_max_lifetime",
    ),
  });
}
