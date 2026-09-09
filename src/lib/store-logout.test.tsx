// @vitest-environment jsdom
import React from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StoreProvider, useStore } from "./store";
import { setClientProjectId } from "./project-fetch";

vi.mock("next/navigation", () => ({ usePathname: () => "/test" }));
let store: ReturnType<typeof useStore>;
const actor = { id: 17, name: "Logout fixture", email: "logout@example.test", onboarding_completed_at: "2026-09-01T00:00:00Z" };
let activeSession: boolean;
let logout: () => Promise<Response>;
let me: (() => Promise<Response>) | null;
const fetcher = vi.fn<typeof fetch>();
function Probe() { const current = useStore(); React.useEffect(() => { store = current; }, [current]); return <output>{current.user ? "signed-in" : "signed-out"}</output>; }
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (value: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function mount() { render(<StoreProvider><Probe /></StoreProvider>); await waitFor(() => expect(store.ready && store.user?.id === 17).toBe(true)); }
beforeEach(() => {
  vi.stubGlobal("React", React); activeSession = true; me = null; setClientProjectId(44);
  logout = async () => { activeSession = false; return Response.json({ ok: true }); };
  fetcher.mockReset().mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/api/auth/me") return me ? me() : Response.json({ user: activeSession ? actor : null });
    if (url === "/api/projects/current") return Response.json({ ok: true, project: { projectId: 44 } });
    if (url === "/api/auth/logout") return logout();
    throw new Error(`Unexpected fixture request ${url}`);
  });
  vi.stubGlobal("fetch", fetcher);
});
afterEach(() => { cleanup(); window.localStorage?.clear(); window.sessionStorage?.clear(); setClientProjectId(null); vi.unstubAllGlobals(); });

describe("server-confirmed logout", () => {
  it("preserves signed-in state and unsaved local content when the request is dropped before revoke", async () => {
    await mount(); act(() => { store.addPost({ text: "N28_UNSAVED" }); });
    logout = async () => { throw new TypeError("request dropped"); };
    let outcome: unknown; await act(async () => { outcome = await store.signOut(); });
    expect(activeSession).toBe(true);
    expect(store.user?.id).toBe(17);
    expect(store.posts.some((post) => post.text === "N28_UNSAVED")).toBe(true);
    expect(outcome).toBe(false);
  });
  it("does not clear the account while acknowledgement is pending; confirms only after revoke", async () => {
    await mount(); const receipt = deferred<Response>(); logout = () => receipt.promise;
    let result: unknown; act(() => { result = store.signOut(); });
    expect(store.user?.id).toBe(17);
    expect(activeSession).toBe(true);
    await act(async () => { activeSession = false; receipt.resolve(Response.json({ ok: true })); await result; });
    expect(store.user).toBeNull();
    expect(await result).toBe(true);
  });
  it.each([503, 403, 429])("keeps failure visible when server returns HTTP %s", async (status) => {
    await mount(); logout = async () => Response.json({ ok: false, error: "logout_unavailable" }, { status });
    await act(async () => { await store.signOut(); });
    expect(activeSession).toBe(true); expect(store.user?.id).toBe(17);
  });
  it("does not accept malformed successful HTTP as a revocation receipt", async () => {
    await mount(); logout = async () => new Response("{lost-json", { status: 200 });
    await act(async () => { await store.signOut(); });
    expect(activeSession).toBe(true); expect(store.user?.id).toBe(17);
  });
  it("allows an explicit idempotent retry after revoke happened but its response was lost", async () => {
    await mount(); logout = async () => { activeSession = false; throw new TypeError("ack lost"); };
    await act(async () => { await store.signOut(); });
    expect(activeSession).toBe(false); expect(store.user?.id).toBe(17);
    logout = async () => Response.json({ ok: true });
    await act(async () => { expect(await store.signOut()).toBe(true); });
    expect(store.user).toBeNull();
  });
  it("a stale auth/me response cannot restore an account after confirmed logout", async () => {
    await mount(); const old = deferred<Response>(); me = () => old.promise;
    let refresh!: Promise<void>; act(() => { refresh = store.refreshAuth(); });
    await act(async () => { await store.signOut(); });
    await act(async () => { old.resolve(Response.json({ user: actor })); await refresh; });
    expect(activeSession).toBe(false); expect(store.user).toBeNull();
  });
});

it("shares one pending logout across simultaneous controls and exposes bounded retry state", async () => {
  await mount(); const receipt = deferred<Response>(); logout = () => receipt.promise;
  let first: unknown; let second: unknown;
  act(() => { first = store.signOut(); second = store.signOut(); });
  expect(first).toBe(second); expect(store.signOutStatus).toBe("pending"); expect(store.signOutError).toBeNull();
  const calls = fetcher.mock.calls.filter(([url]) => url === "/api/auth/logout");
  expect(calls).toHaveLength(1); expect(calls[0][1]?.signal).toBeDefined();
  await act(async () => { receipt.reject(new DOMException("timeout", "TimeoutError")); await first; });
  expect(store.signOutStatus).toBe("failed"); expect(store.signOutError).toContain("Сессия может оставаться активной");
  expect(store.user?.id).toBe(17);
});
