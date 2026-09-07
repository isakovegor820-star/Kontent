import { expect, it, vi } from "vitest";
import vm from "node:vm";
import { createHash, randomUUID } from "node:crypto";
import { createMainRequestEvidence, readMainCancellationProof } from "./e2e-main-request-evidence.mjs";
import { createMainFaultEvidence, nativeMainHttpStatus } from "./e2e-main-fault-evidence.mjs";

const baseUrl = "https://localhost:12345";
function fixture() {
  let time = 1_000; const page = { evaluate: vi.fn(async () => ({ documentId: "doc" })) }; const evidence = createMainRequestEvidence({ baseUrl, now: () => time });
  evidence.observeNative(page, { kind: "document", documentId: "doc" });
  const request = ({ method = "GET", path = "/api/drafts", type = "fetch", headers = {}, failure = "net::ERR_ABORTED" } = {}) => ({
    url: () => baseUrl + path, method: () => method, resourceType: () => type,
    headers: () => ({ "x-aurora-e2e-read-id": "owned-read-1", ...headers }), failure: () => ({ errorText: failure }),
  });
  const start = (req, target = page) => evidence.observeRequest(req, "main", target);
  const response = (req, status = 200, headers = {}) => evidence.observeResponse({ request: () => req, status: () => status, headers: () => headers });
  const native = (kind, more = {}) => evidence.observeNative(page, { kind, documentId: "doc", id: 1, identity: "owned-read-1", method: "GET", at: time, url: baseUrl + "/api/drafts", ...more });
  return { evidence, page, request, start, response, native, at: value => { time = value; } };
}
it.each(["GET", "PATCH", "POST", "DELETE"])("unproved %s abort remains failure", method => {
  const f = fixture(); const req = f.request({ method }); f.start(req); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it.each(["net::ERR_CONNECTION_RESET", "net::ERR_FAILED", "Connection terminated unexpectedly", "NS_ERROR_NET_RESET"])("caller abort cannot forgive %s", failure => {
  const f = fixture(); const req = f.request({ failure }); f.native("start"); f.start(req); f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
});
it.each(["net::ERR_ABORTED", "NS_BINDING_ABORTED", "cancelled", "Load request cancelled"])("one native caller's %s admits only its exact Request", failure => {
  const f = fixture(); const req = f.request({ failure }); f.native("start"); f.start(req); f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBe("caller_abort_signal");
  const proof = f.evidence.proofs()[0]; expect(readMainCancellationProof(proof).request).toBe(req);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
  const other = f.request({ path: "/api/channels" }); f.start(other); f.evidence.observeFailure(other);
  expect(f.evidence.reason(other)).toBeNull();
});
it.each(["same-url-request", "same-url-native-call", "other-document", "late-abort", "other-page"])("ambiguous or mismatched %s stays failure", kind => {
  const f = fixture(); const req = f.request(); f.native("start");
  if (kind === "other-document") f.evidence.observeNative(f.page, { kind: "document", documentId: "next" });
  f.start(req, kind === "other-page" ? {} : f.page);
  if (kind === "same-url-request") f.start(f.request());
  if (kind === "same-url-native-call") f.native("start", { id: 2 });
  f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.at(kind === "late-abort" ? 9000 : 1200); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
});
it.each(["complete", "no-native-read", "no-pagehide", "no-commit", "failed-document", "new-read", "other-page"])("document navigation %s requires exact native read and completed destination", kind => {
  const f = fixture(); const req = f.request(); if (kind !== "no-native-read") f.native("start"); f.start(req);
  f.at(1100); const doc = f.request({ path: "/app/calendar", type: "document" }); f.start(doc, kind === "other-page" ? {} : f.page);
  if (kind !== "no-pagehide") f.native("leave");
  f.at(1150); f.evidence.observeFailure(req);
  f.at(1200); f.response(doc, kind === "failed-document" ? 500 : 200);
  if (kind !== "no-commit")
  f.at(1250); f.evidence.observeFinished(doc);
  if (kind === "new-read") {
    const later = f.request(); f.native("start", { id: 2 }); f.start(later); f.evidence.observeFailure(later);
    expect(f.evidence.reason(later)).toBeNull(); return;
  }
  expect(f.evidence.reason(req)).toBeNull();
});
it.each(["ack", "rsc", "api-2xx", "rsc-without-prefetch", "rsc-wrong-type"])("existing %s response contract stays narrow", kind => {
  const f = fixture(); const req = f.request({ method: kind === "ack" ? "POST" : "GET",
    path: kind === "ack" ? "/api/product-events" : kind === "api-2xx" ? "/api/drafts" : "/app/calendar?_rsc=test",
    headers: { rsc: "1", "next-router-prefetch": kind === "rsc-without-prefetch" ? "" : "1" } });
  f.start(req); f.response(req, 200, { "content-type": kind === "rsc-wrong-type" ? "application/json" : "text/x-component" }); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBe(kind === "ack" ? "acknowledged_keepalive" : kind === "rsc" ? "completed_rsc_prefetch" : null);
});
it.each(["valid", "wrong-request-id", "wrong-key", "unreleased", "retryable", "successful", "no-response"])("AI cancellation proof %s is tied to HTTP and durable rows", kind => {
  const f = fixture(); const req = f.request({ method: "POST", path: "/api/ai/generate", headers: { "idempotency-key": "key" } }); f.start(req);
  if (kind !== "no-response") f.response(req, 200, { "content-type": "application/x-ndjson", "x-ai-request-id": "server" });
  const proof = { key: kind === "wrong-key" ? "other" : "key", cancellation: { server_request_id: kind === "wrong-request-id" ? "other" : "server",
    status: kind === "successful" ? "succeeded" : "failed", error_code: "ai_generation_cancelled", retryable: kind === "retryable" },
  usage: { status: kind === "unreleased" ? "reserved" : "released", result_payload: null } };
  if (kind !== "valid") expect(() => f.evidence.confirmGenerationCancellation(req, proof)).toThrow();
  else f.evidence.confirmGenerationCancellation(req, proof);
  f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBe(kind === "valid" ? "proved_server_generation_cancellation" : null);
});
it("a certified cancellation removes only the same scoped failed request, never a forged proof", async () => {
  const f = fixture(); const faults = createMainFaultEvidence({ baseUrl });
  faults.beginScope("main", { page: f.page, required: false, rules: [{ method: "GET", readOnly: true, matchUrl: () => true, status: 502, text: "runtime unavailable" }] });
  const req = f.request(); f.native("start"); f.start(req); faults.observeRequest(req, "main", f.page);
  f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req); faults.observeFailure(req, "main", f.page); faults.endScope("main");
  const proofs = f.evidence.proofs();
  expect((await faults.finalize({ cancellations: proofs.map(row => ({ ...row })) })).issues).toHaveLength(1);
  expect((await faults.finalize({ cancellations: proofs })).issues).toEqual([]);
});
it.each(["native", "script", "source-line", "wrong-text"])("N48 resource metadata rejects %s spoofing", kind => {
  const message = { type: () => "error", args: () => kind === "script" ? [{}] : [],
    text: () => kind === "wrong-text" ? "prefix Failed to load resource: the server responded with a status of 422" : "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)",
    location: () => ({ url: baseUrl + "/api/ai/generate", lineNumber: kind === "source-line" ? 1 : 0, columnNumber: 0 }) };
  expect(nativeMainHttpStatus(message)).toBe(kind === "native" ? 422 : null);
});

it("a later cleanup AbortSignal cannot retroactively forgive an earlier failure", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req); f.at(1150); f.native("abort"); f.native("failure", { callerAbort: true });
  expect(f.evidence.reason(req)).toBeNull();
});
it("navigation beginning after the request failed cannot forgive it", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.evidence.observeFailure(req);
  f.at(1150); const doc = f.request({ path: "/app/calendar", type: "document" }); f.start(doc); f.native("leave");
  f.at(1200); f.response(doc); f.evidence.observeFinished(doc);
  expect(f.evidence.reason(req)).toBeNull();
});

it.each(["complete", "truncated", "cancelled", "wrong-native-document"])("native EOF uses its own document identity: %s", async kind => {
  const f = fixture(); const frame = {}; f.page.mainFrame = () => frame;
  const bindings = new Map();
  await f.evidence.install({ exposeBinding: async (name, callback) => { bindings.set(name, callback); }, addInitScript: async () => {} });
  const emit = event => bindings.get("__recordChannelNativeBody")({ page: f.page, frame }, event);
  emit({ kind: "document", documentId: "native-doc" });
  f.evidence.observeNative(f.page, { kind: "document", documentId: "main-doc" });
  const req = f.request({ path: "/api/project-notifications" }); req.frame = () => frame;
  emit({ kind: "start", documentId: kind === "wrong-native-document" ? "foreign-doc" : "native-doc", id: 1, url: req.url(), at: 1000 });
  f.start(req); f.response(req, 200, { "content-type": "application/json" });
  emit({ kind: "complete", documentId: kind === "wrong-native-document" ? "foreign-doc" : "native-doc", id: 1,
    bodyDone: kind !== "truncated", status: 200, contentType: "application/json", bytes: 12,
    jsonValid: kind !== "truncated", cancelled: kind === "cancelled", overflow: false, error: null, at: 1050 });
  f.at(1100); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBe(kind === "complete" ? "completed_native_notifications_read" : null);
});

