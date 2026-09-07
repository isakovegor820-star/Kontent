// Подключение к PostgreSQL через стандартный драйвер pg.
// Работает одинаково с любой базой: локальной, Neon или своим сервером —
// меняется только DATABASE_URL, код не трогаем (как требует ТЗ, «переезд дампом»).

import { type Pool } from "pg";

import { resolveDatabasePoolConfig } from "./db-pool-config.mjs";
import { DatabasePoolMonitor, type DatabasePoolSnapshot } from "./db-pool-monitor.mjs";
import { MonitoredPgPool } from "./monitored-pg-pool.mjs";

// Один пул на процесс. В serverless функции живут недолго, поэтому пул кэшируем
// на глобальном объекте — чтобы соседние вызовы переиспользовали соединения.
const globalForPg = globalThis as unknown as { auroraPool?: MonitoredPgPool };

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

  const pool = new MonitoredPgPool({
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
  return pool?.auroraSnapshot() ?? new DatabasePoolMonitor().snapshot(null, config);
}
