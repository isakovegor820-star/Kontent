import { expect, it } from "vitest";
import vm from "node:vm";
import { createHash, randomUUID, webcrypto } from "node:crypto";
import { installEditorialNativeBodyObserver } from "./e2e-editorial-native-body-observer.mjs";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";

const baseUrl = "https://localhost:12345";
const path = "/api/drafts/41/editorial/decisions";
const requestId = "opaque-request-correlation-canary";
const ack = { ok: true, requestId, decisionId: 19,
  workflow: { draftId: 41, projectId: 8, version: 4, currentRevisionId: 17, submittedRevisionId: 17,
    approvedRevisionId: 17, approvedContentHash: "a".repeat(64), state: "approved", privateNote: "PRIVATE_BODY_CANARY" },
  resetToken: "PRIVATE_BODY_CANARY" };
const payload = { requestId: 13, requestVersion: 1, workflowVersion: 3, revisionId: 17, contentHash: "a".repeat(64),
  decision: "approve", note: "PRIVATE_REQUEST_CANARY" };
const sha = value => createHash("sha256").update(value).digest("hex");

async function fixture({ text = JSON.stringify(ack), mode = "closed", integration = false, transformEvent = event => event } = {}) {
  const callbacks = new Map(), scripts = [], events = [], actual = [], chunks = [new TextEncoder().encode(text)];
  let controller, observer, evidence;
  const stream = new ReadableStream({ start(value) { controller = value; controller.enqueue(chunks[0]); if (mode === "closed") controller.close(); } });
  const response = new Response(stream, { headers: { "content-type": "application/json", "x-request-id": requestId } });
  const frame = {}, page = { mainFrame: () => frame, context: () => context }; frame.page = () => page;
  const context = { exposeBinding: async (name, callback) => callbacks.set(name, callback), addInitScript: async (fn, args) => scripts.push({ fn, args }) };
  if (integration) { evidence = createMainRequestEvidence({ baseUrl }); await evidence.install(context); }
  else observer = await installEditorialNativeBodyObserver(context, { baseUrl });
  const box = { URL, Request, Response, Headers, DOMException, ReadableStream, Uint8Array, TextEncoder, TextDecoder,
    crypto: { randomUUID, subtle: webcrypto.subtle }, location: { origin: baseUrl, href: baseUrl + "/app/composer" },
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 0),
    fetch: async function(input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), baseUrl).href;
      const headers = Object.fromEntries(new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)));
      const request = { url: () => url, method: () => init?.method ?? (input instanceof Request ? input.method : "GET"),
        headers: () => headers, frame: () => frame, resourceType: () => "fetch", postDataJSON: () => JSON.parse(init?.body ?? JSON.stringify(payload)),
        failure: () => ({ errorText: "net::ERR_ABORTED" }) };
      const record = integration ? evidence.observeRequest(request, "main", page) : { id: actual.length + 1, method: request.method(), path: new URL(url).pathname };
      if (observer) observer.trackRequest(request, record, page);
      const observedResponse = { request: () => request, status: () => response.status, headers: () => Object.fromEntries(response.headers) };
      if (observer) observer.observeResponse(observedResponse); else evidence.observeResponse(observedResponse);
      actual.push({ request, record, input, options: { headers, signal: init?.signal, credentials: init?.credentials, body: init?.body }, receiver: this });
      return response;
    } };
  box.window = box;
  for (const [name, callback] of callbacks) box[name] = async event => {
    if (name === "__auroraEditorialNativeBody") { events.push(event); event = transformEvent(event); }
    if (event) callback({ page, frame }, event);
  };
  vm.createContext(box);
  for (const { fn, args } of scripts) { box.args = args; vm.runInContext(`(${fn.toString()})(args)`, box); }
  page.evaluate = (fn, args) => { box.evaluateArgs = args; return vm.runInContext(`(${fn.toString()})(evaluateArgs)`, box); };
  const fetch = (init = {}, url = path + "?private=PRIVATE_QUERY_CANARY", receiver = box) => Reflect.apply(box.fetch, receiver,
    [url, { method: "POST", body: JSON.stringify(payload), headers: { "x-aurora-project-id": "8", authorization: "PRIVATE_HEADER_CANARY" }, ...init }]);
  const flush = async () => { await box.__flushEditorialNativeBody?.(); };
  const snapshot = () => integration ? evidence.snapshot()[0].editorialAck : observer.snapshotFor(actual[0].record);
  const emit = event => callbacks.get("__auroraEditorialNativeBody")({ page, frame }, { ...events.find(e => e.kind === "start"), readerId: 1, ...event });
  return { page, box, response, stream, chunks, controller, observer, evidence, actual, events, fetch, flush, snapshot, emit };
}
async function consume(response) { const reader = response.body.getReader(), values = []; for (;;) { const value = await reader.read(); values.push(value); if (value.done) break; } return values; }

