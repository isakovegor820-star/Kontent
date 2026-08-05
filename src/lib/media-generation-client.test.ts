import { describe, expect, it, vi } from "vitest";

import {
  mediaElapsedLabel,
  shouldRetainMediaRequestKey,
  startImmediateMediaPolling,
} from "./media-generation-client";

describe("media generation client coordination", () => {
  it("polls immediately before waiting for the first interval", async () => {
    vi.useFakeTimers();
    const poll = vi.fn(async () => {});
    const stop = startImmediateMediaPolling(poll, 3_000, {
      setInterval: globalThis.setInterval,
      clearInterval: globalThis.clearInterval,
    });

    await Promise.resolve();
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(2_999);
    expect(poll).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(2);
    stop();
    vi.useRealTimers();
  });

  it("retains the stable key on 5xx and in-progress outcomes", () => {
    expect(shouldRetainMediaRequestKey(500, "server")).toBe(true);
    expect(shouldRetainMediaRequestKey(503, "queue_unavailable")).toBe(true);
    expect(shouldRetainMediaRequestKey(409, "request_in_progress")).toBe(true);
    expect(shouldRetainMediaRequestKey(422, "short_prompt")).toBe(false);
  });

  it("formats elapsed generation time", () => {
    expect(mediaElapsedLabel("2026-08-05T10:00:00.000Z", Date.parse("2026-08-05T10:01:07.000Z")))
      .toBe("1:07");
  });
});