it.each([950, 1150, 0, NaN])("late-delivered document uses actual browser start %s without forgiving a later navigation", startTime => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.evidence.observeFailure(req);
  f.at(1150); const doc = f.request({ path: "/app/calendar", type: "document" }); doc.timing = () => ({ startTime }); f.start(doc); f.native("leave");
  f.at(1200); f.response(doc); f.evidence.observeFinished(doc);
  // A navigation predating the native read is also not its owning lifetime.
  expect(f.evidence.reason(req)).toBeNull();
});
it("even an exact browser start does not establish the cause of a transport cancellation", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.evidence.observeFailure(req);
  f.at(1150); const doc = f.request({ path: "/app/calendar", type: "document" }); doc.timing = () => ({ startTime: 1050 }); f.start(doc); f.native("leave");
  f.at(1200); f.response(doc); f.evidence.observeFinished(doc);
  expect(f.evidence.reason(req)).toBeNull();
});

it("same-millisecond cleanup abort cannot replace the native network rejection cause", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req);
  f.native("abort"); f.native("failure", { callerAbort: true });
  expect(f.evidence.reason(req)).toBeNull();
});
it("an AbortSignal without the actual native rejection cause does not prove cancellation", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1100); f.native("abort"); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
});

it("a completed navigation cannot forgive an already observed native network rejection", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.at(1050); const doc = f.request({ path: "/app/calendar", type: "document" }); f.start(doc);
  f.at(1100); f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req);
  f.at(1150); f.native("leave"); f.response(doc); f.evidence.observeFinished(doc);
  expect(f.evidence.reason(req)).toBeNull();
});

it("ordinary navigation waits only for captured GET completion", async () => {
  const f = fixture(); const req = f.request(); f.start(req);
  let done = false; const settled = f.evidence.settleReads(f.page, { timeoutMs: 500 }).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false); f.response(req); f.evidence.observeFinished(req);
  await settled; expect(done).toBe(true);
});
it("a captured GET failure prevents navigation and remains unproved", async () => {
  const f = fixture(); const req = f.request(); f.start(req);
  const settled = f.evidence.settleReads(f.page, { timeoutMs: 500 }); f.evidence.observeFailure(req);
  await expect(settled).rejects.toThrow("Captured GET failed"); expect(f.evidence.reason(req)).toBeNull();
});
it("a never-completing GET produces bounded failure", async () => {
  const f = fixture(); f.start(f.request());
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 25 })).rejects.toThrow("did not settle");
});
it("POST is never waited for or reclassified by read settlement", async () => {
  const f = fixture(); const req = f.request({ method: "POST" }); f.start(req);
  await f.evidence.settleReads(f.page, { timeoutMs: 25 }); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
});
it("a later finished event cannot erase an already captured GET failure", async () => {
  const f = fixture(); const req = f.request(); f.start(req);
  const settled = f.evidence.settleReads(f.page, { timeoutMs: 100 });
  f.evidence.observeFailure(req); f.evidence.observeFinished(req);
  await expect(settled).rejects.toThrow("Captured GET failed");
});


it.each(["exact-rsc", "exact-rsc-then-finished", "foreign-request", "foreign-page", "missing-prefetch", "wrong-content-type", "wrong-status"])("read settlement preserves exact certified RSC cancellation: %s", async kind => {
  const f = fixture();
  const req = f.request({ path: "/app/opportunities?_rsc=owned", headers: { rsc: "1", "next-router-prefetch": kind === "missing-prefetch" ? "" : "1" } });
  f.start(req);
  const settled = f.evidence.settleReads(f.page, { timeoutMs: 100 });
  const proved = kind === "foreign-request" || kind === "foreign-page" ? f.request({ path: "/app/opportunities?_rsc=owned", headers: { rsc: "1", "next-router-prefetch": "1" } }) : req;
  if (proved !== req) f.start(proved, kind === "foreign-page" ? {} : f.page);
  f.response(proved, kind === "wrong-status" ? 500 : 200, { "content-type": kind === "wrong-content-type" ? "application/json" : "text/x-component; charset=utf-8" });
  f.evidence.observeFailure(proved);
  if (proved !== req) f.evidence.observeFailure(req);
  if (kind === "exact-rsc-then-finished") f.evidence.observeFinished(req);
  if (kind.startsWith("exact-rsc")) {
    const proof = f.evidence.proofs().find(row => readMainCancellationProof(row).request === req);
    expect(proof.reason).toBe("completed_rsc_prefetch");
    await expect(settled).resolves.toBeUndefined();
    expect(f.evidence.reason(req)).toBe("completed_rsc_prefetch");
  } else await expect(settled).rejects.toThrow("Captured GET failed");
});


it.each(["replacement-after-proof", "replacement-before-failure", "delayed-exact-call"])("opaque GET identity retains its exact caller proof: %s", kind => {
  const f = fixture(); const req = f.request(); f.native("start");
  if (kind === "delayed-exact-call") f.at(9000);
  f.start(req);
  const replace = () => {
    f.native("start", { id: 2, identity: "owned-read-2" });
    const other = f.request({ headers: { "x-aurora-e2e-read-id": "owned-read-2" } });
    f.start(other); return other;
  };
  let other;
  if (kind === "replacement-before-failure") other = replace();
  f.at(kind === "delayed-exact-call" ? 9100 : 1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req);
  if (kind === "replacement-after-proof") {
    expect(f.evidence.reason(req)).toBe("caller_abort_signal"); other = replace();
  }
  if (kind === "delayed-exact-call") {
    f.at(9200); other = replace();
  }
  expect(f.evidence.reason(req)).toBe("caller_abort_signal");
  f.evidence.observeFailure(other); expect(f.evidence.reason(other)).toBeNull();
});

it.each(["missing-header", "wrong-header", "duplicate-request", "duplicate-native", "wrong-method", "caller-collision"])("opaque GET identity rejects %s without temporal fallback", kind => {
  const f = fixture(); const req = f.request({ headers: { "x-aurora-e2e-read-id": kind === "missing-header" ? "" : kind === "wrong-header" ? "other-id" : "owned-read-1" } });
  f.native("start", { method: kind === "wrong-method" ? "POST" : "GET" }); f.start(req);
  if (kind === "duplicate-request") f.start(f.request());
  if (kind === "duplicate-native") f.native("start", { id: 2 });
  if (kind === "caller-collision") f.native("collision");
  f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
});

async function installedFetchFixture() {
  const f = fixture(); const scripts = []; const events = [];
  await f.evidence.install({ exposeBinding: async () => {}, addInitScript: async (script, args) => scripts.push({ script, args }) });
  const originalFetch = vi.fn(async () => new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } }));
  const window = { fetch: originalFetch, __auroraMainReadLifetime: async event => { events.push(event); f.evidence.observeNative(f.page, event); } };
  const state = { window, location: new URL(baseUrl + "/app"), URL, Request, Response, Headers, DOMException, Uint8Array, TextDecoder, TextEncoder, crypto: { randomUUID } };
  vm.createContext(state);
  const installed = scripts.find(entry => entry.script.toString().includes("__auroraMainReadLifetime"));
  state.args = installed.args; vm.runInContext(`(${installed.script.toString()})(args)`, state);
  return { ...f, originalFetch, window, events };
}

it.each(["string", "request", "request-init-replacement"])("GET identity injection preserves fetch inputs and headers: %s", async kind => {
  const f = await installedFetchFixture(); const controller = new AbortController();
  const originalHeaders = new Headers({ "x-project-id": "own-project", "x-input-only": "input" });
  const input = kind === "string" ? baseUrl + "/api/drafts" : new Request(baseUrl + "/api/drafts", { headers: originalHeaders, signal: controller.signal, credentials: "include", cache: "no-store" });
  const init = kind === "request" ? undefined : { headers: kind === "string" ? originalHeaders : new Headers({ "x-project-id": "replacement-project" }), signal: controller.signal, credentials: "same-origin", cache: "reload" };
  const response = await f.window.fetch(input, init); expect(await response.json()).toEqual({ ok: true });
  const [actualInput, actualInit] = f.originalFetch.mock.calls[0]; expect(actualInput).toBe(input);
  const identity = actualInit.headers.get("x-aurora-e2e-read-id"); expect(identity).toMatch(/^[0-9a-f-]{36}$/u);
  expect(actualInit.headers.get("x-project-id")).toBe(kind === "request-init-replacement" ? "replacement-project" : "own-project");
  expect(actualInit.headers.has("x-input-only")).toBe(kind !== "request-init-replacement");
  expect(originalHeaders.has("x-aurora-e2e-read-id")).toBe(false);
  if (init) {
    expect(actualInit.signal).toBe(init.signal); expect(actualInit.credentials).toBe(init.credentials); expect(actualInit.cache).toBe(init.cache);
    expect(init.headers.has("x-aurora-e2e-read-id")).toBe(false);
  }
  expect(f.events.filter(event => event.kind === "start")).toEqual([expect.objectContaining({ identity, method: "GET", url: baseUrl + "/api/drafts" })]);
});

it.each(["foreign-origin", "POST", "HEAD", "caller-collision"])("identity injection does not change unsupported or colliding fetch: %s", async kind => {
  const f = await installedFetchFixture();
  const input = kind === "foreign-origin" ? "https://example.invalid/api/drafts" : baseUrl + "/api/drafts";
  const init = { method: ["POST", "HEAD"].includes(kind) ? kind : "GET", headers: new Headers(kind === "caller-collision" ? { "x-aurora-e2e-read-id": "caller-id" } : {}), ...(kind === "POST" ? { body: "unchanged-body" } : {}) };
  await f.window.fetch(input, init);
  expect(f.originalFetch.mock.calls[0]).toEqual([input, init]);
  expect(f.originalFetch.mock.calls[0][1]).toBe(init);
  expect(f.events.filter(event => event.kind === "start")).toEqual([]);
});

