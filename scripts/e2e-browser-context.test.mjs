import { beforeEach, expect, it, vi } from "vitest";
const { createProxy, installGuard } = vi.hoisted(() => ({ createProxy: vi.fn(), installGuard: vi.fn() }));
vi.mock("./e2e-browser-route-guard.mjs", () => ({ installE2eBrowserRouteGuard: installGuard }));
vi.mock("./e2e-browser-proxy.mjs", () => ({ createE2eBrowserProxy: createProxy }));
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";

beforeEach(() => vi.resetAllMocks());
function setup() {
  const context = { close: vi.fn(async () => {}) };
  const transport = { snapshot: vi.fn(() => []), assertClean: vi.fn(), proxyOptions: { server: "http://127.0.0.1:12345" }, attach: vi.fn(), stop: vi.fn(async () => {}) };
  createProxy.mockResolvedValue(transport);
  const guard = { snapshot: vi.fn(() => []), assertClean: vi.fn(), stop: vi.fn(async () => {}) };
  installGuard.mockResolvedValue(guard);
  const browser = { newContext: vi.fn(async () => context) };
  return { browser, context, transport, guard };
}
it("establishes a non-overridable proxy before creating the context", async () => {
  const { browser, context, transport } = setup(); const onBlocked = vi.fn();
  const result = await createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444", onBlocked,
    viewport: { width: 390, height: 844 }, proxy: { server: "http://unsafe.invalid" }, baseURL: "http://unsafe.invalid", serviceWorkers: "allow" });
  expect(result.context).toBe(context); expect(result.transport.proxyOptions).toBe(transport.proxyOptions);
  expect(createProxy).toHaveBeenCalledWith({ baseUrl: "https://127.0.0.1:444", onBlocked, serviceFixture: undefined });
  expect(createProxy.mock.invocationCallOrder[0]).toBeLessThan(browser.newContext.mock.invocationCallOrder[0]);
  expect(browser.newContext).toHaveBeenCalledWith({ baseURL: "https://127.0.0.1:444", proxy: transport.proxyOptions,
    viewport: { width: 390, height: 844 }, serviceWorkers: "block" });
  expect(transport.attach).toHaveBeenCalledWith(context);
});
it("does not create a context after boundary validation fails", async () => {
  const { browser } = setup(); createProxy.mockRejectedValue(new Error("invalid origin"));
  await expect(createE2eBrowserContext(browser, { baseUrl: "https://unsafe.invalid" })).rejects.toThrow("invalid origin");
  expect(browser.newContext).not.toHaveBeenCalled();
});
it("passes an owned service fixture only to the transport and keeps app routing on the app origin", async () => {
  const { browser } = setup();
  const serviceFixture = Object.freeze({ kind: "aurora-owned-chromium-service-fixture", origin: "https://127.0.0.1:555" });
  await createE2eBrowserContext(browser, { baseUrl: "https://localhost:444", serviceFixture });
  expect(createProxy).toHaveBeenCalledWith({ baseUrl: "https://localhost:444", onBlocked: undefined, serviceFixture });
  expect(browser.newContext.mock.calls[0][0]).not.toHaveProperty("serviceFixture");
  expect(installGuard.mock.calls[0][1]).toEqual({ baseUrl: "https://localhost:444", onBlocked: undefined });
});
it("closes the proxy when context creation fails", async () => {
  const { browser, transport } = setup(); browser.newContext.mockRejectedValue(new Error("browser failure"));
  await expect(createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444" })).rejects.toThrow("browser failure");
  expect(transport.stop).toHaveBeenCalledOnce();
});
it("closes context and proxy if attachment fails", async () => {
  const { browser, context, transport } = setup(); transport.attach.mockImplementation(() => { throw new Error("attachment failure"); });
  await expect(createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444" })).rejects.toThrow("attachment failure");
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
});

it("retains both boundaries and closes both after the context", async () => {
  const { browser, context, transport: proxy, guard } = setup();
  const result = await createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444" });
  proxy.snapshot.mockReturnValue([{ kind: "proxy_denial" }]); guard.snapshot.mockReturnValue([{ kind: "route_denial" }]);
  expect(result.transport.snapshot()).toEqual([{ boundary: "proxy", kind: "proxy_denial" }, { boundary: "routes", kind: "route_denial" }]);
  proxy.assertClean.mockImplementation(() => { throw new Error("proxy denied"); });
  guard.assertClean.mockImplementation(() => { throw new Error("route denied"); });
  expect(() => result.transport.assertClean()).toThrow("unexpected external request");
  expect(proxy.assertClean).toHaveBeenCalledOnce(); expect(guard.assertClean).toHaveBeenCalledOnce();
  await context.close(); await result.transport.stop();
  expect(proxy.stop).toHaveBeenCalledOnce(); expect(guard.stop).toHaveBeenCalledOnce();
});
it("cleans up a context whose route guard setup fails", async () => {
  const { browser, context, transport } = setup(); installGuard.mockRejectedValue(new Error("route setup failed"));
  await expect(createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444" })).rejects.toThrow("route setup failed");
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
});

it("retains both proxy and route cleanup errors", async () => {
  const { browser, context, transport: proxy, guard } = setup();
  const result = await createE2eBrowserContext(browser, { baseUrl: "https://127.0.0.1:444" });
  const first = new Error("proxy stop failed"); const second = new Error("guard stop failed");
  proxy.stop.mockRejectedValue(first); guard.stop.mockRejectedValue(second);
  await context.close();
  const failure = await result.transport.stop().catch(error => error);
  expect(failure).toBeInstanceOf(AggregateError); expect(failure.cause).toBe(first);
  expect(failure.errors).toEqual([first, second]);
});
