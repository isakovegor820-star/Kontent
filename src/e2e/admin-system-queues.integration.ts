import { Queue, Worker } from "bullmq";
import { afterAll, describe, expect, it, vi } from "vitest";
import { probeAdminQueues } from "@/lib/admin-system-diagnostics";

// A different logical DB from the full QA worker: no real publication processor
// can consume these jobs. No provider or publication code runs in this suite.
const url = process.env.SYSTEM_TEST_REDIS_URL || "";
if (url !== "redis://127.0.0.1:57642/1") throw new Error("Requires dedicated audit Redis logical DB 1");
const connection = { host: "127.0.0.1", port: 57642, db: 1, maxRetriesPerRequest: null };
const queue = new Queue("publish", { connection });
let worker: Worker | undefined;
async function snapshot() { return (await probeAdminQueues()).find(q => q.name === "publish")!; }
afterAll(async () => { await worker?.close(); await queue.close(); vi.unstubAllEnvs(); });

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
    vi.stubEnv("REDIS_URL", "redis://127.0.0.1:57644/1");
    const started = performance.now();
    expect(await snapshot()).toMatchObject({ state: "unavailable", waiting: null, failed: null, workers: null });
    expect(performance.now() - started).toBeLessThan(4000);
  });
});