it("safe request snapshot omits query, headers, body, identity and tokens", () => {
  const f = fixture(); const canary = "sensitive-canary";
  const req = f.request({ path: "/api/drafts?key=" + canary, headers: { authorization: canary, "x-aurora-e2e-read-id": canary }, failure: "bad " + canary });
  f.start(req); f.response(req); f.evidence.observeFailure(req);
  const snapshot = f.evidence.snapshot(); expect(snapshot).toHaveLength(1);
  expect(snapshot[0]).toEqual(expect.objectContaining({ id: 1, context: "main", path: "/api/drafts", method: "GET", status: 200, callerPresence: false, reason: null }));
  expect(snapshot[0].urlHash).toMatch(/^[a-f0-9]{64}$/u);
  expect(JSON.stringify(snapshot)).not.toContain(canary); expect(JSON.stringify(snapshot)).not.toContain("?key=");
});


it("instrumented same-URL GETs receive distinct opaque identities", async () => {
  const f = await installedFetchFixture();
  await f.window.fetch(baseUrl + "/api/drafts"); await f.window.fetch(baseUrl + "/api/drafts");
  const calls = f.events.filter(event => event.kind === "start");
  expect(calls).toHaveLength(2); expect(calls[0].identity).not.toBe(calls[1].identity);
  expect(f.originalFetch.mock.calls.map(([, init]) => init.headers.get("x-aurora-e2e-read-id"))).toEqual(calls.map(call => call.identity));
});

it("effective init.headers replacement does not retain an input Request marker", async () => {
  const f = await installedFetchFixture();
  const input = new Request(baseUrl + "/api/drafts", { headers: { "x-aurora-e2e-read-id": "caller-marker", "x-old": "drop" } });
  const init = { headers: { "x-new": "preserve" } }; await f.window.fetch(input, init);
  const actual = f.originalFetch.mock.calls[0][1];
  expect(actual.headers.get("x-aurora-e2e-read-id")).not.toBe("caller-marker");
  expect(actual.headers.get("x-new")).toBe("preserve"); expect(actual.headers.has("x-old")).toBe(false);
  expect(input.headers.get("x-aurora-e2e-read-id")).toBe("caller-marker");
  expect(f.events.some(event => event.kind === "collision")).toBe(false);
});

it("GET identity preserves inherited and non-enumerable RequestInit semantics", async () => {
  const f = await installedFetchFixture(); const controller = new AbortController();
  const init = Object.create({ credentials: "omit", cache: "no-store", signal: controller.signal });
  Object.defineProperty(init, "redirect", { value: "manual" });
  await f.window.fetch(baseUrl + "/api/drafts", init);
  const [input, observed] = f.originalFetch.mock.calls[0]; const actual = new Request(input, observed);
  expect(actual.credentials).toBe("omit"); expect(actual.cache).toBe("no-store"); expect(actual.redirect).toBe("manual");
  expect(observed.signal).toBe(controller.signal); controller.abort(); expect(actual.signal.aborted).toBe(true);
  expect(Object.hasOwn(init, "headers")).toBe(false);
});

it("native rejection object and first cause survive instrumentation unchanged", async () => {
  const f = await installedFetchFixture(); const controller = new AbortController(); const failure = new TypeError("original native network failure");
  f.originalFetch.mockRejectedValueOnce(failure);
  await expect(f.window.fetch(baseUrl + "/api/drafts", { signal: controller.signal })).rejects.toBe(failure);
  controller.abort();
  const failures = f.events.filter(event => event.kind === "failure");
  expect(failures).toHaveLength(1); expect(failures[0].callerAbort).toBe(false);
});


