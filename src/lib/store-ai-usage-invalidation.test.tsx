// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";
import { setClientProjectId } from "./project-fetch";
import { getAiUsageMetrics } from "./ai-usage-sync";
import { startVisibleWorkspacePolling, WORKSPACE_POLL_MS } from "./workspace-polling";

vi.mock("next/navigation", () => ({ usePathname: () => "/test" }));
let store: ReturnType<typeof useStore>;
const actor = { id: 17, name: "Usage fixture", email: "usage@example.test", onboarding_completed_at: "2026-09-01T00:00:00Z" };
const fetcher = vi.fn<typeof fetch>();
let usage: () => Promise<Response>;
function Probe() { const current = useStore(); React.useEffect(() => { store = current; }, [current]); return <output>{current.aiUsageStatus}</output>; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
const usageCalls = () => fetcher.mock.calls.filter(([url]) => url === "/api/ai/usage");
async function mount() { render(<StoreProvider><Probe /></StoreProvider>); await waitFor(() => expect(store.ready && store.user?.id === 17).toBe(true)); }
beforeEach(() => {
  vi.stubGlobal("React", React); setClientProjectId(44);
  usage = async () => Response.json({ status: "ok", used: 7, limit: 30 });
  fetcher.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/auth/me") return Response.json({ user: actor });
    if (url === "/api/projects/current") return Response.json({ ok: true, project: { projectId: 44 } });
    if (url === "/api/ai/usage") return usage();
    throw new Error(`Unexpected fixture request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); vi.useRealTimers(); window.localStorage.clear(); window.sessionStorage.clear(); setClientProjectId(null); vi.unstubAllGlobals(); });

describe("usage invalidation after an uncertain generation transport", () => {
  it("marks the last number unknown without issuing another request", async () => {
    await mount(); await act(async () => { await store.refreshAiUsage(); });
    expect(store.aiUsageStatus).toBe("ok"); expect(getAiUsageMetrics(store.aiUsageStatus, store.aiUsed, store.aiLimit)?.used).toBe(7);
    const count = fetcher.mock.calls.length;
    act(() => store.invalidateAiUsage());
    expect(fetcher.mock.calls).toHaveLength(count); expect(store.aiUsageStatus).toBe("unknown");
    expect(store.aiUsed).toBe(7); expect(getAiUsageMetrics(store.aiUsageStatus, store.aiUsed, store.aiLimit)).toBeNull();
  });
  it("revokes an older GET even when its response ignores abort, then accepts a new current refresh", async () => {
    await mount(); const old = deferred<Response>(); usage = () => old.promise;
    let pending!: Promise<void>; act(() => { pending = store.refreshAiUsage(); });
    await waitFor(() => expect(usageCalls()).toHaveLength(1));
    const signal = usageCalls()[0][1]?.signal;
    act(() => store.invalidateAiUsage()); expect(signal?.aborted).toBe(true);
    await act(async () => { old.resolve(Response.json({ status: "ok", used: 2, limit: 30 })); await pending; });
    expect(store.aiUsageStatus).toBe("unknown"); expect(store.aiUsed).not.toBe(2);
    usage = async () => Response.json({ status: "ok", used: 8, limit: 30 });
    await act(async () => { await store.refreshAiUsage(); });
    expect(store.aiUsageStatus).toBe("ok"); expect(store.aiUsed).toBe(8); expect(usageCalls()).toHaveLength(2);
  });
  it("recovers through the unchanged visible polling controller and never requires a departure timer", async () => {
    await mount(); vi.useFakeTimers(); let hidden = false;
    const events = new EventTarget(); const visibility = { get hidden() { return hidden; }, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events) };
    let stop!: () => void;
    await act(async () => { stop = startVisibleWorkspacePolling({ refreshReal: () => {}, refreshAiUsage: () => store.refreshAiUsage(), visibility,
      lifecycle: window, cancelReads: () => store.invalidateAiUsage() }); });
    expect(store.aiUsageStatus).toBe("ok"); act(() => store.invalidateAiUsage());
    hidden = true; act(() => events.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS * 2); });
    expect(store.aiUsageStatus).toBe("unknown"); expect(usageCalls()).toHaveLength(1);
    usage = async () => Response.json({ status: "ok", used: 9, limit: 30 }); hidden = false;
    await act(async () => { events.dispatchEvent(new Event("visibilitychange")); });
    expect(store.aiUsageStatus).toBe("ok"); expect(store.aiUsed).toBe(9); expect(usageCalls()).toHaveLength(2);
    act(() => store.invalidateAiUsage()); usage = async () => Response.json({ status: "ok", used: 10, limit: 30 });
    await act(async () => { await vi.advanceTimersByTimeAsync(WORKSPACE_POLL_MS); });
    expect(store.aiUsed).toBe(10); expect(store.aiUsageStatus).toBe("ok"); expect(usageCalls()).toHaveLength(3); stop();
  });
});
