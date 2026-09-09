// BullMQ CLIENT LIST is server-wide: queue names alone do not identify a Redis DB.
function databaseNumber(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !/^\d+$/u.test(value))) {
    throw new Error("queue_worker_database_unavailable");
  }
  const database = Number(value);
  if (!Number.isSafeInteger(database) || database < 0) {
    throw new Error("queue_worker_database_unavailable");
  }
  return database;
}

export async function countQueueWorkersForDatabase(queue) {
  // Read the actual queue connection, not a separately parsed global environment.
  const client = await queue.client;
  const database = databaseNumber(client?.options?.db);
  const workers = await queue.getWorkers();
  if (!Array.isArray(workers)) throw new Error("queue_worker_database_unavailable");
  const databases = workers.map(worker => databaseNumber(worker?.db));
  return databases.filter(workerDatabase => workerDatabase === database).length;
}

export async function hasQueueWorker(queue, timeoutMs = 1_500) {
  let timer;
  try {
    return (await Promise.race([
      countQueueWorkersForDatabase(queue),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("queue_worker_probe_timeout")), timeoutMs);
      }),
    ])) > 0;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