it("header override preserves RequestInit accessor receiver with private fields", async () => {
  const f = await installedFetchFixture(); const controller = new AbortController();
  class Options {
    #parameters = { credentials: "omit", signal: controller.signal };
    get credentials() { return this.#parameters.credentials; }
    get signal() { return this.#parameters.signal; }
  }
  const init = new Options(); const observed = [];
  f.originalFetch.mockImplementation(async (input, options) => {
    const request = new Request(input, options); observed.push(request);
    return new Response("{\"ok\":true}", { headers: { "content-type": "application/json" } });
  });
  await expect(f.originalFetch(baseUrl + "/api/drafts", init)).resolves.toBeInstanceOf(Response);
  await expect(f.window.fetch(baseUrl + "/api/drafts", init)).resolves.toBeInstanceOf(Response);
  expect(observed.map(request => request.credentials)).toEqual(["omit", "omit"]);
  controller.abort(); expect(observed.every(request => request.signal.aborted)).toBe(true);
});


it("frozen RequestInit headers remain compatible with an independent override target", async () => {
  const f = await installedFetchFixture();
  const headers = new Headers({ "x-project-id": "own" }); const init = Object.freeze({ headers, credentials: "omit" });
  await f.window.fetch(baseUrl + "/api/drafts", init);
  const [input, actual] = f.originalFetch.mock.calls[0]; const request = new Request(input, actual);
  expect(request.credentials).toBe("omit"); expect(request.headers.get("x-project-id")).toBe("own");
  expect(request.headers.get("x-aurora-e2e-read-id")).toMatch(/^[0-9a-f-]{36}$/u);
  expect(headers.has("x-aurora-e2e-read-id")).toBe(false);
});

it("invalid primitive init preserves the native failed Promise without instrumentation", async () => {
  const f = await installedFetchFixture(); const failure = new TypeError("native RequestInit failure");
  f.originalFetch.mockRejectedValueOnce(failure);
  await expect(f.window.fetch(baseUrl + "/api/drafts", 42)).rejects.toBe(failure);
  expect(f.originalFetch.mock.calls[0]).toEqual([baseUrl + "/api/drafts", 42]);
  expect(f.events.some(event => event.kind === "start")).toBe(false);
});

it.each(["unknown-then-genuine", "reverse-genuine-order"])("same URL cannot transfer another call's native rejection cause: %s", kind => {
  const f = fixture(); const first = f.request(); f.native("start"); f.start(first);
  const second = f.request({ headers: { "x-aurora-e2e-read-id": "owned-read-2" } });
  f.native("start", { id: 2, identity: "owned-read-2" }); f.start(second);
  f.at(1100);
  if (kind === "unknown-then-genuine") { f.native("failure", { callerAbort: false }); f.evidence.observeFailure(first); }
  f.native("abort", { id: 2, identity: "owned-read-2" }); f.native("failure", { id: 2, identity: "owned-read-2", callerAbort: true }); f.evidence.observeFailure(second);
  if (kind === "reverse-genuine-order") { f.at(1150); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(first); }
  expect(f.evidence.reason(first)).toBe(kind === "unknown-then-genuine" ? null : "caller_abort_signal");
  expect(f.evidence.reason(second)).toBe("caller_abort_signal");
});


it("the unchanged 512-call document cap leaves later GETs unproved", async () => {
  const f = await installedFetchFixture();
  for (let count = 0; count < 513; count++) await f.window.fetch(baseUrl + "/api/drafts");
  expect(f.events.filter(event => event.kind === "start")).toHaveLength(512);
  expect(f.originalFetch.mock.calls.slice(0, 512).every(([, init]) => init.headers.has("x-aurora-e2e-read-id"))).toBe(true);
  expect(f.originalFetch.mock.calls[512]).toEqual([baseUrl + "/api/drafts", undefined]);
  const req = f.request({ headers: { "x-aurora-e2e-read-id": "" } }); f.start(req); f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();
  expect(f.evidence.snapshot()).toEqual([expect.objectContaining({ identityPresent: false, nativeMatchCount: 0, callerMatched: false, reason: null })]);
});

function acknowledgedGenerationFixture({ failure = "net::ERR_ABORTED", otherAckPage = false } = {}) {
  const f = fixture(); const key = "explicit-new-operation";
  const request = f.request({ method: "POST", path: "/api/ai/generate", headers: { "idempotency-key": key, "x-aurora-project-id": "4" }, failure });
  request.postDataJSON = () => ({ channelId: 7 });
  const ackRequest = f.request({ method: "POST", path: "/api/ai/generate/ack", headers: { "idempotency-key": key, "x-aurora-project-id": "4" } });
  f.start(request); f.response(request, 200, { "content-type": "application/x-ndjson", "x-ai-request-id": "generation-request" });
  f.start(ackRequest, otherAckPage ? {} : f.page); f.response(ackRequest, 200, { "content-type": "application/json", "x-ai-request-id": "ack-request", "x-ai-acknowledged": "true" });
  const operation = { user_id: 1, request_key: "web:" + key, server_request_id: "generation-request", project_id: 4, channel_id: 7,
    status: "acknowledged", result_id: 91, result_count: 1, usage_count: 1, usage_status: "committed", usage_operation_id: "generation-request",
    text: "owned result", result_payload: { protocol: "ndjson", text: "owned result", generationResultId: 91 } };
  const ack = { requestId: "ack-request", requestKey: key, status: 200, complete: true, error: null,
    body: { ok: true, status: "committed", generationResultId: 91 } };
  const confirmation = { key, userId: 1, operation, ackRequest, ack };
  const confirm = () => f.evidence.confirmGenerationCompletion?.(request, confirmation);
  f.evidence.observeFailure(request);
  return { ...f, request, ackRequest, confirmation, confirm };
}
it("a complete native ACK and exact durable result settle only their captured AI request", () => {
  const f = acknowledgedGenerationFixture(); expect(f.evidence.reason(f.request)).toBeNull(); f.confirm();
  expect(f.evidence.reason(f.request)).toBe("durably_acknowledged_generation");
  const other = f.request; const proof = f.evidence.proofs()[0];
  expect(readMainCancellationProof(proof).request).toBe(other);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
});
it.each(["pending", "released", "wrong-user", "wrong-key", "wrong-generation-response", "wrong-usage-operation", "wrong-result", "different-text", "duplicate-result", "different-project", "different-channel", "incomplete-ack", "ack-body-error", "wrong-ack-result", "wrong-ack-response", "wrong-ack-key", "other-ack-page"])("unconfirmed AI completion stays failed: %s", kind => {
  const f = acknowledgedGenerationFixture({ otherAckPage: kind === "other-ack-page" }); const { operation, ack } = f.confirmation;
  if (kind === "pending") operation.status = "pending_ack";
  if (kind === "released") operation.usage_status = "released";
  if (kind === "wrong-user") operation.user_id = 2;
  if (kind === "wrong-key") operation.request_key = "web:another-key";
  if (kind === "wrong-generation-response") operation.server_request_id = "another-response";
  if (kind === "wrong-usage-operation") operation.usage_operation_id = "another-operation";
  if (kind === "wrong-result") operation.result_payload.generationResultId = 92;
  if (kind === "different-text") operation.result_payload.text = "different result";
  if (kind === "duplicate-result") operation.result_count = 2;
  if (kind === "different-project") operation.project_id = 5;
  if (kind === "different-channel") operation.channel_id = 8;
  if (kind === "incomplete-ack") ack.complete = false;
  if (kind === "ack-body-error") ack.body.ok = false;
  if (kind === "wrong-ack-result") ack.body.generationResultId = 92;
  if (kind === "wrong-ack-response") ack.requestId = "another-ack";
  if (kind === "wrong-ack-key") ack.requestKey = "another-key";
  try { f.confirm(); } catch (error) { expect(error.message).toMatch(/generation|acknowledg/iu); }
  expect(f.evidence.reason(f.request)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it("even a durable result does not forgive an unrelated connection reset", () => {
  const f = acknowledgedGenerationFixture({ failure: "net::ERR_CONNECTION_RESET" }); f.confirm();
  expect(f.evidence.reason(f.request)).toBeNull();
});

function bodyCancelFixture(kind = "valid") {
  const f = fixture(); const req = f.request({ failure: kind === "reset" ? "net::ERR_CONNECTION_RESET" : "net::ERR_ABORTED" });
  f.native("start"); f.start(req); f.response(req, kind === "http-error" ? 503 : 200, { "content-type": kind === "not-json" ? "text/plain" : "application/json" });
  f.native("body-reader", { readerId: 1 });
  if (kind === "second-reader") f.native("body-reader", { readerId: 2 });
  if (kind !== "no-read") { f.native("body-read-start", { readerId: 1 }); f.native("body-read", { readerId: 1, done: kind === "eof", bytes: 1 }); }
  if (kind === "pending-read") f.native("body-read-start", { readerId: 1 });
  if (kind === "closed") f.native("body-closed", { readerId: 1 });
  if (kind === "prior-native-error") f.native("body-error", { readerId: 1 });
  if (kind === "prior-type-error") f.native("failure", { callerAbort: false });
  if (kind === "duplicate-request") f.start(f.request());
  if (kind === "duplicate-native") f.native("start");
  if (kind === "failure-before-start") f.evidence.observeFailure(req);
  const details = { readerId: kind === "wrong-reader" ? 2 : 1, cancelId: 1, eligible: kind !== "invalid-this" };
  const scope = kind === "wrong-document" ? { documentId: "other" } : kind === "wrong-identity" ? { identity: "foreign" } : {};
  f.native("body-cancel-start", { ...details, ...scope });
  if (kind === "duplicate-cancel") f.native("body-cancel-start", { ...details, cancelId: 2 });
  f.evidence.observeFailure(req);
  if (kind !== "unsettled") f.native("body-cancel-result", { readerId: details.readerId, cancelId: 1, success: kind !== "rejected", ...scope });
  if (kind === "duplicate-result") f.native("body-cancel-result", { readerId: 1, cancelId: 1, success: true });
  return { ...f, req };
}

it("an original open reader's fulfilled cancel proves only its captured GET", () => {
  const f = bodyCancelFixture();
  expect(f.evidence.reason(f.req)).toBe("explicit_native_reader_cancellation");
  expect(readMainCancellationProof(f.evidence.proofs()[0]).request).toBe(f.req);
  const other = f.request({ path: "/api/other" }); f.start(other); f.evidence.observeFailure(other);
  expect(f.evidence.reason(other)).toBeNull();
});
it.each(["reset", "http-error", "not-json", "second-reader", "no-read", "pending-read", "eof", "closed", "prior-native-error", "prior-type-error", "duplicate-request", "duplicate-native", "failure-before-start", "wrong-reader", "invalid-this", "wrong-document", "wrong-identity", "duplicate-cancel", "duplicate-result", "unsettled", "rejected"])("native body cancellation rejects %s without timing forgiveness", kind => {
  const f = bodyCancelFixture(kind); expect(f.evidence.reason(f.req)).toBeNull();
});
it("same-clock late cancel cannot erase a Request failure already observed", () => {
  const f = bodyCancelFixture("failure-before-start");
  expect(f.evidence.reason(f.req)).toBeNull();
  expect(f.evidence.snapshot()[0].bodyCancellation?.startedBeforeFailure).toBe(false);
});
it("reader cancellation preserves the original receiver, arguments and Promise", async () => {
  const f = await installedFetchFixture(); let sourceCancelArgs; let originalPromise;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel(reason) { sourceCancelArgs = reason; } }), { headers: { "content-type": "application/json" } });
  const nativeGetReader = response.body.getReader;
  response.body.getReader = function (...args) {
    const reader = Reflect.apply(nativeGetReader, this, args); const cancel = reader.cancel;
    reader.cancel = function (...cancelArgs) { originalPromise = Reflect.apply(cancel, this, cancelArgs); return originalPromise; };
    return reader;
  };
  f.originalFetch.mockResolvedValueOnce(response); const actual = await f.window.fetch(baseUrl + "/api/drafts"); const reader = actual.body.getReader(); await reader.read();
  const reason = { own: "synthetic", private: "must-not-be-recorded" }; const returned = reader.cancel(reason); expect(returned).toBe(originalPromise); await returned;
  expect(sourceCancelArgs).toBe(reason);
  expect(f.events.filter(e => e.kind === "body-cancel-start")).toEqual([expect.objectContaining({ readerId: 1, cancelId: 1, eligible: true })]);
  expect(f.events.filter(e => e.kind === "body-cancel-result")).toEqual([expect.objectContaining({ readerId: 1, cancelId: 1, success: true })]);
  expect(JSON.stringify(f.events)).not.toContain("must-not-be-recorded");
});


it.each(["pending", "eof", "closed", "network-error", "foreign-reader", "second-reader", "second-cancel"])("original native reader does not manufacture eligibility after %s", async kind => {
  const f = await installedFetchFixture(); let controller;
  const response = new Response(new ReadableStream({ start(value) { controller = value; value.enqueue(new Uint8Array([1])); } }), { headers: { "content-type": "application/json" } });
  f.originalFetch.mockResolvedValueOnce(response); const actual = await f.window.fetch(baseUrl + "/api/drafts"); let reader = actual.body.getReader(); await reader.read();
  let pending;
  if (kind === "pending") { pending = reader.read(); void pending.catch(() => undefined); }
  if (kind === "eof" || kind === "closed") { controller.close(); if (kind === "eof") await reader.read(); await reader.closed; }
  if (kind === "network-error") {
    const error = new TypeError("original network error"); controller.error(error);
    await expect(reader.read()).rejects.toBe(error);
  }
  if (kind === "foreign-reader") {
    const foreign = new ReadableStream({ start(c) { c.enqueue(new Uint8Array([2])); } }).getReader();
    const foreignReason = { private: "must-not-be-recorded" };
    await reader.cancel.call(foreign, foreignReason);
    expect(f.events.filter(e => e.kind === "body-cancel-start")).toEqual([]);
    controller.close(); await reader.closed; return;
  }
  if (kind === "second-reader") { reader.releaseLock(); reader = actual.body.getReader(); controller.enqueue(new Uint8Array([3])); await reader.read(); }
  if (kind === "second-cancel") await reader.cancel();
  if (kind === "network-error") await expect(reader.cancel()).rejects.toBeInstanceOf(TypeError);
  else await reader.cancel();
  if (pending) await pending;
  const events = f.events.filter(e => e.kind === "body-cancel-start");
  expect(events.at(-1)).toMatchObject({ eligible: false });
  if (kind === "network-error") expect(f.events.filter(e => e.kind === "failure")[0]).toMatchObject({ callerAbort: false });
});

it("a rejected native cancel retains the exact failure and cannot produce successful evidence", async () => {
  const f = await installedFetchFixture(); const failure = new Error("native source cancel rejected");
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { return Promise.reject(failure); } }), { headers: { "content-type": "application/json" } });
  f.originalFetch.mockResolvedValueOnce(response); const actual = await f.window.fetch(baseUrl + "/api/drafts"); const reader = actual.body.getReader(); await reader.read();
  await expect(reader.cancel()).rejects.toBe(failure);
  expect(f.events.filter(e => e.kind === "body-cancel-result")).toEqual([expect.objectContaining({ success: false })]);
});

