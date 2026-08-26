import { describe, expect, it, vi } from "vitest";

import {
  enqueueKnowledgeIndex,
  knowledgeIndexJobId,
  reconcilePendingKnowledgeSources,
} from "./knowledge-index-queue.mjs";

describe("knowledge index queue", () => {
  it("uses one deterministic retryable job per source", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}) };

    await expect(enqueueKnowledgeIndex(queue, 42)).resolves.toEqual({
      jobId: "knowledge-source-42",
    });
    expect(knowledgeIndexJobId(42)).toBe("knowledge-source-42");
    expect(queue.add).toHaveBeenCalledWith(
      "knowledge-index",
      { sourceId: 42 },
      expect.objectContaining({
        jobId: "knowledge-source-42",
        attempts: 3,
        removeOnComplete: true,
        removeOnFail: true,
      }),
    );
  });

  it("requeues every pending source and keeps scanning after one Redis failure", async () => {
    const db = { query: vi.fn().mockResolvedValue({ rows: [{ id: 10 }, { id: 11 }] }) };
    const queue = {
      add: vi.fn()
        .mockRejectedValueOnce(new Error("redis offline"))
        .mockResolvedValueOnce({}),
    };

    await expect(reconcilePendingKnowledgeSources(db, queue, { limit: 50 })).resolves.toEqual({
      scanned: 2,
      accepted: 1,
      failed: 1,
    });
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining("status = 'pending'"), [50]);
    expect(queue.add).toHaveBeenCalledTimes(2);
  });
});
