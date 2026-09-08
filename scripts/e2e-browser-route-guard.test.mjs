import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { installE2eBrowserRouteGuard } from "./e2e-browser-route-guard.mjs";

const baseUrl = "https://127.0.0.1:444";
function surface() {
  const target = new EventEmitter();
  target.route = vi.fn(async () => {}); target.unroute = vi.fn(async () => {}); target.unrouteAll = vi.fn(async () => {});
  target.pages = () => [];
  return target;
}
function route(url = baseUrl + "/api/fixture") {
  return { request: () => ({ url: () => url, method: () => "GET" }), abort: vi.fn(async () => {}),
    continue: vi.fn(async () => {}), fetch: vi.fn(async () => "actual response"), fallback: vi.fn(async () => {}), fulfill: vi.fn(async () => {}) };
}
async function setup(onBlocked) {
  const context = surface(); const rawRoute = context.route; const rawUnroute = context.unroute; const rawUnrouteAll = context.unrouteAll;
  const guard = await installE2eBrowserRouteGuard(context, { baseUrl, onBlocked });
  return { context, guard, rawRoute, rawUnroute, rawUnrouteAll };
}
async function wrapped(setup, handler) {
  await setup.context.route("**/*", handler);
  return setup.rawRoute.mock.calls.at(-1)[1];
}

