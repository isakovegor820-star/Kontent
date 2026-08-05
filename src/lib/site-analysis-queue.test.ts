import { describe, expect, it, vi } from "vitest";

import {
  SiteAnalysisQueueUnavailableError,
  enqueueSiteAnalysis,
  hasSiteAnalysisWorker,
} from "./site-analysis-queue";
import { redisProducerConnectionOptions } from "./queue";

describe("site analysis queue boundary", () => {
  it("uses the same Redis logical database parser as the media/publication producers", () => {
    expect(redisProducerConnectionOptions("redis://127.0.0.1:6379/15").db).toBe(15);
  });

  it("fails closed when no full worker is present", async () => {
    expect(await hasSiteAnalysisWorker({ getWorkersCount: vi.fn().mockResolvedValue(0) } as never))
      .toBe(false);
    expect(await hasSiteAnalysisWorker({ getWorkersCount: vi.fn().mockResolvedValue(1) } as never))
      .toBe(true);
  });

  it("uses a deterministic revision-bound BullMQ identity", async () => {
    const add = vi.fn().mockResolvedValue({ id: "accepted" });
    const result = await enqueueSiteAnalysis(
      { analysisId: 41, requestId: "req-41", runRevision: 3 },
      { add, getJob: vi.fn() } as never,
    );
    expect(result).toEqual({ recovered: false, jobId: "site-analysis-41-r3" });
    expect(add).toHaveBeenCalledWith("analyze", expect.objectContaining({ analysisId: 41 }), expect.objectContaining({
      jobId: "site-analysis-41-r3",
      delay: 1_000,
      attempts: 2,
      backoff: { type: "exponential", delay: 15_000 },
    }));
  });

  it("recovers an accepted job after a lost ACK and rejects an ambiguous enqueue", async () => {
    const data = { analysisId: 9, requestId: "req-9", runRevision: 1 };
    const recovered = await enqueueSiteAnalysis(data, {
      add: vi.fn().mockRejectedValue(new Error("ack_lost")),
      getJob: vi.fn().mockResolvedValue({ id: "site-analysis-9-r1" }),
    } as never);
    expect(recovered.recovered).toBe(true);

    await expect(enqueueSiteAnalysis(data, {
      add: vi.fn().mockRejectedValue(new Error("offline")),
      getJob: vi.fn().mockResolvedValue(null),
    } as never)).rejects.toBeInstanceOf(SiteAnalysisQueueUnavailableError);
  });
});
