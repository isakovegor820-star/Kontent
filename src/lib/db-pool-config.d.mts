export type DatabaseRuntimeRole = "web" | "worker" | "shared";

export type DatabasePoolConfig = Readonly<{
  role: DatabaseRuntimeRole;
  max: number;
  connectionTimeoutMillis: number;
  queryTimeoutMillis: number;
  statementTimeoutMillis: number;
  idleInTransactionTimeoutMillis: number;
  idleTimeoutMillis: number;
  maxLifetimeSeconds: number;
}>;

export function resolveDatabasePoolConfig(env?: NodeJS.ProcessEnv): DatabasePoolConfig;
