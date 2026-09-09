import { afterEach, describe, expect, it, vi } from "vitest";
import { captureProjectFetch, guardProjectCall, pauseProjectTransport, setProjectTransport } from "./project-transport";
const response = (id: number, body: unknown = { ok: true }) => new Response(JSON.stringify(body), { headers: { "x-aurora-project-id": String(id) } });
afterEach(() => { vi.unstubAllGlobals(); setProjectTransport(null); });

describe("browser project transport", () => {
  it("sends the project captured by the active screen", async () => {
    const fetch = vi.fn(async () => response(11)); vi.stubGlobal("fetch", fetch);
    setProjectTransport(11);
    await captureProjectFetch()("/api/channels");
    expect(fetch.mock.calls[0]).toBeDefined();
    const init = (fetch.mock.calls as unknown[][])[0][1] as RequestInit;
    expect(new Headers(init.headers).get("x-aurora-project-id")).toBe("11");
  });
  it("blocks old callbacks, new requests during reconciliation, and stale service calls", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    setProjectTransport(11); const captured = captureProjectFetch(); const service = vi.fn(async () => undefined); const guarded = guardProjectCall(service);
    pauseProjectTransport();
    await expect(captured("/api/drafts", { method: "POST" })).rejects.toMatchObject({ name: "AbortError" });
    await expect(guarded()).rejects.toThrow("project_context_changed");
    setProjectTransport(22);
    await expect(captured("/api/channels")).rejects.toMatchObject({ name: "AbortError" });
    expect(fetch).not.toHaveBeenCalled(); expect(service).not.toHaveBeenCalled();
  });
  it("discards responses that arrive in reverse order after a switch", async () => {
    let finish!: (value: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(() => new Promise<Response>((resolve) => { finish = resolve; })).mockResolvedValueOnce(response(22)));
    setProjectTransport(11); const a = captureProjectFetch()("/api/channels");
    const rejected = expect(a).rejects.toMatchObject({ name: "AbortError" });
    setProjectTransport(22); expect((await captureProjectFetch()("/api/channels")).ok).toBe(true);
    finish(response(11)); await rejected;
  });
  it("checks the response project and delayed body parsing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response(22)).mockResolvedValueOnce(response(11)));
    setProjectTransport(11);
    await expect(captureProjectFetch()("/api/channels")).rejects.toThrow("project_response_mismatch");
    const received = await captureProjectFetch()("/api/channels");
    setProjectTransport(22);
    await expect(received.json()).rejects.toThrow("project_context_changed");
  });
  it("invalidates cached callbacks when another account has the same numeric project selector", async () => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    setProjectTransport(11, true, 7); const oldAccount = captureProjectFetch();
    setProjectTransport(11, true, 8);
    await expect(oldAccount("/api/channels")).rejects.toThrow("project_context_changed");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps blocked services asynchronous for effect .catch handlers and fences late service results", async () => {
    setProjectTransport(null);
    const call = vi.fn(async () => 7);
    const blocked = guardProjectCall(call);
    let pending: Promise<number> | undefined;
    expect(() => { pending = blocked(); }).not.toThrow();
    await expect(pending).rejects.toThrow("project_context_changed");
    expect(call).not.toHaveBeenCalled();
    setProjectTransport(11);
    let finish!: (value: number) => void;
    const waiting = guardProjectCall(() => new Promise<number>(resolve => { finish = resolve; }))();
    const rejected = expect(waiting).rejects.toThrow("project_context_changed");
    setProjectTransport(22);
    finish(7);
    await rejected;
  });
  it("allows context recovery and account authentication while project requests are blocked", async () => {
    const fetch = vi.fn(async () => new Response("{}")); vi.stubGlobal("fetch", fetch);
    await captureProjectFetch()("/api/projects/current");
    await captureProjectFetch()("/api/auth/me");
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
