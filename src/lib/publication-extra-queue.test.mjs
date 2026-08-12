import { describe, expect, it, vi } from "vitest";

import {
  PublicationExtraQueueUnavailableError,
  enqueuePublicationExtraJob,
  publicationExtraJobId,
} from "./publication-extra-queue.mjs";

const fingerprint = "a".repeat(64);

describe("publication extra queue", () => {
  it("uses a deterministic identity and project-scoped payload", async () => {
    const queue = { add: vi.fn(async () => ({})), getJob: vi.fn() };
    const result = await enqueuePublicationExtraJob({ operationId: 5, projectId: 7, fingerprint }, queue, 50);
    expect(result).toEqual({ jobId: `publication-extra-5-${"a".repeat(16)}`, recovered: false });
    expect(queue.add).toHaveBeenCalledWith(
      "execute",
      { operationId: 5, projectId: 7, fingerprint },
      expect.objectContaining({ jobId: publicationExtraJobId(5, fingerprint), attempts: 3 }),
    );
  });

  it("recovers an ambiguous add acknowledgement by deterministic job id", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("timeout"); }),
      getJob: vi.fn(async () => ({ id: publicationExtraJobId(5, fingerprint) })),
    };
    await expect(enqueuePublicationExtraJob({ operationId: 5, projectId: 7, fingerprint }, queue, 50))
      .resolves.toMatchObject({ recovered: true });
  });

  it("fails closed when neither add nor lookup confirms ownership", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("down"); }),
      getJob: vi.fn(async () => null),
    };
    await expect(enqueuePublicationExtraJob({ operationId: 5, projectId: 7, fingerprint }, queue, 50))
      .rejects.toBeInstanceOf(PublicationExtraQueueUnavailableError);
  });
});
