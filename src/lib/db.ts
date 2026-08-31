// Подключение к PostgreSQL через стандартный драйвер pg.
// Работает одинаково с любой базой: локальной, Neon или своим сервером —
// меняется только DATABASE_URL, код не трогаем (как требует ТЗ, «переезд дампом»).

import { Pool, type PoolClient } from "pg";

import { resolveDatabasePoolConfig, type DatabasePoolConfig } from "./db-pool-config.mjs";
import { DatabasePoolMonitor, type DatabasePoolSnapshot } from "./db-pool-monitor.mjs";

// Один пул на процесс. В serverless функции живут недолго, поэтому пул кэшируем
// на глобальном объекте — чтобы соседние вызовы переиспользовали соединения.
type PoolConnectCallback = (
  error: Error | undefined,
  client: PoolClient | undefined,
  done: (release?: unknown) => void,
) => void;

class MonitoredPool extends Pool {
  readonly monitor: DatabasePoolMonitor;
  readonly auroraConfig: DatabasePoolConfig;

  constructor(config: ConstructorParameters<typeof Pool>[0], auroraConfig: DatabasePoolConfig) {
    super(config);
    this.auroraConfig = auroraConfig;
    this.monitor = new DatabasePoolMonitor();
  }

  override connect(): Promise<PoolClient>;
  override connect(callback: PoolConnectCallback): void;
  override connect(callback?: PoolConnectCallback): Promise<PoolClient> | void {
    const startedAt = performance.now();
    if (callback) {
      return super.connect((error, client, done) => {
        this.monitor.recordAcquire(performance.now() - startedAt, error);
        callback(error, client, done);
      });
    }
    return super.connect().then(
      (client) => {
        this.monitor.recordAcquire(performance.now() - startedAt);
        return client;
      },
      (error: unknown) => {
        this.monitor.recordAcquire(performance.now() - startedAt, error);
        throw error;
      },
    );
  }
}

const globalForPg = globalThis as unknown as { auroraPool?: MonitoredPool };

export function getPool(): Pool {
  if (globalForPg.auroraPool) return globalForPg.auroraPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL не задан");

  // Локальная база идёт без SSL; удалённая (Neon/свой сервер) — с SSL.
  const isLocal = /\/\/(?:[^@/]+@)?(?:localhost|127\.0\.0\.1)(?::|\/)/.test(connectionString);

  // По умолчанию проверяем сертификат хоста (защита от MITM). Аварийный выход —
  // PGSSL_REJECT_UNAUTHORIZED=false, если cert-chain хоста не доверен Node. Neon использует
  // сертификаты Amazon Trust Services/Let's Encrypt (в стандартном CA-бандле), так что true работает.
  const sslRejectUnauthorized = process.env.PGSSL_REJECT_UNAUTHORIZED !== "false";
  const config = resolveDatabasePoolConfig();

  const pool = new MonitoredPool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: sslRejectUnauthorized },
    max: config.max,
    connectionTimeoutMillis: config.connectionTimeoutMillis,
    query_timeout: config.queryTimeoutMillis,
    statement_timeout: config.statementTimeoutMillis,
    idle_in_transaction_session_timeout: config.idleInTransactionTimeoutMillis,
    idleTimeoutMillis: config.idleTimeoutMillis,
    maxLifetimeSeconds: config.maxLifetimeSeconds,
  }, config);

  globalForPg.auroraPool = pool;
  return pool;
}

export function getDatabasePoolSnapshot(): DatabasePoolSnapshot {
  const pool = globalForPg.auroraPool;
  const config = pool?.auroraConfig ?? resolveDatabasePoolConfig();
  const monitor = pool?.monitor ?? new DatabasePoolMonitor();
  return monitor.snapshot(pool ?? null, config);
}