it("a rejected native read remains an error but is no longer pending in diagnostics", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req);
  f.native("body-reader", { readerId: 1 }); f.native("body-read-start", { readerId: 1 });
  f.native("body-error", { readerId: 1 }); f.native("body-read-error", { readerId: 1 });
  expect(f.evidence.snapshot()[0].bodyCancellation).toMatchObject({ pendingReads: 0, nativeError: true });
});


function settlementFixture() {
  const f = fixture(); let sequence = 0;
  const start = (method = "GET") => {
    const req = f.request({ method, path: `/api/settlement-${++sequence}`, headers: { "x-aurora-e2e-read-id": "" } });
    return { req, row: f.start(req) };
  };
  return { ...f, startRead: start };
}
it("a GET added while waiting joins settlement even when the first GET finishes", async () => {
  const f = settlementFixture(); const first = f.startRead();
  const work = f.evidence.settleReads(f.page, { timeoutMs: 65 });
  const second = f.startRead(); f.evidence.observeFinished(first.req);
  await expect(work).rejects.toThrow(/settle|timed|timeout/iu);
  expect(second.row.finishedAt).toBeUndefined();
});
it("a new GET already failed before the next poll still prevents navigation", async () => {
  const f = settlementFixture(); const first = f.startRead();
  const work = f.evidence.settleReads(f.page, { timeoutMs: 100 });
  const second = f.startRead(); f.evidence.observeFailure(second.req); f.evidence.observeFinished(first.req);
  await expect(work).rejects.toThrow("Captured GET failed");
});
it("a chained GET completes before settlement returns", async () => {
  const f = settlementFixture(); const first = f.startRead();
  const work = f.evidence.settleReads(f.page, { timeoutMs: 300 });
  const second = f.startRead(); f.evidence.observeFinished(first.req);
  setTimeout(() => f.evidence.observeFinished(second.req), 55);
  await work; expect(second.row.finishedAt).toBeTypeOf("number");
});
it("an initially empty set waits for GETs exposed by the renderer checkpoint", async () => {
  const f = settlementFixture(); let scheduled;
  f.page.evaluate.mockImplementation(async () => {
    if (!scheduled) { scheduled = f.startRead(); setTimeout(() => f.evidence.observeFinished(scheduled.req), 30); }
    return { documentId: "doc" };
  });
  await f.evidence.settleReads(f.page, { timeoutMs: 250 });
  expect(scheduled.row.finishedAt).toBeTypeOf("number"); expect(f.page.evaluate).toHaveBeenCalledTimes(2);
});
it("a GET starting and finishing inside one checkpoint still requires another fixed point", async () => {
  const f = settlementFixture();
  f.page.evaluate.mockImplementationOnce(async () => {
    const read = f.startRead(); f.evidence.observeFinished(read.req); return { documentId: "doc" };
  });
  await f.evidence.settleReads(f.page, { timeoutMs: 250 });
  expect(f.page.evaluate).toHaveBeenCalledTimes(2);
});
it("a GET failing and finishing inside the checkpoint never becomes completed", async () => {
  const f = settlementFixture();
  f.page.evaluate.mockImplementationOnce(async () => {
    const read = f.startRead(); f.evidence.observeFailure(read.req); f.evidence.observeFinished(read.req); return { documentId: "doc" };
  });
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 250 })).rejects.toThrow("Captured GET failed");
});
it.each(["pending", "late-rejection"])("the renderer checkpoint has one bounded deadline: %s", async kind => {
  const f = settlementFixture(); let reject;
  f.page.evaluate.mockImplementation(() => new Promise((_, fail) => { reject = fail; }));
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 35 })).rejects.toThrow("renderer checkpoint timed out");
  if (kind === "late-rejection") {
    // The original timed-out work is observed immediately; late rejection must
    // not terminate Node before the already failed journey writes evidence.
    reject(new Error("renderer closed after deadline")); await new Promise(resolve => setTimeout(resolve, 0));
  }
});
it("a checkpoint resolving after the absolute deadline cannot win through microtask ordering", async () => {
  const f = settlementFixture();
  f.page.evaluate.mockImplementation(async () => {
    const end = performance.now() + 45; while (performance.now() < end) { /* exact event-loop stall */ }
    return { documentId: "doc" };
  });
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 20 })).rejects.toThrow("did not settle");
});
it("renderer failure is preserved as the original cause", async () => {
  const f = settlementFixture(); const error = new Error("exact renderer failure"); f.page.evaluate.mockRejectedValue(error);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 250 })).rejects.toBe(error);
});
it.each([undefined, {}, { documentId: "foreign" }])("an invalid or changed checkpoint document fails closed: %j", async result => {
  const f = settlementFixture(); f.page.evaluate.mockResolvedValue(result);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 250 })).rejects.toThrow("document changed or was not observed");
});
it.each(["unused", "observed-document", "previous-owned-request"])("the uninitialized-page checkpoint is limited to unused about:blank: %s", async kind => {
  const page = { evaluate: vi.fn(async () => ({ uninitialized: true })) }; const evidence = createMainRequestEvidence({ baseUrl });
  if (kind === "observed-document") evidence.observeNative(page, { kind: "document", documentId: "doc" });
  if (kind === "previous-owned-request") {
    const req = fixture().request(); evidence.observeRequest(req, "main", page); evidence.observeFinished(req);
  }
  const work = evidence.settleReads(page, { timeoutMs: 250 });
  if (kind === "unused") await expect(work).resolves.toBeUndefined();
  else await expect(work).rejects.toThrow("Only an unused about:blank");
});
it.each(["before-entry", "during-checkpoint"])("an unmatched native GET is outstanding even with stable counts: %s", async kind => {
  const f = settlementFixture();
  if (kind === "before-entry") f.native("start");
  else f.page.evaluate.mockImplementationOnce(async () => { f.native("start"); return { documentId: "doc" }; });
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 65 })).rejects.toThrow("did not settle");
});
it("a delayed reciprocal Request must finish before its native GET settles", async () => {
  const f = settlementFixture(); f.native("start"); const req = f.request(); let row;
  const work = f.evidence.settleReads(f.page, { timeoutMs: 250 });
  setTimeout(() => { row = f.start(req); setTimeout(() => f.evidence.observeFinished(req), 25); }, 25);
  await work; expect(row.finishedAt).toBeTypeOf("number");
});
it.each(["wrong-identity", "wrong-document", "duplicate-request", "duplicate-native"])("native settlement cannot borrow a completed %s match", async kind => {
  const f = settlementFixture(); f.native("start");
  const req = f.request({ headers: { "x-aurora-e2e-read-id": kind === "wrong-identity" ? "foreign" : "owned-read-1" } });
  if (kind === "wrong-document") {
    f.evidence.observeNative(f.page, { kind: "document", documentId: "next" });
    f.page.evaluate.mockResolvedValue({ documentId: "next" });
  }
  const work = f.evidence.settleReads(f.page, { timeoutMs: 65 });
  // Observe another start during settlement for the wrong-document case too;
  // stale old-document native work must not match a current-document Request.
  if (kind === "wrong-document") f.native("start", { id: 2, identity: "owned-read-2" });
  f.start(req); f.evidence.observeFinished(req);
  if (kind === "duplicate-request") { const other = f.request(); f.start(other); f.evidence.observeFinished(other); }
  if (kind === "duplicate-native") f.native("start", { id: 2 });
  await expect(work).rejects.toThrow("did not settle");
});
it("held POST and PUT remain pending and an explicit failed PATCH remains recorded", async () => {
  const f = settlementFixture(); const post = f.startRead("POST"); const put = f.startRead("PUT"); const patch = f.startRead("PATCH");
  f.evidence.observeFailure(patch.req); const read = f.startRead(); f.evidence.observeFinished(read.req);
  await f.evidence.settleReads(f.page, { timeoutMs: 100 });
  expect(post.row.finishedAt).toBeUndefined(); expect(put.row.finishedAt).toBeUndefined();
  expect(f.evidence.snapshot().find(row => row.method === "PATCH")).toMatchObject({ failure: "net::ERR_ABORTED", reason: null });
});