it("observes only the original caller's consumed bytes and exports a bounded scalar/hash receipt", async () => {
  const f = await fixture(); const response = await f.fetch(); expect(response).toBe(f.response);
  expect(response.bodyUsed).toBe(false); expect(f.events.some(e => e.kind === "reader")).toBe(false);
  const values = await consume(response); await f.flush(); expect(values[0].value).toBe(f.chunks[0]);
  const data = f.snapshot(); expect(data.matched).toBe(true);
  expect(data.native).toMatchObject({ bodyComplete: true, byteCount: f.chunks[0].byteLength, bodySha256: sha(f.chunks[0]),
    readerCount: 1, eofCount: 1, fulfilledClosedCount: 1, jsonValid: true, bodyOk: true, responseCorrelation: true, statusMatches: true });
  expect(data.receipt).toEqual({ decisionId: 19, draftId: 41, projectId: 8, workflowVersion: 4, currentRevisionId: 17,
    submittedRevisionId: 17, approvedRevisionId: 17, approvedContentHash: "a".repeat(64), state: "approved" });
  expect(f.events.filter(e => e.kind === "read-start")).toHaveLength(2);
  const serialized = JSON.stringify(data);
  for (const secret of ["PRIVATE_BODY_CANARY", "PRIVATE_REQUEST_CANARY", "PRIVATE_HEADER_CANARY", "PRIVATE_QUERY_CANARY", requestId,
    f.events.find(e => e.kind === "start").identity, f.events.find(e => e.kind === "document").documentId]) expect(serialized).not.toContain(secret);
});

it.each(["incomplete", "error", "cancel", "clone", "second-reader", "late-error"])("never describes %s as a complete original body", async mode => {
  const f = await fixture({ mode: ["error", "cancel"].includes(mode) ? "open" : "closed" }); const response = await f.fetch();
  if (mode === "clone") await consume(response.clone());
  else {
    const reader = response.body.getReader(); await reader.read();
    if (mode === "error") { const error = new TypeError("private failure must not be exported"); f.controller.error(error); await expect(reader.read()).rejects.toBe(error); await expect(reader.cancel()).rejects.toBe(error); }
    if (mode === "cancel") { await reader.cancel("PRIVATE_CANCEL_CANARY"); await reader.read(); }
    if (mode === "second-reader") { reader.releaseLock(); await consume(response); }
    if (mode === "late-error") { await reader.read(); await f.flush(); f.emit({ kind: "read-error", error: "TypeError" }); }
  }
  await f.flush(); expect(f.snapshot().native?.bodyComplete ?? false).toBe(false);
  expect(JSON.stringify(f.snapshot())).not.toContain("private failure");
});

it.each(["invalid-json", "overflow", "wrong-request-id", "private-scalar"])("keeps %s explicit without exporting its raw body", async mode => {
  const text = mode === "invalid-json" ? "PRIVATE_INVALID_JSON" : mode === "overflow" ? "x".repeat(20_000)
    : JSON.stringify(mode === "wrong-request-id" ? { ...ack, requestId: "foreign" } : { ...ack, decisionId: "PRIVATE_INVALID_ID", workflow: { ...ack.workflow, state: "PRIVATE_STATE" } });
  const f = await fixture({ text }); await consume(await f.fetch()); await f.flush(); const data = f.snapshot();
  if (mode === "invalid-json") expect(data.native.jsonValid).toBe(false);
  if (mode === "overflow") { expect(data.native.bodyComplete).toBe(false); expect(data.native.overflow).toBe(true); expect(data.native.bodySha256).toBeNull(); }
  if (mode === "wrong-request-id") expect(data.native.responseCorrelation).toBe(false);
  if (mode === "private-scalar") { expect(data.receipt.decisionId).toBeNull(); expect(data.receipt.state).toBeNull(); }
  expect(JSON.stringify(data)).not.toContain("PRIVATE_");
});

