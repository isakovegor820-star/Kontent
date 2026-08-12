import { describe, expect, it, vi } from "vitest";

import {
  enqueueProjectExportJob,
  hasProjectExportWorker,
  projectExportJobId,
  ProjectExportQueueUnavailableError,
} from "./project-export-queue.mjs";

const data = { operationId: 41, projectId: 7, snapshotHash: "a".repeat(64) };

describe("project export queue", () => {
  it("uses one deterministic BullMQ identity and bounded retries", async () => {
    const queue = { add: vi.fn(async () => ({})), getJob: vi.fn() };
    await expect(enqueueProjectExportJob(data, queue)).resolves.toEqual({
      jobId: "project-export-41",
      recovered: false,
    });
    expect(queue.add).toHaveBeenCalledWith("render", data, expect.objectContaining({
      jobId: "project-export-41",
      attempts: 3,
      removeOnComplete: 100,
      removeOnFail: 200,
    }));
    expect(projectExportJobId(41)).toBe("project-export-41");
  });

  it("recovers an accepted job after a lost Redis acknowledgement", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("ack lost"); }),
      getJob: vi.fn(async () => ({ id: "project-export-41" })),
    };
    await expect(enqueueProjectExportJob(data, queue)).resolves.toEqual({
      jobId: "project-export-41",
      recovered: true,
    });
  });

  it("keeps the durable outbox authoritative when queue outcome is unknown", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("offline"); }),
      getJob: vi.fn(async () => { throw new Error("offline"); }),
    };
    await expect(enqueueProjectExportJob(data, queue)).rejects.toBeInstanceOf(ProjectExportQueueUnavailableError);
    await expect(hasProjectExportWorker({ getWorkersCount: vi.fn(async () => 0) })).resolves.toBe(false);
    await expect(hasProjectExportWorker({ getWorkersCount: vi.fn(async () => 1) })).resolves.toBe(true);
  });
});
