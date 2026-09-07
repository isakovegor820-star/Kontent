import { describe, expect, it, vi } from "vitest";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";

async function fixture(baseUrl = "https://127.0.0.1:8443") {
  let handle;
  const context = { route: vi.fn(async (_pattern, fn) => { handle = fn; }), unroute: vi.fn() };
  const onBlocked = vi.fn();
  const guard = await installE2eBrowserBoundary(context, { baseUrl, onBlocked });
  const visit = async (url) => {
    const route = { request: () => ({ url: () => url, method: () => "GET", resourceType: () => "fetch" }), fallback: vi.fn(), abort: vi.fn() };
    await handle(route);
    return route;
  };
  return { context, onBlocked, guard, visit };
}

describe("explicit per-context E2E outbound boundary", () => {
  it.each(["https://127.0.0.1:8443/api/projects?token=fixture", "data:text/plain,fixture", "blob:https://127.0.0.1:8443/local"]) ("retains local transport %s", async (url) => {
    const { guard, visit } = await fixture(); const route = await visit(url);
    expect(route.fallback).toHaveBeenCalledOnce(); expect(route.abort).not.toHaveBeenCalled(); guard.assertClean();
  });
  it.each(["https://127.0.0.1:9443/api", "http://127.0.0.1:8443/api", "https://localhost:8443/api", "https://provider.invalid/botsecret/send?token=secret", "https://127.0.0.1.evil.invalid/api", "invalid-url"])("denies a different destination %s", async (url) => {
    const { guard, visit, onBlocked } = await fixture(); const route = await visit(url);
    expect(route.abort).toHaveBeenCalledWith("blockedbyclient"); expect(route.fallback).not.toHaveBeenCalled();
    expect(onBlocked).toHaveBeenCalledOnce(); expect(() => guard.assertClean()).toThrow("unexpected external request");
    expect(JSON.stringify(guard.snapshot())).not.toMatch(/secret|provider|token|\/bot/u);
  });
  it.each(["https://real.invalid", "file:///tmp/fixture", "https://user:secret@localhost:8443"]) ("rejects an unsafe runtime base %s", async (base) => {
    await expect(fixture(base)).rejects.toThrow("explicit loopback");
  });
  it("keeps independent contexts and returned evidence isolated", async () => {
    const a = await fixture(); const b = await fixture(); await a.visit("https://provider.invalid/private");
    const copy = a.guard.snapshot(); copy.length = 0; expect(a.guard.snapshot()).toHaveLength(1); b.guard.assertClean();
    await a.guard.stop(); expect(a.context.unroute).toHaveBeenCalledWith("**/*", expect.any(Function));
  });
});
