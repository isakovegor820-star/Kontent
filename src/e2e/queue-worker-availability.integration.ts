import { randomUUID } from "node:crypto";
import { Queue, Worker } from "bullmq";
import type { RedisOptions } from "ioredis";
import { describe, expect, it, vi } from "vitest";
import { hasMediaWorker, hasAutopilotWorker, redisProducerConnectionOptions } from "@/lib/queue";
import { hasSiteAnalysisWorker } from "@/lib/site-analysis-queue";
import { hasSiteArticlesWorker } from "@/lib/site-articles-queue";
import { hasProjectExportWorker } from "@/lib/project-export-queue.mjs";
import { hasLegalVisualRenderWorker } from "@/lib/legal-visual-render-queue.mjs";
import { countQueueWorkersForDatabase } from "@/lib/queue-worker-availability.mjs";

const value = String(process.env.QUEUE_WORKER_TEST_REDIS_URL || "").trim();
const target = value ? new URL(value) : null;
if (!target || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || target.protocol !== "redis:" || target.pathname !== "/12") {
  throw new Error("Requires explicit isolated loopback QUEUE_WORKER_TEST_REDIS_URL logical database 12; foreign control uses 13");
}
const producer = redisProducerConnectionOptions(value) as RedisOptions;
const workerConnection = { ...producer, maxRetriesPerRequest: null, enableOfflineQueue: true };
const probes = [hasMediaWorker, hasAutopilotWorker, hasSiteAnalysisWorker, hasSiteArticlesWorker, hasProjectExportWorker, hasLegalVisualRenderWorker];

// Fresh queue identities make the proof independent of other suites using the same
// Redis server. Cleanup owns these exact empty namespaces, never another suite's DB.
describe.each(probes)("real Redis database boundary %s", (probe) => {
  it("ignores foreign-database and unrelated workers, then recognizes its own worker", async () => {
    const name = `n46-${randomUUID()}`;
    const own = new Queue(name, { connection: producer });
    const foreign = new Queue(name, { connection: { ...producer, db: 13 } });
    const unrelated = new Queue(`${name}-unrelated`, { connection: producer });
    const queues = [own, foreign, unrelated];
    const workers: Worker<unknown, unknown>[] = [];
    let attemptedJobs = 0;
    const refuseUnexpectedJob = async () => { attemptedJobs += 1; throw new Error("No external job is authorized in the readiness fixture"); };
    try {
      await Promise.all(queues.map(queue => queue.waitUntilReady()));
      expect(await probe(own)).toBe(false);
      expect(await countQueueWorkersForDatabase(own)).toBe(0);
      expect(await own.getWorkersCount()).toBe(0);

      const unrelatedWorker = new Worker<unknown, unknown>(`${name}-unrelated`, refuseUnexpectedJob, { connection: workerConnection });
      workers.push(unrelatedWorker); await unrelatedWorker.waitUntilReady();
      await vi.waitFor(async () => { expect(await countQueueWorkersForDatabase(unrelated)).toBe(1); }, { timeout: 3000 });
      expect(await probe(own)).toBe(false);

      const foreignWorker = new Worker<unknown, unknown>(name, refuseUnexpectedJob, { connection: { ...workerConnection, db: 13 } });
      workers.push(foreignWorker); await foreignWorker.waitUntilReady();
      await vi.waitFor(async () => { expect(await countQueueWorkersForDatabase(foreign)).toBe(1); }, { timeout: 3000 });
      expect(await probe(own)).toBe(false);
      expect(await countQueueWorkersForDatabase(own)).toBe(0);
      expect(await own.getWorkersCount()).toBe(1);

      const ownWorker = new Worker<unknown, unknown>(name, refuseUnexpectedJob, { connection: workerConnection });
      workers.push(ownWorker); await ownWorker.waitUntilReady();
      await vi.waitFor(async () => { expect(await countQueueWorkersForDatabase(own)).toBe(1); }, { timeout: 3000 });
      expect(await probe(own)).toBe(true);
      expect(await own.getWorkersCount()).toBe(2);
      expect(attemptedJobs).toBe(0);
    } finally {
      await Promise.all(workers.map(worker => worker.close()));
      for (const queue of queues) {
        try {
          const counts = await queue.getJobCounts("wait", "active", "delayed", "prioritized", "paused", "waiting-children", "completed", "failed");
          expect(Object.values(counts).every(count => count === 0)).toBe(true);
          await queue.obliterate({ force: false });
          const client = await queue.client;
          let cursor = "0";
          do {
            const [next, keys] = await client.scan(cursor, { MATCH: `${queue.qualifiedName}:*`, COUNT: 100 });
            expect(keys).toEqual([]);
            cursor = next;
          } while (cursor !== "0");
        } finally { await queue.close(); }
      }
      expect(attemptedJobs).toBe(0);
    }
  });
});
