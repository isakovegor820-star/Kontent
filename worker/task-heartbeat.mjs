import { heartbeatWorkerAiUsage, WORKER_AI_RESERVATION_TTL_MS } from "./ai-usage-reservation.mjs";

const TABLES = new Set(["media_generations", "site_articles", "site_profiles", "site_reports"]);
export const TASK_STALE_MS = 120_000;

export class WorkerTaskLeaseLost extends Error {
  constructor() {
    super("Фоновая задача передана другому обработчику. Результат старой попытки не сохранён.");
    this.name = "WorkerTaskLeaseLost";
    this.code = "worker_lease_lost";
  }
}

/** Lock the ownership row before every terminal write, including quota finalization. */
export async function ownedTaskTransaction(pool, { table, id, token }, task) {
  if (!TABLES.has(table)) throw new TypeError("invalid_worker_task_table");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const locked = await client.query(`select worker_lease_token from ${table} where id = $1 for update`, [id]);
    if (locked.rows[0]?.worker_lease_token !== token) throw new WorkerTaskLeaseLost();
    const result = await task(client);
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Heartbeats use short transactions; no pool connection is held during provider I/O.
 * @param {any} pool
 * @param {{table: string, id: number|string, token: string}} identity
 * @param {{userId?: number|string|null, reservationId?: number|string|null, ttlMs?: number, intervalMs?: number}} options
 */
export async function startTaskHeartbeat(pool, identity, { userId = null, reservationId = null, ttlMs = WORKER_AI_RESERVATION_TTL_MS, intervalMs = 5_000 } = {}) {
  const controller = new AbortController();
  let inFlight = null;
  let lost = null;
  const pulse = () => {
    if (lost) return Promise.reject(lost);
    if (inFlight) return inFlight;
    inFlight = ownedTaskTransaction(pool, identity, async (client) => {
      await client.query(`update ${identity.table} set worker_heartbeat_at = now() where id = $1`, [identity.id]);
      if (reservationId && !await heartbeatWorkerAiUsage(client, userId, reservationId, ttlMs)) throw new WorkerTaskLeaseLost();
    }).catch((error) => {
      lost = error instanceof WorkerTaskLeaseLost ? error : new WorkerTaskLeaseLost();
      controller.abort(lost);
      throw lost;
    }).finally(() => { inFlight = null; });
    return inFlight;
  };
  await pulse();
  const timer = setInterval(() => { void pulse().catch(() => undefined); }, Math.max(100, Math.min(intervalMs, ttlMs / 3)));
  timer.unref?.();
  return {
    signal: controller.signal,
    checkpoint: pulse,
    assertActive: pulse,
    async stop() { clearInterval(timer); await inFlight?.catch(() => undefined); },
  };
}
