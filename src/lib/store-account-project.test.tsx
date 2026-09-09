// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";
import { getClientProjectId, setClientProjectId } from "./project-fetch";

vi.mock("next/navigation", () => ({ usePathname: () => "/test" }));
let store: ReturnType<typeof useStore>;
let actor: number;
let selected: number;
let accessible: number[];
const denied: number[] = [];
const fetcher = vi.fn<typeof fetch>();
function Probe() {
  const current = useStore();
  React.useEffect(() => { store = current; }, [current]);
  return <output>{current.user?.id}</output>;
}
beforeEach(() => {
  vi.stubGlobal("React", React);
  window.sessionStorage.clear(); window.localStorage.clear(); setClientProjectId(null);
  actor = 17; selected = 44; accessible = [44]; denied.length = 0;
  fetcher.mockReset().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/api/auth/me") return Response.json({ user: {
      id: actor, name: "Account fixture", email: `actor${actor}@example.test`,
      onboarding_completed_at: "2026-09-01T00:00:00Z",
    } });
    if (url === "/api/projects/current") {
      const header = new Headers(init?.headers).get("x-aurora-project-id");
      const requested = header ? Number(header) : selected;
      if (!accessible.includes(requested)) {
        denied.push(requested);
        return Response.json({ error: "access_denied" }, { status: 403 });
      }
      return Response.json({ ok: true, project: { projectId: requested } });
    }
    throw new Error(`Unexpected fixture request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => {
  cleanup(); window.sessionStorage.clear(); window.localStorage.clear();
  setClientProjectId(null); vi.unstubAllGlobals();
});

it("resolves the new account's project before any request can reuse the former account's selection", async () => {
  render(<StoreProvider><Probe /></StoreProvider>);
  await waitFor(() => expect(store.ready && getClientProjectId() === 44).toBe(true));
  actor = 18; selected = 55; accessible = [55];
  await act(async () => { await store.refreshAuth(); });
  await waitFor(() => expect(store.ready && store.user?.id === 18 && getClientProjectId() === 55).toBe(true));
  expect(denied).toEqual([]);
});

it("discards a persisted project belonging to a different authenticated account after reload", async () => {
  window.sessionStorage.setItem("aurora:request-project-user-id", "16");
  setClientProjectId(33);
  render(<StoreProvider><Probe /></StoreProvider>);
  await waitFor(() => expect(store.ready && getClientProjectId() === 44).toBe(true));
  expect(denied).toEqual([]);
});

it("preserves the same account's tab selection even if another tab changed the server preference", async () => {
  window.sessionStorage.setItem("aurora:request-project-user-id", "17");
  setClientProjectId(44); selected = 55; accessible = [44, 55];
  render(<StoreProvider><Probe /></StoreProvider>);
  await waitFor(() => expect(store.ready && store.user?.id === 17).toBe(true));
  expect(getClientProjectId()).toBe(44);
  expect(denied).toEqual([]);
});
