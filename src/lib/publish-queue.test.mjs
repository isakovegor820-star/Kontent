import { describe, expect, it, vi } from "vitest";

import { enqueuePublishJob, publishJobId } from "./publish-queue.mjs";

describe("publishJobId", () => {
  it("builds a revision-bound deterministic id", () => {
    expect(publishJobId(42, 3)).toBe("post-42-r3");
  });

  it("rejects invalid identities", () => {
    expect(() => publishJobId(0, 1)).toThrow("post_id_invalid");
    expect(() => publishJobId(1, "x")).toThrow("schedule_revision_invalid");
  });
});

describe("enqueuePublishJob", () => {
  const scheduledAt = new Date("2099-01-01T00:00:00.000Z");

  it("adds the job and reports a fresh enqueue", async () => {
    const queue = {
      add: vi.fn(async () => ({ id: "post-7-r2" })),
      getJob: vi.fn(),
    };
    const result = await enqueuePublishJob(queue, { postId: 7, projectId: 11, scheduleRevision: 2 }, scheduledAt);
    expect(result).toEqual({ recovered: false, jobId: "post-7-r2" });
    expect(queue.add).toHaveBeenCalledWith(
      "publish",
      { postId: 7, projectId: 11, scheduleRevision: 2 },
      expect.objectContaining({ jobId: "post-7-r2", removeOnFail: 200 }),
    );
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it("treats an existing job as recovered instead of an error", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("job id post-7-r2 already exists"); }),
      getJob: vi.fn(async () => ({ id: "post-7-r2" })),
    };
    const result = await enqueuePublishJob(queue, { postId: 7, projectId: 11, scheduleRevision: 2 }, scheduledAt);
    expect(result).toEqual({ recovered: true, jobId: "post-7-r2" });
  });

  it("fails with PUBLISH_QUEUE_UNAVAILABLE when Redis confirms neither outcome", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("redis down"); }),
      getJob: vi.fn(async () => { throw new Error("redis down"); }),
    };
    await expect(
      enqueuePublishJob(queue, { postId: 7, projectId: 11, scheduleRevision: 2 }, scheduledAt),
    ).rejects.toMatchObject({ code: "PUBLISH_QUEUE_UNAVAILABLE" });
  });

  it("honors a custom jobId for reconciliation replays", async () => {
    const queue = {
      add: vi.fn(async () => ({ id: "post-7-r2-retry-reconcile" })),
      getJob: vi.fn(),
    };
    const result = await enqueuePublishJob(
      queue,
      { postId: 7, projectId: 11, scheduleRevision: 2 },
      scheduledAt,
      { jobId: "post-7-r2-retry-reconcile" },
    );
    expect(result.jobId).toBe("post-7-r2-retry-reconcile");
  });
});
