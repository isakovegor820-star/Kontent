import { createWorkspaceRequestFence } from "./client-workspace-isolation";
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
      lifecycle: new EventTarget(),
      cancelReads: vi.fn(),
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
      lifecycle: new EventTarget(),
      cancelReads: vi.fn(),
    });

    expect(refreshReal).not.toHaveBeenCalled();
    expect(refreshAiUsage).not.toHaveBeenCalled();
    stop();
  });
});


describe("pending polling read ownership", () => {
  afterEach(() => vi.useRealTimers());

  function pendingFixture() {
    const harness = visibilityHarness();
    const lifecycle = new EventTarget();
    const real = createWorkspaceRequestFence();
    const ai = createWorkspaceRequestFence();
    const tickets: ReturnType<typeof real.start>[] = [];
    const finish: Array<() => void> = [];
    let committed = 0;
    const refresh = (fence: typeof real) => () => {
      const ticket = fence.start("project:1"); tickets.push(ticket);
      return new Promise<void>(resolve => finish.push(resolve)).then(() => {
        if (fence.isCurrent(ticket, "project:1")) committed++;
      });
    };
    const cancelReads = vi.fn(() => { real.invalidate(); ai.invalidate(); });
    const add = vi.spyOn(lifecycle, "addEventListener");
    const remove = vi.spyOn(lifecycle, "removeEventListener");
    const stop = startVisibleWorkspacePolling({ visibility: harness.visibility, lifecycle,
      refreshReal: refresh(real), refreshAiUsage: refresh(ai), cancelReads });
    return { harness, lifecycle, tickets, finish, stop, add, remove, cancelReads, committed: () => committed };
  }

  it.each(["hidden", "dispose", "beforeunload"])("%s aborts owned reads and fences late successful responses", async mode => {
    vi.useFakeTimers(); const f = pendingFixture();
    if (mode === "hidden") f.harness.setHidden(true);
    else if (mode === "dispose") f.stop();
    else f.lifecycle.dispatchEvent(new Event("beforeunload", { cancelable: true }));
    expect(f.tickets.every(ticket => ticket.signal.aborted)).toBe(true);
    f.finish.forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0);
    expect(f.committed()).toBe(0); f.stop();
  });

  it("only subscribes to beforeunload while an owned refresh is pending", async () => {
    vi.useFakeTimers(); const f = pendingFixture();
    expect(f.add).toHaveBeenCalledTimes(1);
    expect(f.add.mock.calls[0][0]).toBe("beforeunload");
    f.finish[0](); await vi.advanceTimersByTimeAsync(0);
    expect(f.remove).not.toHaveBeenCalled();
    f.finish[1](); await vi.advanceTimersByTimeAsync(0);
    expect(f.remove).toHaveBeenCalledTimes(1);
    expect(f.committed()).toBe(2);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(f.add).toHaveBeenCalledTimes(2);
    f.stop(); expect(f.remove).toHaveBeenCalledTimes(2);
  });

  it("does not prompt or disable future refreshes if navigation is cancelled", async () => {
    vi.useFakeTimers(); const f = pendingFixture();
    const event = new Event("beforeunload", { cancelable: true });
    expect(f.lifecycle.dispatchEvent(event)).toBe(true); expect(event.defaultPrevented).toBe(false);
    expect(f.tickets.every(ticket => ticket.signal.aborted)).toBe(true);
    f.finish.forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(f.tickets).toHaveLength(4); expect(f.tickets.slice(2).every(ticket => !ticket.signal.aborted)).toBe(true);
    f.stop();
  });

  it("resumes with new tickets and removes listeners on disposal", async () => {
    vi.useFakeTimers(); const f = pendingFixture();
    f.harness.setHidden(true); expect(f.tickets.every(ticket => ticket.signal.aborted)).toBe(true);
    f.finish.forEach(resolve => resolve()); await vi.advanceTimersByTimeAsync(0);
    f.harness.setHidden(false); expect(f.tickets).toHaveLength(4);
    expect(f.tickets.slice(2).every(ticket => !ticket.signal.aborted)).toBe(true);
    f.stop(); const count = f.cancelReads.mock.calls.length;
    f.lifecycle.dispatchEvent(new Event("beforeunload")); f.harness.setHidden(false);
    await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS);
    expect(f.tickets).toHaveLength(4); expect(f.cancelReads).toHaveBeenCalledTimes(count);
  });
});
