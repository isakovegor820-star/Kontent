// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";
import { setClientProjectId } from "./project-fetch";

vi.mock("next/navigation", () => ({ usePathname: () => "/app/calendar" }));
let store: ReturnType<typeof useStore>;
function Probe() {
  const current = useStore();
  React.useEffect(() => { store = current; }, [current]);
  return <output>{current.aiUsed}</output>;
}
afterEach(() => {
  cleanup(); window.localStorage.clear(); window.sessionStorage.clear();
  setClientProjectId(null); vi.restoreAllMocks(); vi.unstubAllGlobals();
});

it.each(["hidden", "beforeunload", "unmount"])("actual Store cancels its three polling reads on %s and ignores late data", async mode => {
  vi.stubGlobal("React", React); setClientProjectId(44);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  const held = new Map<string, { signal: AbortSignal; resolve: (response: Response) => void }>();
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const path = new URL(String(input), "https://fixture.test").pathname;
    if (path === "/api/auth/me") return Response.json({ user: { id: 17, name: "Owned", email: "owned@example.test", onboarding_completed_at: "2026-09-01T00:00:00Z" } });
    if (path === "/api/projects/current") return Response.json({ ok: true, project: { projectId: 44 } });
    if (!["/api/channels", "/api/posts", "/api/ai/usage"].includes(path)) throw new Error("Unexpected fixture request " + path);
    expect(new Headers(init?.headers).get("x-aurora-project-id")).toBe("44");
    return new Promise<Response>(resolve => { held.set(path, { resolve, signal: init?.signal as AbortSignal }); });
  }));
  const view = render(<StoreProvider><Probe /></StoreProvider>);
  try {
    await waitFor(() => expect(held.size).toBe(3));
    act(() => {
      if (mode === "unmount") view.unmount();
      else if (mode === "hidden") {
        vi.spyOn(document, "hidden", "get").mockReturnValue(true);
        document.dispatchEvent(new Event("visibilitychange"));
      } else {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event); expect(event.defaultPrevented).toBe(false);
      }
    });
    expect([...held.values()].every(({ signal }) => signal.aborted)).toBe(true);
  } finally {
    // Deliberately ignore AbortSignal at the fake transport to verify the
    // existing sequence fence still rejects an arriving successful response.
    await act(async () => {
      held.get("/api/channels")?.resolve(Response.json({ channels: [{ id: 99, title: "Late" }] }));
      held.get("/api/posts")?.resolve(Response.json({ projectId: 44, posts: [], pageInfo: { hasMore: false, nextCursor: null, snapshotVersion: "1" } }));
      held.get("/api/ai/usage")?.resolve(Response.json({ status: "ok", used: 19, limit: 30 }));
      await Promise.resolve();
    });
  }
  expect(store.realChannels).toEqual([]); expect(store.aiUsed).toBe(0);
});
