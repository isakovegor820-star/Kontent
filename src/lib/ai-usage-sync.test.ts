import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AI_USAGE_POLL_MS,
  getAiUsageMetrics,
  parseAiUsageResponse,
  startAiUsagePolling,
} from "./ai-usage-sync";

describe("AI usage response honesty", () => {
  it("accepts only a confirmed, valid server counter", () => {
    expect(parseAiUsageResponse(true, { status: "ok", used: 12, limit: 30 })).toEqual({
      status: "ok",
      used: 12,
      limit: 30,
    });
    expect(parseAiUsageResponse(true, { used: 0, limit: 30 })).toEqual({ status: "unknown" });
    expect(parseAiUsageResponse(true, { status: "ok", used: -1, limit: 30 })).toEqual({
      status: "unknown",
    });
  });

  it("does not expose progress or remaining values while loading or unavailable", () => {
    expect(getAiUsageMetrics("loading", 0, 30)).toBeNull();
    expect(getAiUsageMetrics("unknown", 12, 30)).toBeNull();
    expect(getAiUsageMetrics("ok", 12, 30)).toMatchObject({
      left: 18,
      ratio: 0.4,
      exhausted: false,
    });
  });

  it("treats transport and 503 responses as unknown even if a number is present", () => {
    expect(parseAiUsageResponse(false, { status: "ok", used: 0, limit: 30 })).toEqual({
      status: "unknown",
    });
    expect(parseAiUsageResponse(false, null)).toEqual({ status: "unknown" });
  });
});

describe("AI usage tab polling", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("refreshes every open tab and stops cleanly on unmount", async () => {
    vi.useFakeTimers();
    const refresh = vi.fn(async () => {});
    const stop = startAiUsagePolling(refresh);

    await vi.advanceTimersByTimeAsync(AI_USAGE_POLL_MS * 2);
    expect(refresh).toHaveBeenCalledTimes(2);

    stop();
    await vi.advanceTimersByTimeAsync(AI_USAGE_POLL_MS);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