function completedRscFixture(kind = "valid", { path: suppliedPath } = {}) {
  const f = fixture();
  const path = suppliedPath ?? (kind === "wrong-path" ? "/api/read?_rsc=own" : kind === "missing-marker" ? "/app/calendar" : "/app/calendar?_rsc=own");
  const req = f.request({ path, method: kind === "mutation" ? "POST" : "GET", failure: kind === "reset" ? "net::ERR_CONNECTION_RESET" : "net::ERR_ABORTED",
    headers: { rsc: kind === "missing-rsc" ? "" : "1", ...(kind === "prefetch-two" ? { "next-router-prefetch": "2" } : {}), ...(kind === "segment-prefetch" ? { "next-router-segment-prefetch": "/_tree" } : {}) } });
  f.native("start", { url: baseUrl + path }); f.start(req);
  f.response(req, kind === "http-error" ? 503 : kind === "partial-status" ? 206 : kind === "created-status" ? 201 : 200, { "content-type": kind === "json" ? "application/json" : "text/x-component; charset=utf-8" });
  if (kind === "other-response") { const other = f.request({ path }); f.start(other); f.response(other, 200, { "content-type": "text/x-component" }); }
  const scope = kind === "wrong-document" ? { documentId: "foreign" } : kind === "wrong-identity" ? { identity: "foreign" } : {};
  const emit = (event, detail = {}) => f.native(event, { readerId: kind === "wrong-reader" ? 2 : 1, ...scope, ...detail });
  f.native("body-reader", { readerId: 1 });
  if (kind === "second-reader") f.native("body-reader", { readerId: 2 });
  if (kind !== "no-start") emit("body-read-start");
  emit("body-read", { done: false, bytes: kind === "empty" ? 0 : 12 });
  if (kind === "prior-read-error") emit("body-read-error");
  if (kind === "prior-closed-error") emit("body-error");
  if (kind === "prior-native-failure") f.native("failure", { callerAbort: false });
  if (kind === "late-cancel") { emit("body-cancel-start", { cancelId: 1, eligible: true }); emit("body-cancel-result", { cancelId: 1, success: true }); }
  if (kind === "delayed-binding") f.evidence.observeFailure(req);
  if (kind !== "no-eof") { emit("body-read-start"); emit("body-read", { done: true, bytes: 0 }); }
  if (kind !== "no-closed") emit("body-closed");
  if (kind === "duplicate-eof") { emit("body-read-start"); emit("body-read", { done: true, bytes: 0 }); }
  if (kind === "duplicate-closed") emit("body-closed");
  if (kind === "pending-read") emit("body-read-start");
  if (kind === "duplicate-native") f.native("start", { id: 2, url: baseUrl + path });
  if (kind === "caller-collision") f.native("collision");
  f.evidence.observeFailure(req);
  return { ...f, req, emit };
}
it.each(["valid", "delayed-binding"])("exact original RSC EOF and fulfilled reader.closed establish completed body: %s", kind => {
  const f = completedRscFixture(kind);
  expect(f.evidence.reason(f.req)).toBe("completed_native_rsc_read");
  const proof = f.evidence.proofs()[0]; expect(readMainCancellationProof(proof).request).toBe(f.req);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
});
it.each(["valid", "delayed-binding"])("the public landing page uses the same exact original active RSC completion: %s", async kind => {
  const f = completedRscFixture(kind, { path: "/?_rsc=own" });
  expect(f.evidence.reason(f.req)).toBe("completed_native_rsc_read");
  const issued = f.evidence.proofs();
  expect(readMainCancellationProof(issued[0])).toMatchObject({ request: f.req, reason: "completed_native_rsc_read" });
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 100 })).resolves.toBeUndefined();
});
it.each(["mutation", "reset", "missing-rsc", "prefetch-two", "http-error", "partial-status", "created-status", "json", "other-response", "wrong-document", "wrong-identity", "wrong-reader", "second-reader", "no-start", "empty", "prior-read-error", "prior-closed-error", "prior-native-failure", "late-cancel", "no-eof", "no-closed", "duplicate-eof", "duplicate-closed", "pending-read", "duplicate-native", "caller-collision"])("public landing RSC completion still rejects %s", kind => {
  const f = completedRscFixture(kind, { path: "/?_rsc=own" });
  expect(f.evidence.reason(f.req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it.each(["/", "/?other=query", "/login?other=query", "/api/read?_rsc=own", "/unknown?_rsc=own"])("public landing proof does not cover the non-matching URL %s", path => {
  const f = completedRscFixture("valid", { path }); expect(f.evidence.reason(f.req)).toBeNull();
});
it.each(["body-read-error", "body-error", "failure", "body-reader", "body-cancel-start", "duplicate-eof", "collision"])("an issued public RSC certificate is revoked by late %s", kind => {
  const f = completedRscFixture("valid", { path: "/?_rsc=own" }); const issued = f.evidence.proofs(); expect(issued).toHaveLength(1);
  if (kind === "duplicate-eof") { f.emit("body-read-start"); f.emit("body-read", { done: true, bytes: 0 }); }
  else f.native(kind, kind === "failure" ? { callerAbort: false } : { readerId: kind === "body-reader" ? 2 : 1 });
  expect(f.evidence.reason(f.req)).toBeNull(); expect(readMainCancellationProof(issued[0])).toBeNull();
});
it.each(["wrong-path", "missing-marker", "mutation", "reset", "missing-rsc", "prefetch-two", "http-error", "partial-status", "created-status", "json", "other-response", "wrong-document", "wrong-identity", "wrong-reader", "second-reader", "no-start", "empty", "prior-read-error", "prior-closed-error", "prior-native-failure", "late-cancel", "no-eof", "no-closed", "duplicate-eof", "duplicate-closed", "pending-read", "duplicate-native", "caller-collision"])("native RSC completion cannot be supplied by %s", kind => {
  const f = completedRscFixture(kind); expect(f.evidence.reason(f.req)).toBeNull();
});
it.each(["body-read-error", "body-error", "failure"])("a real native %s is never erased by later EOF/closed events", event => {
  const f = completedRscFixture("no-eof");
  if (event === "failure") f.native("failure", { callerAbort: false }); else f.emit(event);
  f.emit("body-read-start"); f.emit("body-read", { done: true, bytes: 0 }); f.emit("body-closed");
  expect(f.evidence.reason(f.req)).toBeNull();
});
it("complete RSC evidence settles its failed exact GET without allowing another incomplete read", async () => {
  const f = completedRscFixture(); await expect(f.evidence.settleReads(f.page, { timeoutMs: 100 })).resolves.toBeUndefined();
  const other = f.request({ path: "/app/calendar?_rsc=other", headers: { "x-aurora-e2e-read-id": "other", rsc: "1" } });
  f.start(other); const work = f.evidence.settleReads(f.page, { timeoutMs: 100 }); f.evidence.observeFailure(other);
  await expect(work).rejects.toThrow("Captured GET failed"); expect(f.evidence.reason(other)).toBeNull();
});

it("the existing segment-prefetch certificate retains its original contract", () => {
  const f = completedRscFixture("segment-prefetch");
  expect(f.evidence.reason(f.req)).toBe("completed_rsc_prefetch");
});

it.each(["body-read-error", "failure", "body-reader", "duplicate-native", "duplicate-request", "collision", "changed-reason"])(
  "an issued certificate cannot hide final evidence that changes its validity: %s", async kind => {
    const f = completedRscFixture();
    const faults = createMainFaultEvidence({ baseUrl });
    faults.beginScope("main", { page: f.page, required: false,
      rules: [{ method: "GET", readOnly: true, matchUrl: () => true, status: 502, text: "owned outage" }] });
    faults.observeRequest(f.req, "main", f.page); faults.observeFailure(f.req, "main", f.page); faults.endScope("main");
    const issued = f.evidence.proofs(); expect(issued).toHaveLength(1);
    if (kind === "duplicate-native") f.native("start", { id: 2 });
    else if (kind === "duplicate-request") f.start(f.request({ path: "/app/calendar?_rsc=own", headers: { rsc: "1" } }));
    else if (kind === "collision") f.native("collision");
    else if (kind === "changed-reason") { f.native("abort"); f.native("failure", { callerAbort: true }); }
    else f.native(kind, kind === "failure" ? { callerAbort: false } : { readerId: kind === "body-reader" ? 2 : 1 });
    expect(f.evidence.reason(f.req)).toBe(kind === "changed-reason" ? "caller_abort_signal" : null);
    expect(readMainCancellationProof(issued[0])).toBeNull();
    const final = await faults.finalize({ cancellations: issued });
    expect(final.issues).toHaveLength(1);
  },
);

it("an unchanged current certificate still admits only its original Request", async () => {
  const f = completedRscFixture(); const issued = f.evidence.proofs();
  const other = f.request({ path: "/api/unrelated", headers: { "x-aurora-e2e-read-id": "unrelated" } });
  f.start(other); f.evidence.observeFailure(other);
  expect(readMainCancellationProof(issued[0])).toMatchObject({ request: f.req, reason: "completed_native_rsc_read" });
  expect(readMainCancellationProof({ ...issued[0] })).toBeNull();
  const faults = createMainFaultEvidence({ baseUrl });
  faults.beginScope("main", { page: f.page, required: false,
    rules: [{ method: "GET", readOnly: true, matchUrl: () => true, status: 502, text: "owned outage" }] });
  for (const request of [f.req, other]) { faults.observeRequest(request, "main", f.page); faults.observeFailure(request, "main", f.page); }
  faults.endScope("main");
  const final = await faults.finalize({ cancellations: issued }); expect(final.issues).toHaveLength(1);
});


function completedJsonFixture(kind = "valid") {
  const f = fixture(); const path = kind === "wrong-path" ? "/app/media" : "/api/media/generations";
  const req = f.request({ path, method: kind === "mutation" ? "POST" : "GET", type: kind === "non-fetch" ? "xhr" : "fetch",
    failure: kind === "reset" ? "net::ERR_CONNECTION_RESET" : "net::ERR_ABORTED",
    headers: { "x-aurora-e2e-read-id": kind === "missing-identity" ? "" : "owned-read-1" } });
  f.native("start", { url: baseUrl + path }); f.start(req, kind === "wrong-page" ? {} : f.page);
  f.response(req, kind === "http-error" ? 500 : kind === "partial-status" ? 206 : kind === "created-status" ? 201 : 200,
    { "content-type": kind === "wrong-content-type" ? "text/plain" : "application/json; charset=utf-8" });
  const scope = kind === "wrong-document" ? { documentId: "foreign" } : kind === "wrong-identity" ? { identity: "foreign" } : {};
  const emit = (event, details = {}) => f.native(event, { readerId: kind === "wrong-reader" ? 2 : 1, ...scope, ...details });
  f.native("body-reader", { readerId: 1 });
  if (kind === "second-reader") f.native("body-reader", { readerId: 2 });
  if (kind !== "no-start") emit("body-read-start");
  const bytes = kind === "oversize" ? 65_537 : kind === "at-limit" ? 65_536 : kind === "empty" ? 0 : 7;
  emit("body-read", { done: false, bytes });
  if (kind === "prior-read-error") emit("body-read-error");
  if (kind === "prior-closed-error") emit("body-error");
  if (kind === "prior-native-failure") f.native("failure", { callerAbort: false });
  if (kind === "late-cancel") { emit("body-cancel-start", { cancelId: 1, eligible: false }); emit("body-cancel-result", { cancelId: 1, success: true }); }
  if (kind === "delayed-binding") f.evidence.observeFailure(req);
  if (kind !== "no-eof") { emit("body-read-start"); emit("body-read", { done: true, bytes: 0 }); }
  if (kind !== "no-closed") emit("body-closed");
  if (kind !== "no-json") emit("body-json", { valid: kind !== "malformed", bytes: kind === "byte-mismatch" ? 8 : bytes, overflow: kind === "overflow" });
  if (kind === "duplicate-json") emit("body-json", { valid: true, bytes });
  if (kind === "duplicate-eof") { emit("body-read-start"); emit("body-read", { done: true, bytes: 0 }); }
  if (kind === "duplicate-closed") emit("body-closed");
  if (kind === "pending-read") emit("body-read-start");
  if (kind === "duplicate-native") f.native("start", { id: 2, url: baseUrl + path });
  if (kind === "duplicate-request") f.start(f.request({ path }));
  if (kind === "collision") f.native("collision");
  f.evidence.observeFailure(req); return { ...f, req, emit };
}
it.each(["valid", "delayed-binding", "at-limit"])("exact original valid JSON EOF proves only protocol completion: %s", async kind => {
  const f = completedJsonFixture(kind); expect(f.evidence.reason(f.req)).toBe("completed_native_json_read");
  const proof = f.evidence.proofs()[0]; expect(readMainCancellationProof(proof).request).toBe(f.req);
  expect(readMainCancellationProof({ ...proof })).toBeNull();
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 100 })).resolves.toBeUndefined();
});
it.each(["wrong-path", "mutation", "non-fetch", "reset", "missing-identity", "wrong-page", "http-error", "partial-status", "created-status",
  "wrong-content-type", "wrong-document", "wrong-identity", "wrong-reader", "second-reader", "no-start", "empty", "oversize", "overflow",
  "prior-read-error", "prior-closed-error", "prior-native-failure", "late-cancel", "no-eof", "no-closed", "no-json", "malformed", "byte-mismatch",
  "duplicate-json", "duplicate-eof", "duplicate-closed", "pending-read", "duplicate-native", "duplicate-request", "collision"])(
  "JSON completion cannot be supplied by %s", kind => {
    const f = completedJsonFixture(kind); expect(f.evidence.reason(f.req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
  },
);
it.each(["body-read-error", "body-error", "failure", "body-reader", "body-json", "body-cancel-start"])("later %s revokes an issued JSON certificate", kind => {
  const f = completedJsonFixture(); const issued = f.evidence.proofs(); expect(issued).toHaveLength(1);
  if (kind === "failure") f.native(kind, { callerAbort: false });
  else f.emit(kind, kind === "body-reader" ? { readerId: 2 } : kind === "body-json" ? { valid: false, bytes: 7 } : {});
  expect(f.evidence.reason(f.req)).toBeNull(); expect(readMainCancellationProof(issued[0])).toBeNull();
});
it.each(["valid", "malformed", "oversize", "clone-only"])("the emitted observer inspects only original returned JSON bytes: %s", async kind => {
  const f = await installedFetchFixture(); const text = kind === "malformed" ? "PRIVATE_INVALID_JSON" : kind === "oversize" ? JSON.stringify("x".repeat(65_536)) : '{"value":"PRIVATE_BODY_CANARY"}';
  const bytes = new TextEncoder().encode(text); let pulls = 0;
  const body = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(bytes); controller.close(); } });
  const original = new Response(body, { headers: { "content-type": "application/json" } }); f.originalFetch.mockResolvedValueOnce(original);
  const response = await f.window.fetch(baseUrl + "/api/media/generations"); expect(response).toBe(original);
  expect(response.bodyUsed).toBe(false); expect(f.events.some(event => event.kind === "body-reader")).toBe(false);
  const reader = (kind === "clone-only" ? response.clone() : response).body.getReader(); const first = await reader.read();
  if (kind !== "clone-only") expect(first.value).toBe(bytes);
  expect((await reader.read()).done).toBe(true); expect(pulls).toBe(1);
  const events = f.events.filter(event => event.kind === "body-json");
  if (kind === "clone-only") expect(events).toEqual([]);
  else expect(events).toEqual([expect.objectContaining({ valid: kind === "valid", overflow: kind === "oversize", bytes: bytes.byteLength })]);
  expect(JSON.stringify(events)).not.toContain("PRIVATE_");
});

