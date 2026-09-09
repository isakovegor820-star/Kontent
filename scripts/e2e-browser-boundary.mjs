import assert from "node:assert/strict";
import { parseOwnedE2eBrowserOrigin } from "./e2e-browser-origin.mjs";

/** Browser HTTP routing is per context; new contexts never inherit another one's guard. */
export async function installE2eBrowserBoundary(context, { baseUrl, onBlocked = () => {} }) {
  const base = parseOwnedE2eBrowserOrigin(baseUrl);
  const blocked = [];
  const handler = async (route) => {
    const request = route.request();
    let url;
    try { url = new URL(request.url()); } catch { /* A malformed destination is denied. */ }
    if (url && (url.origin === base.origin || url.protocol === "data:" || url.protocol === "blob:")) {
      // Keep existing later/earlier fixture handlers intact; never alter app responses.
      await route.fallback();
      return;
    }
    // No path, host, query, body, userinfo or header can leak a one-time credential.
    const record = { id: blocked.length + 1, kind: "external_request", method: request.method(),
      resourceType: request.resourceType(), protocol: url?.protocol ?? "invalid" };
    blocked.push(record);
    onBlocked({ ...record });
    await route.abort("blockedbyclient");
  };
  await context.route("**/*", handler);
  return {
    snapshot: () => blocked.map((record) => ({ ...record })),
    assertClean: () => assert.equal(blocked.length, 0, "browser attempted an unexpected external request"),
    stop: () => context.unroute("**/*", handler),
  };
}
