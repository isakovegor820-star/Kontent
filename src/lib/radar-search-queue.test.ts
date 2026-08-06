import { describe, expect, it, vi } from "vitest";

import { enqueueRadarSearch, RadarSearchQueueUnavailableError } from "./radar-search-queue";

describe("radar search queue", () => {
  it("uses a deterministic job id so one run cannot be queued twice", async () => {
    const queue = { add: vi.fn().mockResolvedValue({}), getJob: vi.fn() };
    await expect(enqueueRadarSearch({ runId: 42, userId: 7 }, queue as never)).resolves.toEqual({
      jobId: "radar-search-42",
      recovered: false,
    });
    expect(queue.add).toHaveBeenCalledWith(
      "radar-search",
      { runId: 42, userId: 7 },
      expect.objectContaining({ jobId: "radar-search-42", attempts: 2 }),
    );
  });

  it("recovers when Redis accepted the job but lost the acknowledgement", async () => {
    const queue = {
      add: vi.fn().mockRejectedValue(new Error("timeout")),
      getJob: vi.fn().mockResolvedValue({ id: "radar-search-42" }),
    };
    await expect(enqueueRadarSearch({ runId: 42, userId: 7 }, queue as never)).resolves.toEqual({
      jobId: "radar-search-42",
      recovered: true,
    });
  });

  it("fails explicitly when the queue did not accept the run", async () => {
    const queue = {
      add: vi.fn().mockRejectedValue(new Error("offline")),
      getJob: vi.fn().mockResolvedValue(null),
    };
    await expect(enqueueRadarSearch({ runId: 42, userId: 7 }, queue as never))
      .rejects.toBeInstanceOf(RadarSearchQueueUnavailableError);
  });
});