it.each(["wrong-document", "wrong-identity", "duplicate-native", "duplicate-request", "collision"])("does not borrow a %s match", async kind => {
  const f = await fixture({ transformEvent: event => event.kind === "start" && kind === "wrong-document" ? { ...event, documentId: "foreign" }
    : event.kind === "start" && kind === "wrong-identity" ? { ...event, identity: "foreign" } : event });
  await consume(await f.fetch()); await f.flush();
  if (kind === "duplicate-native") f.emit({ kind: "start", id: 99 });
  if (kind === "collision") f.emit({ kind: "collision" });
  if (kind === "duplicate-request") { const first = f.actual[0]; f.observer.trackRequest({ ...first.request }, { ...first.record, id: 2 }, f.page); }
  expect(f.snapshot().matched).toBe(false); expect(f.snapshot().native).toBeNull();
});

it("retains Request/init replacement headers, original accessor receiver, body, signal and credentials", async () => {
  const f = await fixture(); const controller = new AbortController();
  class Options { #signal = controller.signal; get signal() { return this.#signal; } get method() { return "POST"; }
    get headers() { return { "x-own-init": "replacement", "x-aurora-project-id": "8" }; } get credentials() { return "same-origin"; }
    get body() { return JSON.stringify(payload); } }
  const input = new Request(baseUrl + path, { method: "POST", headers: { "x-original": "must-be-replaced" } });
  const receiver = {}; await Reflect.apply(f.box.fetch, receiver, [input, new Options()]);
  expect(f.actual[0].receiver).toBe(receiver); expect(f.actual[0].input).toBe(input);
  expect(f.actual[0].options.headers["x-original"]).toBeUndefined(); expect(f.actual[0].options.headers["x-own-init"]).toBe("replacement");
  expect(f.actual[0].options.signal).toBe(controller.signal); expect(f.actual[0].options.credentials).toBe("same-origin");
  expect(f.actual[0].options.body).toBe(JSON.stringify(payload)); await consume(f.response); await f.flush();
});

it.each(["GET", "foreign-path", "foreign-origin", "caller-marker"])("preserves transport without instrumenting %s", async kind => {
  const f = await fixture();
  await f.fetch(kind === "GET" ? { method: "GET" } : kind === "caller-marker" ? { headers: { "x-aurora-e2e-editorial-id": "caller" } } : {},
    kind === "foreign-path" ? "/api/publication-operations" : kind === "foreign-origin" ? "https://other.invalid" + path : path);
  expect(f.events.filter(e => e.kind === "start")).toHaveLength(0);
  if (kind !== "caller-marker") expect(f.actual[0].options.headers["x-aurora-e2e-editorial-id"]).toBeUndefined();
});

it("main exports the diagnostic but never admits a completed editorial POST abort or waits for a pending POST", async () => {
  const f = await fixture({ integration: true }); await consume(await f.fetch()); await f.evidence.flushNativeDiagnostics(f.page);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 250 })).resolves.toBeUndefined();
  const req = f.actual[0].request; f.evidence.observeFailure(req);
  expect(f.snapshot().native.bodyComplete).toBe(true); expect(f.evidence.reason(req)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 250 })).resolves.toBeUndefined();
});

it("does not capture another context's Request or shadow its own valid diagnostic", async () => {
  const f = await fixture(); await consume(await f.fetch()); await f.flush();
  const first = f.actual[0]; const foreignPage = { mainFrame: f.page.mainFrame, context: () => ({}) };
  const record = { ...first.record, id: 2 };
  f.observer.trackRequest(first.request, record, foreignPage);
  expect(f.observer.snapshotFor(record)).toBeNull(); expect(f.snapshot().matched).toBe(true);
});

it("bounds diagnostic flush and preserves late rejection without changing request admission", async () => {
  const f = await fixture({ integration: true }); let reject;
  f.page.evaluate = () => new Promise((_, fail) => { reject = fail; });
  await expect(f.evidence.flushNativeDiagnostics(f.page, { timeoutMs: 20 })).rejects.toThrow("Native diagnostic flush timed out");
  reject(new Error("later context closure")); await new Promise(resolve => setTimeout(resolve, 0));
  expect(f.evidence.proofs()).toEqual([]);
});

