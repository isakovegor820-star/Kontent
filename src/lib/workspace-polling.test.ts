import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKSPACE_POLL_MS,
  isWorkspacePollingRoute,
  startVisibleWorkspacePolling,
  type WorkspaceVisibilitySource,
} from "./workspace-polling";

function visibilityHarness(initiallyHidden = false) {
  let hidden = initiallyHidden;
  const listeners = new Set<() => void>();
  const visibility: WorkspaceVisibilitySource = {
    get hidden() {
      return hidden;
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };

  return {
    visibility,
    setHidden(next: boolean) {
      hidden = next;
      listeners.forEach((listener) => listener());
    },
    listenerCount: () => listeners.size,
  };
}

describe("workspace polling route scope", () => {
  it("matches only the authenticated product route tree", () => {
    expect(isWorkspacePollingRoute("/app")).toBe(true);
    expect(isWorkspacePollingRoute("/app/opportunities")).toBe(true);
    expect(isWorkspacePollingRoute("/")).toBe(false);
    expect(isWorkspacePollingRoute("/login")).toBe(false);
    expect(isWorkspacePollingRoute("/application")).toBe(false);
  });
});

describe("visible workspace polling", () => {
  afterEach(() => vi.useRealTimers());

  it("refreshes immediately, pauses while hidden, and resumes without duplicate timers", async () => {
    vi.useFakeTimers();
    const harness = visibilityHarness();
    const refreshReal = vi.fn(async () => {});
    const refreshAiUsage = vi.fn(async () => {});
    const stop = startVisibleWorkspacePolling({
      refreshReal,
      refreshAiUsage,
      visibility: harness.visibility,
    });

    expect(refreshReal).toHaveBeenCalledTimes(1);
    expect(refreshAiUsage).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(refreshReal).toHaveBeenCalledTimes(2);
    expect(refreshAiUsage).toHaveBeenCalledTimes(2);

    harness.setHidden(true);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 2);
    expect(refreshReal).toHaveBeenCalledTimes(2);
    expect(refreshAiUsage).toHaveBeenCalledTimes(2);

    harness.setHidden(false);
    expect(refreshReal).toHaveBeenCalledTimes(3);
    expect(refreshAiUsage).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(refreshReal).toHaveBeenCalledTimes(4);
    expect(refreshAiUsage).toHaveBeenCalledTimes(4);

    stop();
    expect(harness.listenerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(refreshReal).toHaveBeenCalledTimes(4);
  });

  it("does not perform an initial request while the tab is hidden", () => {
    const harness = visibilityHarness(true);
    const refreshReal = vi.fn();
    const refreshAiUsage = vi.fn();
    const stop = startVisibleWorkspacePolling({
      refreshReal,
      refreshAiUsage,
      visibility: harness.visibility,
    });

    expect(refreshReal).not.toHaveBeenCalled();
    expect(refreshAiUsage).not.toHaveBeenCalled();
    stop();
  });
});
