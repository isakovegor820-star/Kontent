export type DatabaseRuntimeRole = "web" | "worker" | "shared";

export type DatabasePoolConfig = Readonly<{
  role: DatabaseRuntimeRole;
  max: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
  slowQueryThresholdMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionTimeoutMillis: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
}>;

export function resolveDatabasePoolConfig(env?: NodeJS.ProcessEnv): DatabasePoolConfig;

export const PGSSL_INSECURE_CONFIRMATION: "I_ACCEPT_MITM_RISK";

export function resolvePgSslRejectUnauthorized(env?: NodeJS.ProcessEnv): boolean;
