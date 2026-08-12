import { describe, expect, it, vi } from "vitest";

import {
  enqueueMediaGeneration,
  hasMediaWorker,
  MediaQueueUnavailableError,
  redisProducerConnectionOptions,
} from "./queue";

const data = {
  generationId: 41,
  projectId: 23,
  requestId: "11111111-1111-4111-8111-111111111111",
  requestKey: "media_client_key_1234",
  providerRequestKey: "aurora-media-11111111-1111-4111-8111-111111111111",
};

describe("media queue producer safety", () => {
  it("keeps the logical Redis database aligned with the full worker URL", () => {
    expect(redisProducerConnectionOptions("redis://user:p%40ss@127.0.0.1:6380/15"))
      .toMatchObject({ host: "127.0.0.1", port: 6380, username: "user", password: "p@ss", db: 15 });
    expect(redisProducerConnectionOptions("rediss://redis.example.test/0"))
      .toMatchObject({ db: 0, tls: {} });
    expect(() => redisProducerConnectionOptions("redis://127.0.0.1/not-a-db"))
      .toThrow(/database/u);
    expect(() => redisProducerConnectionOptions("http://127.0.0.1/15"))
      .toThrow(/redis:\/\//u);
  });

  it("fails closed when no full media worker is registered", async () => {
    await expect(hasMediaWorker({ getWorkersCount: vi.fn(async () => 0) } as never, 25))
      .resolves.toBe(false);
    await expect(hasMediaWorker({ getWorkersCount: vi.fn(async () => 1) } as never, 25))
      .resolves.toBe(true);
  });

  it("bounds a producer Redis hang", async () => {
    const never = new Promise<number>(() => {});
    await expect(hasMediaWorker({ getWorkersCount: vi.fn(() => never) } as never, 5))
      .resolves.toBe(false);
  });

  it("recovers an accepted job when Queue.add loses its acknowledgement", async () => {
    const queue = {
      add: vi.fn(async () => { throw new Error("ack lost"); }),
      getJob: vi.fn(async () => ({ id: "media-41" })),
    };
    await expect(enqueueMediaGeneration(data, queue as never, 25)).resolves.toEqual({
      recovered: true,
      jobId: "media-41",
    });
  });

  it("reports an unverifiable add outcome without authorizing the worker claim", async () => {
    const queue = {
      add: vi.fn(() => new Promise(() => {})),
      getJob: vi.fn(async () => null),
    };
    await expect(enqueueMediaGeneration(data, queue as never, 5))
      .rejects.toBeInstanceOf(MediaQueueUnavailableError);
  });

  it("rejects a job without a valid project boundary before touching Redis", async () => {
    const queue = {
      add: vi.fn(),
      getJob: vi.fn(),
    };

    await expect(enqueueMediaGeneration(
      { ...data, projectId: 0 },
      queue as never,
      25,
    )).rejects.toThrow("media queue project is required");
    expect(queue.add).not.toHaveBeenCalled();
    expect(queue.getJob).not.toHaveBeenCalled();
  });
});
