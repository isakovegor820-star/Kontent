/** Firefox owns tab-icon requests outside the page's fetch/AbortSignal lifecycle.
 * Observe its native cause through the identical collocated server Request;
 * neither a URL/timestamp guess nor a page-provided event supplies this proof.
 * Missing/changed Playwright internals leave the cancellation unexplained. */
export function observeFirefoxFavicons(context, { baseUrl }) {
  const expectedUrl = new URL(baseUrl).origin + "/icon.svg";
  const pages = new Map(); const native = new WeakMap(); const claimed = new WeakMap();
  const seen = new WeakSet(); const invalid = new WeakSet(); const clients = new WeakMap();
  let enabled = false;
  try { enabled = context.browser?.()?.browserType?.()?.name?.() === "firefox"; } catch { /* No native proof. */ }
  const observePage = page => {
    if (pages.has(page)) return;
    try {
      const connection = page._connection;
      if (typeof connection?.toImpl !== "function") return;
      const manager = connection.toImpl(page)?.delegate?._networkManager;
      if (typeof manager?._session?.on !== "function" || typeof manager?._session?.off !== "function"
        || typeof manager?._requests?.get !== "function") return;
      const onNative = event => {
        try {
          if (typeof event.requestId !== "string" || !event.requestId) return;
          // The network manager's original listener runs first and creates this
          // very Request before dispatching the client event. Never replace it.
          const request = manager._requests.get(event.requestId)?.request;
          if (!request || typeof request !== "object") return;
          if (seen.has(request)) { invalid.add(request); return; }
          seen.add(request);
          if (event.url !== expectedUrl || event.method !== "GET" || event.cause !== "TYPE_IMAGE"
            || event.internalCause !== "TYPE_INTERNAL_IMAGE_FAVICON") return;
          native.set(request, Object.freeze({ page, connection, url: event.url }));
        } catch { /* An unavailable native identity is not an allowance. */ }
      };
      manager._session.on("Network.requestWillBeSent", onNative);
      pages.set(page, { connection, session: manager._session, onNative });
    } catch { /* An unsupported bridge cannot manufacture a native cause. */ }
  };
  const observeRequest = request => {
    try {
      const frame = request.frame(); const page = frame.page(); const registration = pages.get(page);
      if (!registration || request._connection !== registration.connection) return;
      const actual = registration.connection.toImpl(request); const source = native.get(actual);
      if (!source || source.page !== page || source.connection !== registration.connection) return;
      const previous = claimed.get(actual);
      if (previous && previous !== request) { invalid.add(actual); return; }
      if (frame !== page.mainFrame() || request.url() !== source.url || request.method() !== "GET"
        || request.resourceType() !== "image" || request.isNavigationRequest() !== false
        || request.redirectedFrom() !== null || request.headers()["x-aurora-e2e-read-id"]) return;
      claimed.set(actual, request);
      clients.set(request, Object.freeze({ actual, page, url: source.url }));
    } catch { /* Do not certify a missing, disposed or mismatched Request. */ }
  };
  const stop = () => {
    context.off?.("page", observePage); context.off?.("request", observeRequest); context.off?.("close", stop);
    for (const { session, onNative } of pages.values()) session.off("Network.requestWillBeSent", onNative);
    pages.clear();
    // Captured facts survive close for the final diagnostics assertion.
  };
  if (enabled && typeof context.on === "function" && typeof context.pages === "function") {
    context.on("page", observePage); context.on("request", observeRequest); context.on("close", stop);
    for (const page of context.pages()) observePage(page);
  }
  return {
    isCancelledFavicon(row) {
      const proof = clients.get(row.request);
      return Boolean(proof && !invalid.has(proof.actual) && row.page === proof.page && row.url === proof.url
        && row.method === "GET" && row.type === "image" && !row.identity && row.finishedAt == null
        && row.failure === "NS_BINDING_ABORTED" && (row.status == null || row.status === 200));
    },
  };
}
