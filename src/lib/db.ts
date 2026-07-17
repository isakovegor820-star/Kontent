// Подключение к PostgreSQL через стандартный драйвер pg.
// Работает одинаково с любой базой: локальной, Neon или своим сервером —
// меняется только DATABASE_URL, код не трогаем (как требует ТЗ, «переезд дампом»).

import { Pool } from "pg";

// Один пул на процесс. В serverless функции живут недолго, поэтому пул кэшируем
// на глобальном объекте — чтобы соседние вызовы переиспользовали соединения.
const globalForPg = globalThis as unknown as { auroraPool?: Pool };

export function getPool(): Pool {
  if (globalForPg.auroraPool) return globalForPg.auroraPool;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL не задан");

  // Локальная база идёт без SSL; удалённая (Neon/свой сервер) — с SSL.
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(connectionString);

  const pool = new Pool({
    connectionString,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 3, // бесплатным тарифам хватает; не упираемся в лимит соединений
  });

  globalForPg.auroraPool = pool;
  return pool;
}
