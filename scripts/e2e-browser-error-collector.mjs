import assert from "node:assert/strict";
import { createHash } from "node:crypto";

/** Browser diagnostics remain live through close. Only an exact, asserted HTTP
 * failure may explain its native resource console message; page script errors
 * and crashes never receive that allowance. Persist metadata, never token URLs. */
export function createE2eBrowserErrorCollector({ baseUrl, classifyKnownConsole = () => null }) {
  const origin = new URL(baseUrl).origin;
  const contexts = new Map();
  const seenErrors = new WeakSet(); const seenConsoles = new WeakSet(); const knownBrowserObservations = [];
  const pages = new Map(); const consoles = []; const failures = []; const expected = new Map(); const responses = new Map();
  const safePath = (url) => { try { const parsed = new URL(url); return parsed.origin === origin ? parsed.pathname : "[other-origin]"; } catch { return "[unknown]"; } };
  function recordError(error, page) {
    if (seenErrors.has(error)) return;
    seenErrors.add(error); if (page) attach(page);
    failures.push({ kind: "pageerror", page: page ? [...pages.keys()].indexOf(page) : null });
  }
  function recordConsole(message, page) {
    if (seenConsoles.has(message) || message.type() !== "error") return;
    seenConsoles.add(message); if (page) attach(page);
    const known = classifyKnownConsole({ message, page });
    if (known) { knownBrowserObservations.push(known); return; }
    const text = message.text(); const location = message.location();
    // Script console.error carries arguments and a script location. Matching text
    // alone cannot turn it into an expected browser HTTP resource error.
    const status = /^Failed to load resource: the server responded with a status of ([45][0-9]{2})(?: \([^\r\n]*\))?$/u.exec(text)?.[1];
    consoles.push({ page, index: page ? [...pages.keys()].indexOf(page) : null, url: location.url, status: status ? Number(status) : null,
      nativeResource: Boolean(status) && message.args().length === 0 && location.lineNumber === 0 && location.columnNumber === 0,
      digest: createHash("sha256").update(text).digest("hex") });
  }
  function recordResponse(response, page) {
    if (response.status() < 400) return;
    const request = response.request(); if (responses.has(request)) return;
    if (page) attach(page);
    responses.set(request, { page, url: response.url(), status: response.status(), method: request.method(), path: safePath(response.url()) });
  }
  function attach(page) {
    if (pages.has(page)) return;
    const index = pages.size;
    const handlers = {
      pageerror: (error) => recordError(error, page),
      response: (response) => recordResponse(response, page),
      crash: () => failures.push({ kind: "crash", page: index }),
      console: (message) => recordConsole(message, page),
    };
    pages.set(page, handlers);
    for (const [event, handler] of Object.entries(handlers)) page.on(event, handler);
  }
  return {
    attach,
    observeContext(context) {
      assert(!contexts.has(context), "browser context already observed");
      const handlers = { page: attach, weberror: (event) => recordError(event.error(), event.page()),
        console: (message) => recordConsole(message, message.page()),
        response: (response) => recordResponse(response, response.request().frame().page()) };
      contexts.set(context, handlers);
      for (const [event, handler] of Object.entries(handlers)) context.on(event, handler);
      for (const page of context.pages()) attach(page);
    },
    async expectHttpError(response, { method, path, status, error }) {
      assert(Number.isInteger(status) && status >= 400 && status <= 599, "expected HTTP error status required");
      assert.equal(typeof error, "string"); assert(error.length > 0, "expected response error code required");
      const request = response.request(); const url = new URL(response.url());
      assert.equal(url.origin, origin); assert.equal(url.pathname, path); assert.equal(request.method(), method);
      assert.equal(response.status(), status); assert.equal((await response.json()).error, error);
      const page = request.frame().page(); assert(responses.has(request), "expected response must have been observed from this actual request"); assert(pages.has(page), "expected response must belong to an observed page");
      // The same actual request cannot be registered twice to excuse extra errors.
      assert(!expected.has(request), "HTTP error response already registered");
      expected.set(request, { page, url: url.href, status, method, path, error });
    },
    snapshot() {
      const available = [...expected.values()]; const knownHttpErrors = []; const unexpected = [...failures];
      for (const [request, response] of responses) {
        if (!expected.has(request)) unexpected.push({ kind: "unexpected_http", page: response.page ? [...pages.keys()].indexOf(response.page) : null,
          method: response.method, path: response.path, status: response.status });
      }
      for (const record of consoles) {
        const index = record.nativeResource ? available.findIndex((row) => row.page === record.page && row.url === record.url && row.status === record.status) : -1;
        if (index >= 0) {
          const [match] = available.splice(index, 1);
          knownHttpErrors.push({ page: record.index, method: match.method, path: match.path, status: match.status, error: match.error });
        } else unexpected.push({ kind: "console", page: record.index, path: safePath(record.url), digest: record.digest });
      }
      return { unexpected, knownHttpErrors, knownBrowserObservations: [...knownBrowserObservations], observedPages: pages.size };
    },
    assertClean() { assert.deepEqual(this.snapshot().unexpected, [], "unexpected browser diagnostics after cleanup"); },
    stop() { for (const [context, handlers] of contexts) for (const [event, handler] of Object.entries(handlers)) context.off(event, handler); for (const [page, handlers] of pages) for (const [event, handler] of Object.entries(handlers)) page.off(event, handler); },
  };
}
