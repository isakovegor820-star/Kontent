import assert from "node:assert/strict";
import { parseOwnedE2eBrowserOrigin } from "./e2e-browser-origin.mjs";

/** Install on a fresh context before registering fixtures or opening pages. */
export async function installE2eBrowserRouteGuard(context, { baseUrl, onBlocked = () => {} }) {
  const base = parseOwnedE2eBrowserOrigin(baseUrl);
  const blocked = [];
  const originalUrls = new WeakMap();
  const patched = new Map();
  let closed = false;
  let stopped = false;
  const safe = (value) => {
    try { const url = new URL(value); return url.origin === base.origin && !url.username && !url.password; }
    catch { return false; }
  };
  const originalUrl = (route) => {
    if (!originalUrls.has(route)) originalUrls.set(route, route.request().url());
    return originalUrls.get(route);
  };
  const deny = async (route, operation, value) => {
    let protocol = "invalid";
    try { protocol = new URL(value).protocol; } catch { /* Do not expose a malformed URL. */ }
    const record = { id: blocked.length + 1, kind: "external_request", method: route.request().method(),
      protocol, transport: "route", operation };
    blocked.push(record);
    try { onBlocked({ ...record }); } catch { /* The retained record still fails assertClean. */ }
    await route.abort("blockedbyclient");
  };
  const requestAllowed = (route, options = {}) => safe(originalUrl(route)) && safe(route.request().url())
    && (options.url === undefined || safe(options.url));
  const redirectTarget = (route, options) => {
    const status = options.status ?? options.response?.status() ?? 200;
    const headers = options.headers ?? options.response?.headers() ?? {};
    if (status < 300 || status >= 400) return null;
    const locations = Object.entries(headers).filter(([name]) => name.toLowerCase() === "location");
    if (locations.length === 0) return null;
    if (locations.length !== 1 || typeof locations[0][1] !== "string") return "invalid";
    try { return new URL(locations[0][1], route.request().url()).href; } catch { return "invalid"; }
  };
  const decorate = (route) => {
    originalUrl(route);
    const methods = {
      async continue(options = {}) {
        if (!requestAllowed(route, options)) return deny(route, "continue", options.url ?? route.request().url());
        return route.continue(options);
      },
      async fallback(options = {}) {
        // Unchanged foreign requests must reach the final context denial; fixture handlers
        // may still fulfill synthetic foreign content without any network request.
        if (options.url !== undefined && !requestAllowed(route, options)) return deny(route, "fallback", options.url);
        return route.fallback(options);
      },
      async fetch(options = {}) {
        if (!requestAllowed(route, options)) {
          await deny(route, "fetch", options.url ?? route.request().url());
          throw new Error("Isolated browser route fetch denied");
        }
        // Caller-supplied redirect settings cannot make APIRequestContext follow externally.
        return route.fetch({ ...options, maxRedirects: 0 });
      },
      async fulfill(options = {}) {
        const target = redirectTarget(route, options);
        if (target !== null && !safe(target)) return deny(route, "fulfill_redirect", target);
        return route.fulfill(options);
      },
    };
    return new Proxy(route, { get(target, key) {
      if (Object.hasOwn(methods, key)) return methods[key];
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
  const samePattern = (a, b) => a === b || (a instanceof RegExp && b instanceof RegExp && a.source === b.source && a.flags === b.flags);
  const boundary = async (route) => {
    // This is the final owned handler. Continuing an admitted request closes the
    // interception chain explicitly; falling through with no earlier handler can
    // leave Chromium reporting a fully consumed mutation as ERR_ABORTED.
    if (requestAllowed(route)) return route.continue();
    return deny(route, "request", route.request().url());
  };
  const patch = (target, isContext = false) => {
    if (patched.has(target)) return;
    const raw = { route: target.route, unroute: target.unroute, unrouteAll: target.unrouteAll };
    const registrations = [];
    const wrappers = {
      async route(pattern, handler, options) {
        assert(typeof handler === "function", "route handler required");
        const wrapped = (route, request) => handler(decorate(route), request);
        const row = { pattern, handler, wrapped }; registrations.push(row);
        try { return await raw.route.call(target, pattern, wrapped, options); }
        catch (error) { registrations.splice(registrations.indexOf(row), 1); throw error; }
      },
      async unroute(pattern, handler) {
        const matches = registrations.filter(row => samePattern(row.pattern, pattern) && (!handler || row.handler === handler));
        for (const row of matches) {
          await raw.unroute.call(target, pattern, row.wrapped);
          registrations.splice(registrations.indexOf(row), 1);
        }
        // Fresh-context installation owns all later registrations. Do not let a broad
        // fixture cleanup also remove the internal catch-all boundary.
      },
      async unrouteAll(options) {
        if (isContext) {
          assert(!options?.behavior || options.behavior === "default", "context fixture cleanup cannot weaken the live route guard");
          for (const row of registrations.splice(0)) await raw.unroute.call(target, row.pattern, row.wrapped);
        } else {
          await raw.unrouteAll.call(target, options);
          registrations.length = 0;
        }
      },
    };
    Object.assign(target, wrappers);
    patched.set(target, { raw, wrappers });
  };
  // Register first: later local fixtures can fulfill, while fallback reaches denial.
  await context.route("**/*", boundary);
  patch(context, true);
  const onPage = page => patch(page);
  context.on("page", onPage);
  context.once("close", () => { closed = true; });
  for (const page of context.pages()) patch(page);
  return {
    snapshot: () => blocked.map(record => ({ ...record })),
    assertClean: () => assert.equal(blocked.length, 0, "browser route attempted an unexpected external request"),
    stop() {
      assert(closed, "browser route guard can stop only after context close");
      if (stopped) return;
      stopped = true; context.off("page", onPage);
      for (const [target, { raw, wrappers }] of patched) {
        for (const key of Object.keys(raw)) if (target[key] === wrappers[key]) target[key] = raw[key];
      }
      patched.clear();
    },
  };
}
