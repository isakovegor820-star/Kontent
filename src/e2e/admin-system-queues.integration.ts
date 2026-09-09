import { Queue, Worker } from "bullmq";
import Redis from "ioredis";
import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { probeAdminQueues } from "@/lib/admin-system-diagnostics";

// A different logical DB from the full QA worker: no real publication processor
// can consume these jobs. No provider or publication code runs in this suite.
const url = process.env.SYSTEM_TEST_REDIS_URL || "";
const target = url ? new URL(url) : null;
if (!target || target.protocol !== "redis:" || !["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)
  || target.pathname !== "/8") throw new Error("Requires explicit disposable loopback SYSTEM_TEST_REDIS_URL logical database 8");
const connection = {
  host: target.hostname, port: Number(target.port || 6379), db: 8, maxRetriesPerRequest: null,
  username: target.username ? decodeURIComponent(target.username) : undefined,
  password: target.password ? decodeURIComponent(target.password) : undefined,
};
const queue = new Queue("publish", { connection });
const inspector = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 0, connectTimeout: 1500 });
let worker: Worker | undefined;
let initialKeys = new Set<string>();
let ownFixture = false;
async function snapshot() { return (await probeAdminQueues()).find(q => q.name === "publish")!; }
beforeAll(async () => {
  await queue.waitUntilReady();
  await inspector.connect();
  initialKeys = new Set(await inspector.keys("*"));
  expect([...initialKeys].every(key => /^bull:publish:(meta|id|events|marker)$/u.test(key))).toBe(true);
  expect((await queue.getWorkers()).filter(worker => Number(worker.db) === 8)).toHaveLength(0);
  const counts = await queue.getJobCounts("wait", "active", "delayed", "prioritized", "paused", "waiting-children", "completed", "failed");
  expect(Object.values(counts).every(count => count === 0)).toBe(true);
  ownFixture = true;
});
afterAll(async () => {
  await worker?.close();
  if (ownFixture) {
    await queue.resume();
    for (const job of await queue.getJobs(["wait", "active", "delayed", "prioritized", "paused", "waiting-children", "completed", "failed"], 0, -1)) await job.remove();
    const createdKeys = (await inspector.keys("*")).filter(key => !initialKeys.has(key));
    if (createdKeys.length) await inspector.del(...createdKeys);
  }
  await queue.close();
  inspector.disconnect();
  vi.unstubAllEnvs();
});

describe.sequential("monitoring against real BullMQ execution in isolated Redis", () => {
  it("observes an actual failed job, then execution recovery without deleting the failure", async () => {
    vi.stubEnv("REDIS_URL", url);
    worker = new Worker("publish", async job => {
      if (job.data.fail) throw new Error("synthetic_failure");
      return { synthetic: true };
    }, { connection });
    await worker.waitUntilReady();
    const failed = await queue.add("audit", { fail: true });
    await expect.poll(() => failed.getState()).toBe("failed");
    expect(await snapshot()).toMatchObject({ state: "degraded", safeErrorCode: "queue_recent_failure" });
    const recovered = await queue.add("audit", { fail: false });
    await expect.poll(() => recovered.getState()).toBe("completed");
    const result = await snapshot();
    expect(result.state).toBe("healthy");
    expect(result.failed).toBeGreaterThanOrEqual(1);
    expect(await failed.getState()).toBe("failed");
  });
  it("detects queue pause even after successful execution", async () => {
    await queue.pause();
    expect(await snapshot()).toMatchObject({ state: "degraded", paused: true, safeErrorCode: "queue_paused" });
    await queue.resume();
    expect((await snapshot()).state).toBe("healthy");
  });
  it("does not turn future scheduled work into an overdue wait", async () => {
    const job = await queue.add("audit-future", {}, { delay: 3_600_000 });
    expect(await snapshot()).toMatchObject({ state: "healthy", oldestJobAgeMs: null });
    await job.remove();
  });
  it("uses the actual next due time after retry backoff instead of the previous attempt timestamp", async () => {
    const job = await queue.add("audit-retry", { fail: true }, { attempts: 2, backoff: { type: "fixed", delay: 3_600_000 }, timestamp: Date.now() - 3_600_000 });
    await expect.poll(() => job.getState()).toBe("delayed");
    const result = (await probeAdminQueues(Date.now() + 6 * 60_000)).find(q => q.name === "publish")!;
    expect(result).toMatchObject({ state: "healthy", oldestJobAgeMs: null });
    await queue.pause();
    await job.promote();
    expect(await snapshot()).toMatchObject({ oldestJobAgeMs: null, unmeasuredWaitingJobs: 1 });
    await job.remove();
    await queue.resume();
  });
  it("detects pending work with no consumer", async () => {
    await worker!.close(); worker = undefined;
    const job = await queue.add("audit-pending", {});
    expect(await snapshot()).toMatchObject({ state: "down", safeErrorCode: "queue_worker_missing", workers: 0 });
    await job.remove();
  });
  it("bounds an unavailable Redis and preserves null counts instead of zero", async () => {
    // Own socket resets every connection; no guessed port can target another service.
    const refused = createServer(socket => socket.destroy());
    await new Promise<void>(resolve => refused.listen(0, "127.0.0.1", resolve));
    const address = refused.address();
    if (!address || typeof address === "string") throw new Error("missing isolated fault socket");
    try {
      vi.stubEnv("REDIS_URL", `redis://127.0.0.1:${address.port}/8`);
      const started = performance.now();
      expect(await snapshot()).toMatchObject({ state: "unavailable", waiting: null, failed: null, workers: null });
      expect(performance.now() - started).toBeLessThan(4000);
    } finally { await new Promise<void>(resolve => refused.close(() => resolve())); }
  });
});