describe("browser route registration guard", () => {
  it("terminates the final admitted route with continue", async () => {
    const s = await setup(); const request = route();
    await s.rawRoute.mock.calls[0][1](request);
    expect(request.continue).toHaveBeenCalledOnce();
    expect(request.fallback).not.toHaveBeenCalled();
    expect(request.abort).not.toHaveBeenCalled();
    s.guard.assertClean();
  });
  it.each(["http://unsafe.invalid", "file:///tmp/fixture", "https://user:secret@localhost"])("rejects unsafe base %s", async url => {
    await expect(installE2eBrowserRouteGuard(surface(), { baseUrl: url })).rejects.toThrow("loopback");
  });
  it.each(["continue", "fetch"])("denies foreign original %s even when rewritten to an allowed URL", async operation => {
    const s = await setup(() => { throw new Error("observer failed"); }); const request = route("https://provider.invalid?secret=canary");
    const invoke = await wrapped(s, r => r[operation]({ url: baseUrl }));
    if (operation === "fetch") await expect(invoke(request)).rejects.toThrow("fetch denied"); else await invoke(request);
    expect(request[operation]).not.toHaveBeenCalled(); expect(request.abort).toHaveBeenCalledWith("blockedbyclient");
    expect(() => s.guard.assertClean()).toThrow("unexpected external"); expect(JSON.stringify(s.guard.snapshot())).not.toMatch(/provider|secret|canary/);
  });
  it.each(["continue", "fetch", "fallback"])("denies a foreign %s URL override", async operation => {
    const s = await setup(); const request = route(); const invoke = await wrapped(s, r => r[operation]({ url: "https://localhost:445/private" }));
    if (operation === "fetch") await expect(invoke(request)).rejects.toThrow("fetch denied"); else await invoke(request);
    expect(request[operation]).not.toHaveBeenCalled(); expect(request.abort).toHaveBeenCalledOnce();
  });
  it("preserves allowed overrides while forcing every route.fetch to zero redirects", async () => {
    const s = await setup(); const request = route();
    await (await wrapped(s, async r => {
      await r.continue({ url: baseUrl + "/second", method: "POST", postData: "exact" });
      expect(await r.fetch({ url: baseUrl, maxRedirects: 999, headers: { fixture: "preserved" } })).toBe("actual response");
    }))(request);
    expect(request.continue).toHaveBeenCalledWith({ url: baseUrl + "/second", method: "POST", postData: "exact" });
    expect(request.fetch).toHaveBeenCalledWith({ url: baseUrl, maxRedirects: 0, headers: { fixture: "preserved" } }); s.guard.assertClean();
  });
  it("lets unchanged foreign fallback reach the permanent context denial", async () => {
    const s = await setup(); const request = route("https://provider.invalid");
    await (await wrapped(s, r => r.fallback()))(request); expect(request.fallback).toHaveBeenCalledOnce();
    await s.rawRoute.mock.calls[0][1](request); expect(request.abort).toHaveBeenCalledOnce();
  });
  it.each([
    { status: 302, headers: { Location: "https://provider.invalid/secret" } },
    { response: { status: () => 307, headers: () => ({ location: "//provider.invalid/secret" }) } },
    { status: 301, headers: { location: "https://user:secret@127.0.0.1:444" } },
    { status: 302, headers: { Location: "https://unsafe.invalid", location: "/allowed" } },
    { status: 302, headers: { location: "/allowed", Location: "https://unsafe.invalid" } },
    { response: { status: () => 307, headers: () => ({ Location: "https://unsafe.invalid", location: "/allowed" }) } },
    { response: { status: () => 307, headers: () => ({ location: "/allowed", Location: "https://unsafe.invalid" }) } },
    { status: 302, headers: { location: ["/allowed"] } },
    { status: 302, headers: { location: null } },
  ])("denies an off-origin fulfilled redirect with effective response metadata", async options => {
    const s = await setup(); const request = route(); await (await wrapped(s, r => r.fulfill(options)))(request);
    expect(request.fulfill).not.toHaveBeenCalled(); expect(request.abort).toHaveBeenCalledOnce();
    expect(s.guard.snapshot()[0].operation).toBe("fulfill_redirect");
  });
  it("preserves local synthetic content and effective safe metadata overrides", async () => {
    const s = await setup(); const fake = route("https://t.me/fixture");
    await (await wrapped(s, r => r.fulfill({ status: 200, body: "local fixture" })))(fake);
    expect(fake.fulfill).toHaveBeenCalledWith({ status: 200, body: "local fixture" });
    const own = route(); const response = { status: () => 307, headers: () => ({ location: "https://unsafe.invalid" }) };
    await (await wrapped(s, r => r.fulfill({ response, headers: { location: "/allowed" } })))(own);
    expect(own.fulfill).toHaveBeenCalledWith({ response, headers: { location: "/allowed" } }); s.guard.assertClean();
  });
  it("patches new pages synchronously and preserves unroute(handler) identity", async () => {
    const s = await setup(); const page = surface(); const raw = page.route; const unroute = page.unroute;
    s.context.emit("page", page); const handler = r => r.continue(); await page.route("**/fixture", handler);
    const actual = route("https://unsafe.invalid"); await raw.mock.calls[0][1](actual); expect(actual.abort).toHaveBeenCalledOnce();
    await page.unroute("**/fixture", handler); expect(unroute).toHaveBeenCalledWith("**/fixture", raw.mock.calls[0][1]);
  });
  it("preserves the internal context deny across broad cleanup without any unguarded interval", async () => {
    const s = await setup(); const handler = r => r.fallback(); await s.context.route("**/*", handler);
    await s.context.unroute("**/*"); expect(s.rawUnroute).toHaveBeenCalledTimes(1);
    expect(s.rawUnroute.mock.calls[0][1]).not.toBe(s.rawRoute.mock.calls[0][1]);
    await s.context.route("**/fixture", handler); await s.context.unrouteAll();
    expect(s.rawUnrouteAll).not.toHaveBeenCalled(); expect(s.rawUnroute).toHaveBeenCalledTimes(2);
    const request = route("https://unsafe.invalid"); await s.rawRoute.mock.calls[0][1](request); expect(request.abort).toHaveBeenCalledOnce();
    await expect(s.context.unrouteAll({ behavior: "ignoreErrors" })).rejects.toThrow("cannot weaken");
  });
  it("cannot be stopped while the context is live and restores only owned wrappers after close", async () => {
    const s = await setup(); expect(() => s.guard.stop()).toThrow("only after context close");
    s.context.emit("close"); s.guard.stop(); s.guard.stop(); expect(s.context.route).toBe(s.rawRoute);
    const copy = s.guard.snapshot(); copy.push({}); expect(s.guard.snapshot()).toEqual([]);
  });
});