it("retains an actual diagnostic flush error as the original cause", async () => {
  const f = await fixture({ integration: true }); const error = new Error("original binding rejection");
  f.page.evaluate = async () => { throw error; };
  await expect(f.evidence.flushNativeDiagnostics(f.page)).rejects.toBe(error);
});

function unmatchedFixture() {
  const evidence = createMainRequestEvidence({ baseUrl }); const page = { evaluate: async () => ({ documentId: "PRIVATE_DOCUMENT_CANARY" }) };
  evidence.observeNative(page, { kind: "document", documentId: "PRIVATE_DOCUMENT_CANARY" });
  const event = { id: 1, identity: "PRIVATE_IDENTITY_CANARY", documentId: "PRIVATE_DOCUMENT_CANARY", method: "GET",
    url: baseUrl + "/api/projects/current?token=PRIVATE_QUERY_CANARY", at: 1 };
  const request = { url: () => event.url, method: () => "GET", resourceType: () => "fetch",
    headers: () => ({ "x-aurora-e2e-read-id": event.identity }), failure: () => ({ errorText: "PRIVATE_FAILURE_CANARY" }) };
  evidence.observeNative(page, { ...event, kind: "start" });
  return { evidence, page, event, request };
}

it("retains a native GET failure before its Request event without exposing raw metadata", () => {
  const f = unmatchedFixture(); f.evidence.observeNative(f.page, { ...f.event, kind: "failure", callerAbort: false });
  expect(f.evidence.snapshot()).toEqual([]);
  const result = f.evidence.snapshotUnmatchedReads(); expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({ path: "/api/projects/current", method: "GET", context: null,
    nativeMatchCount: 1, requestMatchCount: 0, nativeFailureObserved: true, callerFailure: false, failed: true });
  expect(JSON.stringify(result)).not.toContain("PRIVATE_"); expect(f.evidence.proofs()).toEqual([]);
});

it("excludes a reciprocal matched GET from the unmatched diagnostic", () => {
  const f = unmatchedFixture(); f.evidence.observeRequest(f.request, "main", f.page);
  expect(f.evidence.snapshotUnmatchedReads()).toEqual([]); expect(f.evidence.snapshot()).toHaveLength(1);
});

it.each(["duplicate", "collision", "wrong-document"])("retains %s as unmatched without changing its rejection", kind => {
  const f = unmatchedFixture(); f.evidence.observeRequest(f.request, "main", f.page); f.evidence.observeFailure(f.request);
  if (kind === "duplicate") f.evidence.observeNative(f.page, { ...f.event, id: 2, kind: "start" });
  if (kind === "collision") f.evidence.observeNative(f.page, { ...f.event, kind: "collision" });
  if (kind === "wrong-document") {
    const other = { ...f.request, headers: () => ({ "x-aurora-e2e-read-id": "other" }) };
    f.evidence.observeNative(f.page, { ...f.event, id: 2, identity: "other", documentId: "wrong", kind: "start" });
    f.evidence.observeRequest(other, "main", f.page);
  }
  const before = f.evidence.snapshot(); const result = f.evidence.snapshotUnmatchedReads(); expect(result.length).toBeGreaterThan(0);
  expect(f.evidence.snapshot()).toEqual(before); expect(f.evidence.reason(f.request)).toBeNull(); expect(f.evidence.proofs()).toEqual([]);
  expect(JSON.stringify(result)).not.toContain("PRIVATE_");
});

it("reading unmatched diagnostics cannot settle a missing actual Request", async () => {
  const f = unmatchedFixture(); expect(f.evidence.snapshotUnmatchedReads()).toHaveLength(1);
  await expect(f.evidence.settleReads(f.page, { timeoutMs: 35 })).rejects.toThrow("did not settle");
  expect(f.evidence.snapshotUnmatchedReads()).toHaveLength(1); expect(f.evidence.proofs()).toEqual([]);
});