it("JSON diagnostic metadata never exports an invalid raw byte-count field", () => {
  const f = completedJsonFixture("no-json"); f.emit("body-json", { valid: true, bytes: "PRIVATE_BYTE_COUNT_CANARY", overflow: false });
  expect(f.evidence.reason(f.req)).toBeNull(); expect(JSON.stringify(f.evidence.snapshot())).not.toContain("PRIVATE_BYTE_COUNT_CANARY");
  expect(f.evidence.snapshot()[0].bodyJson.bytes).toBeNull();
});


it("request diagnostics retain observed lifecycle scalars without asserting the cancellation cause", () => {
  const f = fixture(); f.at(1000.25); f.native("start"); const req = f.request(); f.start(req);
  f.at(1010.5); f.native("abort"); f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req);
  f.at(1020.75); f.evidence.observeFinished(req);
  expect(f.evidence.snapshot()[0]).toMatchObject({ resourceType: "fetch", startedAt: 1000.25, failedAt: 1010.5, finishedAt: 1020.75,
    nativeStartedAt: 1000.25, nativeAbortedAt: 1010.5, observedDocumentHashAtRequestStart: createHash("sha256").update("doc").digest("hex"), reason: null });
  expect(f.evidence.reason(req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it("an image keeps only the init document observed at Request start, even after another document is observed", () => {
  const f = fixture(); const original = randomUUID(); f.evidence.observeNative(f.page, { kind: "document", documentId: original });
  const req = f.request({ path: "/icon.svg", type: "image", headers: { "x-aurora-e2e-read-id": "" } }); f.start(req);
  f.evidence.observeNative(f.page, { kind: "document", documentId: "next-document" }); f.at(1010); f.evidence.observeFailure(req);
  const snapshot = f.evidence.snapshot();
  expect(snapshot[0]).toMatchObject({ resourceType: "image", startedAt: 1000, finishedAt: null, failedAt: 1010,
    nativeStartedAt: null, nativeAbortedAt: null, observedDocumentHashAtRequestStart: createHash("sha256").update(original).digest("hex"), callerMatched: false, reason: null });
  expect(JSON.stringify(snapshot).includes(original)).toBe(false); expect(f.evidence.proofs()).toEqual([]);
});
it.each([undefined, null, NaN, Infinity, -Infinity, -1, Number.MAX_SAFE_INTEGER + 1, "PRIVATE_TIME_CANARY", {}])("malformed diagnostic time case %# stays null without entering an admission", invalid => {
  const f = fixture(); f.at(invalid); f.native("start"); const req = f.request(); f.start(req); f.native("abort");
  f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req); f.evidence.observeFinished(req);
  const row = f.evidence.snapshot()[0];
  for (const field of ["startedAt", "finishedAt", "failedAt", "nativeStartedAt", "nativeAbortedAt"]) expect(row[field]).toBeNull();
  expect(JSON.stringify(row).includes("PRIVATE_TIME_CANARY")).toBe(false); expect(f.evidence.reason(req)).toBeNull();
});
it.each([0, Number.MAX_SAFE_INTEGER])("valid boundary diagnostic timestamp %s is retained", time => {
  const f = fixture(); f.at(time); f.native("start"); const req = f.request(); f.start(req); f.native("abort");
  f.native("failure", { callerAbort: false }); f.evidence.observeFailure(req); f.evidence.observeFinished(req);
  const row = f.evidence.snapshot()[0];
  for (const field of ["startedAt", "finishedAt", "failedAt", "nativeStartedAt", "nativeAbortedAt"]) expect(row[field]).toBe(time);
  expect(f.evidence.reason(req)).toBeNull();
});
it.each(["wrong-identity", "wrong-document", "wrong-page", "duplicate-native", "duplicate-request"])("native timestamps cannot be borrowed from %s", kind => {
  const f = fixture(); const req = f.request(); f.start(req);
  const scope = kind === "wrong-identity" ? { identity: "other" } : kind === "wrong-document" ? { documentId: "other" } : {};
  if (kind === "wrong-page") f.evidence.observeNative({}, { kind: "start", documentId: "doc", identity: "owned-read-1", method: "GET", url: req.url(), at: 1000, id: 1 });
  else { f.native("start", scope); f.at(1010); f.native("abort", scope); }
  if (kind === "duplicate-native") f.native("start", { id: 2 });
  if (kind === "duplicate-request") f.start(f.request());
  f.evidence.observeFailure(req);
  expect(f.evidence.snapshot()[0]).toMatchObject({ nativeStartedAt: null, nativeAbortedAt: null, callerMatched: false, reason: null });
  expect(f.evidence.proofs()).toEqual([]);
});
it("unavailable or malformed resource/document metadata does not expose arbitrary input", () => {
  const f = fixture(); const canary = randomUUID();
  f.evidence.observeNative(f.page, { kind: "document", documentId: { private: canary } });
  const req = f.request({ type: canary }); f.start(req); f.evidence.observeFailure(req);
  const row = f.evidence.snapshot()[0]; expect(row).toMatchObject({ resourceType: null, observedDocumentHashAtRequestStart: null, reason: null });
  expect(JSON.stringify(row).includes(canary)).toBe(false);
});
it("snapshot reads only retained facts and cannot create or strengthen a cancellation certificate", () => {
  const f = fixture(); const req = f.request(); f.native("start"); f.start(req); f.at(1100); f.native("abort"); f.native("failure", { callerAbort: true }); f.evidence.observeFailure(req);
  const proof = f.evidence.proofs()[0]; expect(readMainCancellationProof(proof).request).toBe(req);
  const forbidden = vi.fn(() => { throw new Error("snapshot called a browser API"); });
  for (const field of ["url", "headers", "method", "resourceType", "failure", "timing", "postDataJSON", "response"]) req[field] = forbidden;
  f.page.evaluate = forbidden;
  const snapshot = f.evidence.snapshot(); expect(snapshot[0].reason).toBe("caller_abort_signal");
  expect(readMainCancellationProof(proof).request).toBe(req); expect(forbidden).not.toHaveBeenCalled();
  snapshot[0].startedAt = 9999; snapshot[0].nativeAbortedAt = 9999;
  expect(f.evidence.snapshot()[0]).toMatchObject({ startedAt: 1000, nativeAbortedAt: 1100 });
});

it.each(['before-entry','during-checkpoint'])('a terminal native caller cancellation needs no invented Playwright Request: %s',async when=>{
  const f=settlementFixture();const cancelled=()=>{f.native('start');f.at(1010);f.native('abort');f.at(1011);f.native('failure',{callerAbort:true});};
  if(when==='before-entry')cancelled();else f.page.evaluate.mockImplementationOnce(async()=>{cancelled();return {documentId:'doc'};});
  await expect(f.evidence.settleReads(f.page,{timeoutMs:80})).resolves.toBeUndefined();
  expect(f.evidence.snapshot()).toEqual([]);expect(f.evidence.proofs()).toEqual([]);
});
it.each(['missing-abort','pending','network-first','collision','duplicate-native','other-document','bad-clock','foreign-origin','mutation'])('unmatched %s native work cannot settle as caller cancellation',async kind=>{
  const f=settlementFixture();const scope=kind==='other-document'?{documentId:'other'}:kind==='foreign-origin'?{url:'https://foreign.invalid/api/drafts'}:kind==='mutation'?{method:'POST'}:{};
  f.native('start',scope);if(kind==='network-first')f.native('failure',{...scope,callerAbort:false});f.at(1010);
  if(kind!=='missing-abort')f.native('abort',scope);
  f.at(kind==='bad-clock'?1009:1011);if(kind!=='pending')f.native('failure',{...scope,callerAbort:true});
  if(kind==='collision')f.native('collision');if(kind==='duplicate-native')f.native('start',scope);
  if(kind==='other-document')f.page.evaluate.mockImplementationOnce(async()=>{f.native('start',{id:2,identity:'new-foreign',...scope});f.native('abort',{id:2,identity:'new-foreign',...scope});f.native('failure',{id:2,identity:'new-foreign',...scope,callerAbort:true});return {documentId:'doc'};});
  await expect(f.evidence.settleReads(f.page,{timeoutMs:40})).rejects.toThrow('did not settle');
  expect(f.evidence.proofs()).toEqual([]);
});
it('a late reciprocal Request with an unrelated network failure remains a hard failure',async()=>{
  const f=settlementFixture();f.native('start');f.at(1010);f.native('abort');f.at(1011);f.native('failure',{callerAbort:true});
  f.page.evaluate.mockImplementationOnce(async()=>{const req=f.request({failure:'net::ERR_CONNECTION_RESET'});f.start(req);f.evidence.observeFailure(req);return {documentId:'doc'};});
  await expect(f.evidence.settleReads(f.page,{timeoutMs:80})).rejects.toThrow('Captured GET failed');
  expect(f.evidence.proofs()).toEqual([]);
});

it.each(["valid", "delayed-binding"])("the login page uses the same exact original active RSC completion: %s", async kind => {
  const f = completedRscFixture(kind, { path: "/login?_rsc=own" });
  expect(f.evidence.reason(f.req)).toBe("completed_native_rsc_read");
  const issued = f.evidence.proofs();
  expect(readMainCancellationProof(issued[0])).toMatchObject({ request: f.req, reason: "completed_native_rsc_read" });
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 100 })).resolves.toBeUndefined();
});
it.each(["mutation", "reset", "missing-rsc", "prefetch-two", "http-error", "partial-status", "created-status", "json", "other-response", "wrong-document", "wrong-identity", "wrong-reader", "second-reader", "no-start", "empty", "prior-read-error", "prior-closed-error", "prior-native-failure", "late-cancel", "no-eof", "no-closed", "duplicate-eof", "duplicate-closed", "pending-read", "duplicate-native", "caller-collision"])("login RSC completion still rejects %s", kind => {
  const f = completedRscFixture(kind, { path: "/login?_rsc=own" });
  expect(f.evidence.reason(f.req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
});
it.each(["body-read-error", "body-error", "failure", "body-reader", "body-cancel-start", "duplicate-eof", "collision"])("an issued login RSC certificate is revoked by late %s", kind => {
  const f = completedRscFixture("valid", { path: "/login?_rsc=own" }); const issued = f.evidence.proofs(); expect(issued).toHaveLength(1);
  if (kind === "duplicate-eof") { f.emit("body-read-start"); f.emit("body-read", { done: true, bytes: 0 }); }
  else f.native(kind, kind === "failure" ? { callerAbort: false } : { readerId: kind === "body-reader" ? 2 : 1 });
  expect(f.evidence.reason(f.req)).toBeNull(); expect(readMainCancellationProof(issued[0])).toBeNull();
});

it("serializes only RSC protocol facts, never the header or query values", () => {
  const f = fixture(); const canary = "PRIVATE_RSC_HEADER_CANARY";
  const req = f.request({ path: "/login?_rsc=" + canary,
    headers: { rsc: canary, "next-router-prefetch": canary, "next-router-segment-prefetch": canary } });
  f.start(req); f.response(req, 200, { "content-type": "text/x-component" });
  const rows = f.evidence.snapshot();
  expect(rows[0].rscProtocol).toEqual({ request: false, query: true, prefetch: true, response: true });
  expect(JSON.stringify(rows)).not.toContain(canary);
});

it.each(['no-signal','other-request','POST','late-failure','real-reset'])('Linux WebKit cancellation retains causal guards: %s',kind=>{
  const f=fixture();const req=f.request({method:kind==='POST'?'POST':'GET',failure:kind==='real-reset'?'Connection terminated unexpectedly':'Load request cancelled'});
  f.native('start');f.start(req);if(kind==='other-request')f.start(f.request());
  f.at(1100);if(kind!=='no-signal')f.native('abort');f.native('failure',{callerAbort:kind!=='no-signal'});
  f.at(kind==='late-failure'?9000:1200);f.evidence.observeFailure(req);
  expect(f.evidence.reason(req)).toBeNull();expect(f.evidence.proofs()).toEqual([]);
});

it("preserves the native signal timestamp when Firefox drops the separate abort binding", async () => {
  const f = await installedFetchFixture(); const controller = new AbortController();
  const send = f.window.__auroraMainReadLifetime;
  f.window.__auroraMainReadLifetime = async event => { if (event.kind !== "abort") await send(event); };
  f.originalFetch.mockImplementation((input, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const work = f.window.fetch(baseUrl + "/api/drafts", { signal: controller.signal });
  const start = f.events.find(event => event.kind === "start");
  const request = f.request({ headers: { "x-aurora-e2e-read-id": start.identity } });
  f.at(start.at); f.start(request);
  controller.abort(); await expect(work).rejects.toBe(controller.signal.reason);
  expect(f.events.some(event => event.kind === "abort")).toBe(false);
  const failure = f.events.find(event => event.kind === "failure");
  f.at(failure.at); f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBe("caller_abort_signal");
});
it.each([null, -1, 999, 1200, "1100", NaN, Infinity])("does not replace missing signal evidence with an invalid timestamp: %s", timestamp => {
  const f = fixture(); const request = f.request(); f.native("start"); f.start(request); f.at(1100);
  f.native("failure", { callerAbort: true, signalAbortedAt: timestamp }); f.evidence.observeFailure(request);
  expect(f.evidence.reason(request)).toBeNull();
});
