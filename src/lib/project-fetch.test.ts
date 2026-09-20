// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClientProjectId, projectFetch, setClientProjectId } from "./project-fetch";

beforeEach(() => { setClientProjectId(null); });
afterEach(() => { vi.unstubAllGlobals(); setClientProjectId(null); });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

describe("tab-bound project requests", () => {
  it("captures selected project on reads and mutations and retains it on reload storage", async () => {
    window.sessionStorage.setItem("aurora:request-project-id", "11");
    const fetcher = vi.fn().mockImplementation(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await projectFetch("/api/channels");
    await projectFetch("/api/posts/create", { method: "POST", body: "{}" });
    expect(getClientProjectId()).toBe(11);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init.headers).get("x-aurora-project-id")).toBe("11");
  });
  it("bootstraps once before concurrent first project data requests", async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => json(String(url).includes("projects/current") ? { project: { projectId: 11 } } : { ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await Promise.all([projectFetch("/api/channels"), projectFetch("/api/ai/usage")]);
    expect(fetcher.mock.calls.filter(([url]) => url === "/api/projects/current")).toHaveLength(1);
    expect(getClientProjectId()).toBe(11);
  });
  it("rejects delayed response after switch without changing its request target", async () => {
    setClientProjectId(11);
    let complete!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise<Response>((resolve) => { complete = resolve; }));
    vi.stubGlobal("fetch", fetcher);
    const pending = projectFetch("/api/posts/create", { method: "POST", body: "{}" });
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
    setClientProjectId(22);
    complete(json({ projectId: 11 }));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("x-aurora-project-id")).toBe("11");
  });
  it("rejects stream data arriving from previous project", async () => {
    setClientProjectId(11);
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { stream = controller; } }))));
    const response = await projectFetch("/api/ai/generate", { method: "POST" });
    const text = response.text();
    setClientProjectId(22);
    stream.enqueue(new TextEncoder().encode("old-project-data"));
    await expect(text).rejects.toMatchObject({ name: "AbortError" });
  });
  it("does not send project identifiers to external or authentication endpoints", async () => {
    setClientProjectId(11);
    const fetcher = vi.fn<typeof fetch>(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    await projectFetch("https://external.example.test/api/read");
    await projectFetch("/api/auth/logout", { method: "POST" });
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).has("x-aurora-project-id")).toBe(false);
  });
  it("preserves a transport error from a failed response body", async () => {
    setClientProjectId(11);
    const failure = new TypeError("input stream failed");
    vi.stubGlobal("fetch", vi.fn(async () => new Response(new ReadableStream({ start(controller) { controller.error(failure); } }))));
    const response = await projectFetch("/api/posts");
    await expect(response.json()).rejects.toBe(failure);
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
  });
  it("guards clones and direct stream readers after a project switch", async () => {
    setClientProjectId(11);
    vi.stubGlobal("fetch", vi.fn(async () => json({ secret: "project11" })));
    const response = await projectFetch("/api/posts");
    const clone = response.clone();
    setClientProjectId(22);
    await expect(clone.json()).rejects.toMatchObject({ name: "AbortError" });
    await expect(response.body!.getReader().read()).rejects.toMatchObject({ name: "AbortError" });
  });
  it("preserves body locking, clone semantics and non-JSON downloads", async () => {
    setClientProjectId(11);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("report", { status: 201, headers: { "content-type": "text/plain" } })));
    const response = await projectFetch("/api/report");
    const clone = response.clone();
    expect(response.status).toBe(201);
    expect(response.bodyUsed).toBe(false);
    const reader = response.body!.getReader();
    await expect(response.text()).rejects.toBeInstanceOf(TypeError);
    reader.releaseLock();
    expect(await response.text()).toBe("report");
    expect(response.bodyUsed).toBe(true);
    expect(await (await clone.blob()).text()).toBe("report");
    expect(() => response.clone()).toThrow(TypeError);
  });
  it("refuses conflicting explicit project before any request", async () => {
    setClientProjectId(11);
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(projectFetch("/api/posts", { headers: { "x-aurora-project-id": "22" } })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([
    ["/api/tracking/report?from=2026-09-01", "GET"],
    ["/api/tracking/settings", "GET"],
    ["/api/tracking/settings", "PUT"],
    ["/api/tracking/settings/verify", "POST"],
    ["/api/tracking/templates", "POST"],
    ["/api/tracking/templates/19", "PATCH"],
    ["/api/tracking/links", "GET"],
    ["/api/tracking/links", "POST"],
    ["/api/tracking/links/19", "PATCH"],
    ["/api/settings/preview", "POST"],
  ])("binds protected %s %s to this tab despite another tab's saved preference", async (url, method) => {
    setClientProjectId(11);
    const sharedServerPreference = 22;
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      const requested = new Headers(init?.headers).get("x-aurora-project-id");
      return json({ projectId: requested ? Number(requested) : sharedServerPreference });
    });
    vi.stubGlobal("fetch", fetcher);
    const response = await projectFetch(url, { method });
    expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("x-aurora-project-id")).toBe("11");
    await expect(response.json()).resolves.toEqual({ projectId: 11 });
  });
  it("exempts only the public tracker receivers and static client without bootstrapping a session project", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => json({ ok: true }));
    vi.stubGlobal("fetch", fetcher);
    for (const url of ["/api/tracking/ping", "/api/tracking/conversions", "/api/tracking/client.js?v=1"]) await projectFetch(url);
    expect(fetcher).toHaveBeenCalledTimes(3);
    for (const [, init] of fetcher.mock.calls) expect(new Headers(init?.headers).has("x-aurora-project-id")).toBe(false);
    setClientProjectId(11);
    await projectFetch("/api/tracking/ping-private");
    expect(new Headers(fetcher.mock.lastCall?.[1]?.headers).get("x-aurora-project-id")).toBe("11");
  });

});
