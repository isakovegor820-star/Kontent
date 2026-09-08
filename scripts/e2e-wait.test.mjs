import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForE2e } from "./e2e-wait.mjs";
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
describe("E2E polling deadline", () => {
  it("counts the time spent in a slow check toward the deadline", async () => {
    vi.useFakeTimers(); let settled = false;
    const outcome = waitForE2e(() => new Promise(resolve => setTimeout(() => resolve(false), 80)), "not ready", 100)
      .then(value => ({ value }), error => ({ error: error.message })).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(101);
    expect(settled).toBe(true);
    expect(await outcome).toEqual({ error: "not ready" });
  });
  it("bounds a check that never settles", async () => {
    vi.useFakeTimers(); let settled = false;
    const outcome = waitForE2e(() => new Promise(() => {}), "stuck check", 100)
      .then(value => ({ value }), error => ({ error: error.message })).then(value => { settled = true; return value; });
    await vi.advanceTimersByTimeAsync(101);
    expect(settled).toBe(true);
    expect(await outcome).toEqual({ error: "stuck check" });
  });
  it("retries transient failures and returns the successful check value", async () => {
    vi.useFakeTimers();
    const check = vi.fn().mockRejectedValueOnce(new Error("temporary")).mockResolvedValueOnce({ ready: true });
    const outcome = waitForE2e(check, "not ready", 500);
    await vi.advanceTimersByTimeAsync(151);
    expect(await outcome).toEqual({ ready: true });
    expect(check).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
});
