import { afterEach, describe, expect, it, vi } from "vitest";

import { AiClientStreamTimeoutError, readAiStreamWithDeadline } from "./ai-stream-reader";

describe("AI client stream deadline", () => {
  afterEach(() => vi.useRealTimers());

  it("finishes a normal stream and forwards every chunk", async () => {
    const chunks = [new Uint8Array([1]), new Uint8Array([2])];
    const reader = {
      read: vi.fn()
        .mockResolvedValueOnce({ done: false, value: chunks[0] })
        .mockResolvedValueOnce({ done: false, value: chunks[1] })
        .mockResolvedValueOnce({ done: true, value: undefined }),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const seen: Uint8Array[] = [];

    await readAiStreamWithDeadline({
      reader,
      onChunk: (chunk) => seen.push(chunk),
      idleTimeoutMs: 100,
      overallTimeoutMs: 1_000,
    });

    expect(seen).toEqual(chunks);
  });

  it("rejects a stalled stream instead of leaving the UI busy forever", async () => {
    vi.useFakeTimers();
    const reader = {
      read: vi.fn(() => new Promise(() => {})),
    } as unknown as ReadableStreamDefaultReader<Uint8Array>;
    const pending = readAiStreamWithDeadline({
      reader,
      onChunk: () => {},
      idleTimeoutMs: 50,
      overallTimeoutMs: 500,
    });
    const rejected = expect(pending).rejects.toBeInstanceOf(AiClientStreamTimeoutError);

    await vi.advanceTimersByTimeAsync(50);
    await rejected;
  });
});