// Execute the emitted browser observer against native Request conversion, not a
// fixture which copies RequestInit fields itself.
async function nativeOptionsFixture({ rejectBinding = false } = {}) {
  const callbacks = new Map(), scripts = [], actual = [], events = [];
  const frame = {}, context = { exposeBinding: async (name, callback) => callbacks.set(name, callback),
    addInitScript: async (fn, args) => scripts.push({ fn, args }) };
  const page = { mainFrame: () => frame, context: () => context };
  const observer = await installEditorialNativeBodyObserver(context, { baseUrl });
  const failure = new Error("owned diagnostic binding failure");
  const box = { URL, Request, Response, Headers, DOMException, Uint8Array, TextEncoder, TextDecoder, crypto: webcrypto,
    location: { origin: baseUrl, href: baseUrl + "/app/composer" },
    fetch: async function(input, init) { const request = new Request(input, init); actual.push(request); return Response.json({ ok: true }); } };
  box.window = box;
  for (const [name, callback] of callbacks) box[name] = async event => {
    events.push(event); if (rejectBinding) throw failure; return callback({ page, frame }, event);
  };
  vm.createContext(box);
  for (const { fn, args } of scripts) { box.args = args; vm.runInContext(`(${fn.toString()})(args)`, box); }
  page.evaluate = fn => vm.runInContext(`(${fn.toString()})()`, box);
  return { box, page, observer, failure, actual, events };
}

it("retains an already settled binding rejection until every later diagnostic flush", async () => {
  const f = await nativeOptionsFixture({ rejectBinding: true }); await new Promise(resolve => setImmediate(resolve));
  await expect(f.observer.flush(f.page)).rejects.toBe(f.failure);
  await expect(f.observer.flush(f.page)).rejects.toBe(f.failure);
});

it("does not invent a failure after successful diagnostic bindings have settled", async () => {
  const f = await nativeOptionsFixture(); await new Promise(resolve => setImmediate(resolve));
  await expect(f.observer.flush(f.page)).resolves.toBeUndefined();
});

it("preserves native rejection of explicitly null replacement headers", async () => {
  const input = new Request(baseUrl + path, { method: "POST", headers: { "x-original": "value" } });
  expect(() => new Request(input, { method: "POST", headers: null })).toThrow(TypeError);
  const f = await nativeOptionsFixture();
  await expect(f.box.fetch(input, { method: "POST", headers: null })).rejects.toThrow(TypeError);
  expect(f.actual).toEqual([]); expect(f.events.filter(event => event.kind === "start")).toEqual([]);
});

it("passes a stateful method getter to native conversion exactly once without false diagnostics", async () => {
  function options() { let count = 0; return { get method() { count += 1; return count === 1 ? "POST" : "GET"; },
    get count() { return count; }, headers: { "x-own": "valid" } }; }
  const control = options(); expect(new Request(baseUrl + path, control).method).toBe("POST"); expect(control.count).toBe(1);
  const f = await nativeOptionsFixture(), init = options(); await f.box.fetch(baseUrl + path, init);
  expect(f.actual[0].method).toBe("POST"); expect(init.count).toBe(1);
  expect(f.events.filter(event => event.kind === "start")).toEqual([]);
  expect(f.actual[0].headers.has("x-aurora-e2e-editorial-id")).toBe(false);
});

it("preserves native dictionary getter order and private accessor receiver by passing dynamic init through", async () => {
  function options(order) { return new class {
    #signal = new AbortController().signal;
    get body() { order.push("body"); return "original-body"; }
    get credentials() { order.push("credentials"); return "same-origin"; }
    get headers() { order.push("headers"); return { "x-own": "replacement" }; }
    get method() { order.push("method"); return "POST"; }
    get signal() { order.push("signal"); return this.#signal; }
  }(); }
  const controlOrder = [], actualOrder = []; const input = new Request(baseUrl + path, { headers: { "x-original": "must-be-replaced" } });
  const control = new Request(input, options(controlOrder)); const f = await nativeOptionsFixture();
  await f.box.fetch(input, options(actualOrder)); const request = f.actual[0];
  expect(actualOrder).toEqual(controlOrder); expect(request.method).toBe(control.method);
  expect(await request.text()).toBe(await control.text()); expect(request.credentials).toBe(control.credentials);
  expect([...request.headers]).toEqual([...control.headers]); expect(request.signal.aborted).toBe(false);
  expect(f.events.filter(event => event.kind === "start")).toEqual([]);
});
