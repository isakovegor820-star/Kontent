import { createE2eBrowserProxy } from "./e2e-browser-proxy.mjs";
import { installE2eBrowserRouteGuard } from "./e2e-browser-route-guard.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";

/** Install transport and route boundaries before callers can create requests. */
export async function createE2eBrowserContext(browser, { baseUrl, onBlocked, serviceFixture, ...options }) {
  const proxy = await createE2eBrowserProxy({ baseUrl, onBlocked, serviceFixture });
  let context; let guard;
  const transport = {
    ...proxy,
    snapshot: () => [
      ...proxy.snapshot().map((record) => ({ boundary: "proxy", ...record })),
      ...(guard?.snapshot() ?? []).map((record) => ({ boundary: "routes", ...record })),
    ],
    assertClean() {
      const errors = [];
      for (const boundary of [proxy, guard]) {
        try { boundary?.assertClean(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Browser attempted an unexpected external request", { cause: errors[0] });
    },
    async stop() {
      const errors = [];
      for (const boundary of [proxy, guard]) {
        try { await boundary?.stop(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Browser boundary cleanup failed", { cause: errors[0] });
    },
  };
  try {
    context = await browser.newContext({ ...options, baseURL: baseUrl,
      proxy: proxy.proxyOptions, serviceWorkers: "block" });
    proxy.attach(context);
    guard = await installE2eBrowserRouteGuard(context, { baseUrl, onBlocked });
    return { context, transport };
  } catch (error) {
    await finalizeE2eBrowserLifecycle({ context, transport, error });
    throw error;
  }
}
