import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { createPostsSnapshotEvidence } from "./e2e-posts-snapshot-evidence.mjs";
import { classifyE2eExpectedSessionExpiryConsole } from "./e2e-browser-config.mjs";
import { createMainFaultEvidence, nativeMainHttpStatus } from "./e2e-main-fault-evidence.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import vm from "node:vm";
import { EventEmitter, once } from "node:events";
import { spawn } from "node:child_process";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { classifyEditorCancellation } from "./e2e-editor-safety-coverage.mjs";

// Execute the real main harness finalization functions without starting a database,
// app or browser. This detects late-denial and capture-disabled control-flow bugs.
const source = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("test-e2e-real.mjs", source, ts.ScriptTarget.Latest, true);
const selected = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["finalizeBrowserContexts", "finalizeBrowserArtifacts", "flushEditorialNativeDiagnostics"].includes(node.name?.text));
const functions = selected.map((node) => node.getFullText(ast)).join("\n");

function fixture(captureBrowserArtifacts, failOnClose = false) {
  const records = []; const order = [];
  const transport = { stop: vi.fn(async () => { order.push("stop"); }),
    snapshot: () => [...records], assertClean: () => { if (records.length) throw new Error("late external attempt"); } };
  const context = { pages: () => [], close: vi.fn(async () => { order.push("close"); if (failOnClose) records.push({ kind: "external_request" }); }),
    tracing: { stop: vi.fn(async () => { order.push("trace"); }) } };
  const state = { finalizeE2eBrowserLifecycle, Promise, AggregateError, resolve, context, reviewerContext: null, browser: null,
    mainRequestEvidence: { proofs: () => [], reason: () => null, snapshot: () => [], snapshotUnmatchedReads: () => [],
      flushNativeDiagnostics: vi.fn(async () => { order.push("native-flush"); }) },
    readEditorialReceiptDiagnostics: vi.fn(async () => { order.push("editorial-db"); return { diagnosticOnly: true, facts: [] }; }), pool: {},
    finalizeStudioSessionPersistence: async () => [], finalizeProductEventPersistence: async () => {}, mainFailedRequestIssues: new Map(), pendingCancellationPageErrors: [], pendingExpiryStructured: [],
    expiryFaultEvidence: { beginTeardown: () => {}, finalize: async () => ({ issues: [], observations: [] }), provedResponses: () => [] },
    mainFaultEvidence: { beginTeardown: () => {}, finalize: async () => ({ issues: [], observations: [] }) },
    postsSnapshotEvidence: createPostsSnapshotEvidence({ baseUrl: "https://localhost:12345" }), browserIssues: [], browserObservations: [],
    browserContextsFinalized: false, browserArtifactsFinalized: false, browserTeardownStarted: false,
    browserContextEntries: [{ context, transport }], browserTransports: [transport],
    interfaceEvidence: {}, ingressBoundary: { snapshot: () => [], assertClean: vi.fn() },
    captureBrowserArtifacts, browserArtifactEvidence: { enabled: captureBrowserArtifacts },
    reviewerTraceStarted: false, mainTraceStarted: captureBrowserArtifacts,
    artifactDir: "/tmp/isolated-lifecycle-fixture", videoDirectory: "/tmp/isolated-lifecycle-fixture/video",
    access: async () => { throw new Error("no editor trace in this unit fixture"); },
    readdir: async () => [], writeFile: vi.fn(async () => {}), browserNetworkEvents: [],
  };
  vm.createContext(state);
  vm.runInContext(functions + "\nglobalThis.finalize = finalizeBrowserArtifacts;", state);
  return { state, context, transport, order };
}

it.each([false, true])("a denial while closing must fail even with capture=%s", async (capture) => {
  const { state, context, transport, order } = fixture(capture, true);
  await expect(state.finalize({ requireComplete: false })).rejects.toThrow(/finalization failed/u);
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
  expect(order).toEqual(capture ? ["trace", "close", "stop", "editorial-db"] : ["close", "stop", "editorial-db"]);
  expect(state.interfaceEvidence.browserTransport).toEqual([[{ kind: "external_request" }]]);
});
it("capture-disabled successful completion closes once and records the drained boundary", async () => {
  const { state, context, transport } = fixture(false);
  expect(await state.finalize()).toEqual({ enabled: false });
  await state.finalize();
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
  expect(state.interfaceEvidence.browserTransport).toEqual([[]]);
  expect(state.browserArtifactsFinalized).toBe(true);
});
it("a failing context close still stops its transport and closes the other context", async () => {
  const { state, context, transport } = fixture(false);
  context.close.mockRejectedValue(new Error("close failed"));
  const second = { context: { pages: () => [], close: vi.fn(async () => {}) }, transport: { stop: vi.fn(async () => {}),
    snapshot: () => [], assertClean: vi.fn() } };
  state.browserContextEntries.push(second); state.browserTransports.push(second.transport);
  await expect(state.finalize()).rejects.toThrow(/finalization failed/u);
  expect(transport.stop).toHaveBeenCalledOnce(); expect(second.context.close).toHaveBeenCalledOnce();
  expect(second.transport.stop).toHaveBeenCalledOnce();
});

it("a failed trace flush still closes contexts and retains both failures and final evidence", async () => {
  const { state, context, transport } = fixture(true, true);
  context.tracing.stop.mockRejectedValue(new Error("trace flush failed"));
  const failure = await state.finalize({ requireComplete: false }).catch(error => error);
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
  expect(failure.cause.message).toBe("trace flush failed");
  expect(failure.errors).toHaveLength(2);
  expect(state.interfaceEvidence.browserTransport).toEqual([[{ kind: "external_request" }]]);
  expect(state.browserArtifactEvidence.enabled).toBe(true);
  expect(state.browserArtifactEvidence.traces).toEqual([]);
});

const diagnosticsSource = ast.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === "installBrowserDiagnostics").getFullText(ast);
async function diagnosticsFixture({ early = false, capture = true } = {}) {
  const page = new EventEmitter(); page.url = () => "https://localhost:12345/app/composer";
  const context = new EventEmitter(); context.pages = () => [];
  const error = new Error("early application failure");
  const message = { type: () => "error", text: () => "unexpected application error", page: () => page,
    args: () => [{}], location: () => ({ url: page.url(), lineNumber: 2, columnNumber: 1 }) };
  context.addInitScript = async () => {
    if (early) {
      context.emit("weberror", { page: () => page, error: () => error });
      context.emit("console", message);
    }
  };
  const requestEvidence = createMainRequestEvidence({ baseUrl: "https://localhost:12345" });
  requestEvidence.install = async () => {};
  const state = { URL, Date, Promise, WeakSet, WeakMap, Map, Set, classifyEditorCancellation, nativeMainHttpStatus,
    mainRequestEvidence: requestEvidence,
    studioSessionEvidence: { observeRequest: () => {}, observeFailure: () => {}, install: async () => {} }, mainFailedRequestIssues: new Map(), pendingCancellationPageErrors: [], pendingExpiryStructured: [],
    expiryFaultEvidence: createMainFaultEvidence({ baseUrl: "https://localhost:12345" }), expiryPageLabels: new WeakMap(), expiryPageSequence: 0,
    installE2eBrowserBoundary: async () => {}, baseUrl: "https://localhost:12345", webPort: 12345,
    browserIssues: [], browserObservations: [], browserNetworkEvents: [],
    browserPendingRequests: new WeakMap(), browserRequestIds: new WeakMap(), browserRequestResponses: new WeakMap(),
    browserRequestSequence: 0, browserTeardownStarted: false, browserScreenshotDepth: 0,
    mainFaultEvidence: createMainFaultEvidence({ baseUrl: "https://localhost:12345" }),
    postsSnapshotEvidence: createPostsSnapshotEvidence({ baseUrl: "https://localhost:12345" }), explicitlyAbortedDraftRequests: new WeakSet(),
    captureBrowserArtifacts: capture, browserEngine: "chromium", browser: { isConnected: () => true },
    expectedCompletedPages: new WeakSet(), expectedBrowserConsoleScopes: new Set(),
    expectedBrowser5xxScopes: new Set(), expectedSessionExpiryConsoleScopes: new Set(),
    WEBKIT_DOCUMENT_CANCELLATION_WINDOW_MS: 250, WEBKIT_DEFERRED_CANCELLATION_WINDOW_MS: 120_000,
    sanitizeE2eNetworkUrl: (url) => new URL(url).pathname,
  };
  for (const name of ["classifyE2eKnownBrowserObservation", "classifyE2eExpectedSessionExpiryConsole",
    "classifyE2eExpectedSessionExpiryWebKitPageError", "classifyE2eKnownWebKitDocumentNavigationCancellation",
    "classifyE2eKnownWebKitRequestCancellation"]) state[name] = () => null;
  vm.createContext(state);
  vm.runInContext(diagnosticsSource + "\nglobalThis.install = installBrowserDiagnostics;", state);
  await state.install(context, "main"); context.emit("page", page);
  return { state, context, page, error, message };
}
function failedRequest(page, { method = "PATCH", path = "/api/drafts/1", headers = {} } = {}) {
  return { url: () => "https://localhost:12345" + path, method: () => method, resourceType: () => "fetch",
    failure: () => ({ errorText: "net::ERR_ABORTED" }), headers: () => headers, frame: () => ({ page: () => page }) };
}
it.each(["console", "pageerror", "crash", "response"])("records unexpected %s delivered during teardown", async event => {
  const { state, page, error, message } = await diagnosticsFixture();
  state.browserTeardownStarted = true;
  const request = failedRequest(page);
  page.emit(event, event === "console" ? message : event === "pageerror" ? error
    : { status: () => 500, request: () => request, url: request.url, headers: () => ({}) });
  expect(state.browserIssues).toHaveLength(1);
});
it("captures initial-document errors before the page event and deduplicates context/page delivery", async () => {
  const { state, context, page, error, message } = await diagnosticsFixture({ early: true });
  expect(state.browserIssues.map(issue => issue.kind).sort()).toEqual(["console.error", "pageerror"]);
  page.emit("pageerror", error); page.emit("console", message);
  context.emit("weberror", { page: () => page, error: () => error }); context.emit("console", message);
  expect(state.browserIssues.map(issue => issue.kind).sort()).toEqual(["console.error", "pageerror"]);
});
it("a fault scenario never permits an unrelated application console.error", async () => {
  const { state, page, message } = await diagnosticsFixture(); state.mainFaultEvidence.beginScope("main", { page, required: false, rules: [{ method: "POST", url: "https://localhost:12345/api/media/assets", status: 422, jsonError: "invalid_image" }] });
  page.emit("console", message);
  expect(state.browserIssues).toEqual([expect.objectContaining({ kind: "console.error" })]);
});
it("a stale outage scope does not permit late HTTP500 during cleanup", async () => {
  const { state, page } = await diagnosticsFixture(); state.mainFaultEvidence.beginScope("main", { page, required: false, rules: [{ method: "GET", readOnly: true, matchUrl: url => url.pathname.startsWith("/api/"), status: 502, text: "runtime unavailable" }] });
  state.browserTeardownStarted = true; const request = failedRequest(page);
  page.emit("response", { status: () => 500, request: () => request, url: request.url, headers: () => ({}) });
  expect(state.browserIssues).toEqual([expect.objectContaining({ kind: "http.5xx" })]);
});
it.each([false, true])("unconfirmed late mutation fails independently of artifact capture=%s", async capture => {
  const { state, page } = await diagnosticsFixture({ capture }); const request = failedRequest(page);
  page.emit("request", request); state.browserTeardownStarted = true; page.emit("requestfailed", request);
  expect(state.browserIssues).toEqual([expect.objectContaining({ kind: "requestfailed" })]);
  if (capture) expect(state.browserNetworkEvents.map(row => row.event)).toEqual(["request", "requestfailed"]);
});
it("late successful keepalive acknowledgement is retained as a proved cancellation", async () => {
  const { state, page } = await diagnosticsFixture(); const request = failedRequest(page, { method: "POST", path: "/api/product-events" });
  page.emit("request", request); state.browserTeardownStarted = true;
  page.emit("response", { status: () => 204, request: () => request, url: request.url, headers: () => ({}) });
  page.emit("requestfailed", request);
  expect(state.browserIssues).toEqual([]);
  expect(state.browserNetworkEvents.map(row => row.event)).toEqual(["request", "response", "requestfailed"]);
  expect(state.browserObservations).toEqual([expect.objectContaining({ reason: "acknowledged_keepalive" })]);
});
it("clean teardown does not invent an error for intentional page closure", async () => {
  const { state, page } = await diagnosticsFixture(); state.browserTeardownStarted = true; page.emit("close");
  expect(state.browserIssues).toEqual([]);
});

it("defers only an exact native calendar snapshot conflict to full body validation", async () => {
  const { state, page } = await diagnosticsFixture();
  const request = failedRequest(page, { method: "GET", path: "/api/posts?limit=200&cursor=synthetic-cursor" });
  page.emit("request", request);
  page.emit("response", { status: () => 409, request: () => request, url: request.url,
    headers: () => ({ "content-type": "application/json" }), body: async () => Buffer.from('{"error":"posts_snapshot_changed"}') });
  page.emit("console", { type: () => "error", text: () => "Failed to load resource: the server responded with a status of 409 (Conflict)",
    args: () => [], location: () => ({ url: request.url(), lineNumber: 0, columnNumber: 0 }) });
  expect(state.browserIssues).toEqual([]);
  state.postsSnapshotEvidence.beginTeardown();
  const result = await state.postsSnapshotEvidence.finalize();
  expect(result.issues).toEqual([]); expect(result.proofs).toHaveLength(1); expect(result.observations).toHaveLength(1);
});

function runtimeCleanupFixture(failureKind) {
  const calls = [];
  const action = name => async () => { calls.push(name); if (name === failureKind) throw new Error(name + " cleanup failed"); };
  const state = { Promise, AggregateError, browserArtifactsFinalized: true, runtimeFinalized: false,
    browser: null, browserTransports: [], browserContextEntries: [],
    publishQueue: { close: action("queue") }, mediaQueue: null, statsQueue: null, legalVisualQueue: null,
    projectExportQueue: null, publicationExtraQueue: null, publicationReviewReminderQueue: null,
    children: [{ pid: 123 }], stopChild: async () => { await action("child")(); return { forced: failureKind === "forced" }; },
    fakeServer: null, tlsProxyServer: null, tlsDirectory: null,
    redis: { flushdb: action("flush"), quit: action("quit") },
    pool: { query: action("schema"), end: action("pool") },
    releaseE2eBuildLock: () => calls.push("unlock"), interfaceEvidence: {},
    assert: (value, message) => { if (!value) throw new Error(message); },
  };
  const cleanup = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "finalizeOwnedRuntime")?.getFullText(ast) ?? "";
  const finalizer = ast.statements.filter(ts.isTryStatement).at(-1).finallyBlock.statements.map(node => node.getFullText(ast)).join("\n");
  vm.createContext(state);
  vm.runInContext(cleanup + "\nglobalThis.finalize = async () => {" + finalizer + "};", state);
  return { state, calls };
}
it.each(["queue", "flush", "forced"])("main cleanup fails for %s and still releases every remaining owned resource", async kind => {
  const { state, calls } = runtimeCleanupFixture(kind);
  await expect(state.finalize()).rejects.toThrow();
  expect(calls).toContain("child"); expect(calls).toContain("quit"); expect(calls).toContain("pool"); expect(calls).toContain("unlock");
});
it("clean owned runtime shutdown completes without a failure", async () => {
  const { state, calls } = runtimeCleanupFixture();
  await expect(state.finalize()).resolves.toBeUndefined();
  expect(calls).toEqual(["queue", "child", "flush", "quit", "schema", "schema", "pool", "unlock"]);
});

it("collects decision ledger diagnostics after browser close without admitting an unknown POST", async () => {
  const { state, order } = fixture(false);
  const issue = { kind: "requestfailed", path: "/api/drafts/2/editorial/decisions" };
  const request = {}; state.mainFailedRequestIssues.set(request, issue); state.browserIssues.push(issue);
  await state.finalize();
  expect(state.readEditorialReceiptDiagnostics).toHaveBeenCalledOnce();
  expect(order.indexOf("editorial-db")).toBeGreaterThan(order.indexOf("close"));
  expect(state.interfaceEvidence.editorialReceiptDiagnostics).toEqual({ diagnosticOnly: true, facts: [] });
  expect(state.browserIssues).toContain(issue); expect(state.browserObservations).toEqual([]);
});

it("a receipt diagnostic failure still drains and records the final browser fault evidence", async () => {
  const { state, context, transport } = fixture(false);
  state.readEditorialReceiptDiagnostics.mockRejectedValue(new Error("local receipt read failed"));
  state.mainFaultEvidence.finalize = vi.fn(async () => ({ issues: [{ kind: "unproved_mutation" }], observations: [] }));
  await expect(state.finalize()).rejects.toThrow(/finalization failed/u);
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
  expect(state.mainFaultEvidence.finalize).toHaveBeenCalledOnce();
  expect(state.browserIssues).toEqual([{ kind: "unproved_mutation" }]);
  expect(state.browserContextsFinalized).toBe(true);
});

it("drains only native diagnostic work on still-open pages before context close", async () => {
  const { state, context, order } = fixture(false);
  const open = { isClosed: () => false }, closed = { isClosed: () => true };
  context.pages = () => [open, closed];
  await state.finalize();
  expect(state.mainRequestEvidence.flushNativeDiagnostics).toHaveBeenCalledExactlyOnceWith(open, { timeoutMs: 3_000 });
  expect(order).toEqual(["native-flush", "close", "stop", "editorial-db"]);
});

it("a native diagnostic flush failure cannot bypass browser close or the final failure", async () => {
  const { state, context, transport } = fixture(false);
  context.pages = () => [{ isClosed: () => false }];
  state.mainRequestEvidence.flushNativeDiagnostics.mockRejectedValue(new Error("Native diagnostic flush timed out"));
  await expect(state.finalize()).rejects.toThrow(/finalization failed/u);
  expect(context.close).toHaveBeenCalledOnce(); expect(transport.stop).toHaveBeenCalledOnce();
  expect(state.interfaceEvidence.editorialReceiptDiagnostics).toEqual({ diagnosticOnly: true, facts: [] });
});


it.each([false, true])("an unconfirmed mutation before teardown fails with capture=%s", async capture => {
  const { state, page } = await diagnosticsFixture({ capture }); const request = failedRequest(page);
  page.emit("request", request); page.emit("requestfailed", request);
  expect(state.browserIssues).toEqual([expect.objectContaining({ kind: "requestfailed" })]);
});
it("session expiry cannot consume a script spoof of a native 401", async () => {
  const { state, page, message } = await diagnosticsFixture();
  state.classifyE2eExpectedSessionExpiryConsole = classifyE2eExpectedSessionExpiryConsole;
  state.expectedSessionExpiryConsoleScopes.add("main");
  message.text = () => "Failed to load resource: the server responded with a status of 401 (Unauthorized)";
  message.location = () => ({ url: "https://localhost:12345/api/auth/me", lineNumber: 0, columnNumber: 0 });
  page.emit("console", message);
  expect(state.browserIssues).toEqual([expect.objectContaining({ kind: "console.error", nativeHttpStatus: null })]);
});
it.each([409, 422])("N48 diagnostics retain script-spoofed HTTP %s metadata", async status => {
  const { state, page, message } = await diagnosticsFixture();
  message.text = () => `Failed to load resource: the server responded with a status of ${status} (Conflict)`;
  message.location = () => ({ url: "https://localhost:12345/api/ai/generate", lineNumber: 0, columnNumber: 0 });
  page.emit("console", message);
  expect(state.browserIssues[0].nativeHttpStatus).toBeNull();
});

it.each(["valid", "wrong-body", "missing-request", "other-page", "same-url-alias"])("actual expiry forwarding requires %s request/body evidence", async kind => {
  const { state, page } = await diagnosticsFixture();
  state.classifyE2eExpectedSessionExpiryConsole = classifyE2eExpectedSessionExpiryConsole;
  state.expectedSessionExpiryConsoleScopes.add("main");
  const label = state.expiryPageLabels.get(page);
  state.expiryFaultEvidence.beginScope(label, { page, required: false, rules: [{ method: "GET", url: "https://localhost:12345/api/auth/me", status: 401, jsonError: "unauthorized" }] });
  const request = failedRequest(page, { method: "GET", path: "/api/auth/me" });
  if (kind !== "missing-request") page.emit("request", request);
  const response = { request: () => request, url: request.url, status: () => 401, headers: () => ({ "content-type": "application/json" }),
    body: async () => Buffer.from(JSON.stringify({ error: kind === "wrong-body" ? "other" : "unauthorized" })) };
  if (kind === "other-page") state.expiryFaultEvidence.observeResponse(response, label, {});
  else page.emit("response", response);
  state.expiryFaultEvidence.endScope(label);
  if (kind === "same-url-alias") {
    const alias = failedRequest(page, { method: "GET", path: "/api/auth/me" }); page.emit("request", alias);
    page.emit("response", { ...response, request: () => alias });
  }
  page.emit("console", { type: () => "error", text: () => "Failed to load resource: the server responded with a status of 401 (Unauthorized)",
    args: () => [], location: () => ({ url: request.url(), lineNumber: 0, columnNumber: 0 }) });
  const result = await state.expiryFaultEvidence.finalize();
  if (kind === "valid") { expect(result.issues).toEqual([]); expect(result.proofs).toHaveLength(1); expect(state.browserIssues).toEqual([]); }
  else expect([...state.browserIssues, ...result.issues].length).toBeGreaterThan(0);
});

it.each(["initialReferenceRequestPromise", "cancelledResponsePromise", "retryResponsePromise", "terminalReloadPromise"])("%s observes an early rejection without replacing the original failed waiter", async name => {
  let declaration;
  const visit = node => {
    if (ts.isVariableStatement(node) && node.declarationList.declarations.some(item => item.name.getText(ast) === name)) declaration = node;
    ts.forEachChild(node, visit);
  };
  visit(ast);
  const statements = declaration.parent.statements;
  const index = statements.indexOf(declaration);
  let reject; const waiting = new Promise((_, failed) => { reject = failed; });
  const originalCatch = waiting.catch.bind(waiting); waiting.catch = vi.fn(originalCatch);
  const state = { URL, page: { waitForRequest: () => waiting, waitForResponse: () => waiting } };
  vm.createContext(state);
  vm.runInContext(declaration.getFullText(ast) + statements[index + 1].getFullText(ast) + `\nglobalThis.waiting = ${name};`, state);
  expect(waiting.catch).toHaveBeenCalledOnce();
  expect(state.waiting).toBe(waiting);
  const failure = new Error("owned waiter rejected after another UI step failed"); reject(failure);
  await expect(state.waiting).rejects.toBe(failure);
});

it.each([true, false])("actual N48 recovery consumption only removes native evidence=%s", async native => {
  let loop;
  const visit = node => {
    if (ts.isForStatement(node) && node.getText(ast).includes("remainingExpectedConsole.findIndex")) loop = node;
    ts.forEachChild(node, visit);
  }; visit(ast);
  const issue = { context: "main", kind: "console.error", url: "https://localhost:12345/api/ai/generate",
    message: "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)", nativeHttpStatus: native ? 422 : null };
  const state = { browserIssues: [issue], browserObservations: [], pendingDiagnosticsStart: 0,
    remainingExpectedConsole: [{ status: 422, url: issue.url, requestId: "proved", code: "ai_generation_cancelled" }] };
  vm.createContext(state); vm.runInContext(loop.getFullText(ast), state);
  expect(state.browserIssues).toHaveLength(native ? 0 : 1);
  expect(state.browserObservations).toHaveLength(native ? 1 : 0);
});

it.each(["abnormal-exit", "completed-build", "early-runtime-zero", "unexpected-signal", "requested-stop"])("actual owned child lifecycle: %s", async scenario => {
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["child", "processTreeAlive", "signalChild", "stopChild", "finalizeOwnedRuntime"].includes(node.name?.text));
  const state = { spawn, process, Promise, AggregateError, assert: (value, message) => { if (!value) throw new Error(message); },
    logs: [], children: [], runtimeFinalized: false, interfaceEvidence: {},
    publishQueue: null, mediaQueue: null, statsQueue: null, legalVisualQueue: null, projectExportQueue: null,
    publicationExtraQueue: null, publicationReviewReminderQueue: null, fakeServer: null, tlsProxyServer: null,
    tlsDirectory: null, redis: null, pool: null, releaseE2eBuildLock: () => {},
    waitFor: async check => { for (let i = 0; i < 400; i++) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("owned child remained"); },
  };
  vm.createContext(state); vm.runInContext(selected.map(node => node.getFullText(ast)).join("\n")
    + "\nglobalThis.start = child; globalThis.finalize = finalizeOwnedRuntime;", state);
  const running = ["unexpected-signal", "requested-stop"].includes(scenario);
  const code = running ? "process.stdout.write('ready'); setInterval(() => {}, 1000)" : `process.exit(${scenario === "abnormal-exit" ? 23 : 0})`;
  const subprocess = state.start("own lifecycle control", process.execPath, ["-e", code], { PATH: "/usr/bin:/bin" },
    { persistent: scenario !== "completed-build" && scenario !== "abnormal-exit" });
  try {
    if (running) await once(subprocess.stdout, "data");
    if (scenario === "unexpected-signal") { subprocess.kill("SIGTERM"); await once(subprocess, "close"); }
    else if (!running) await once(subprocess, "close");
    if (["completed-build", "requested-stop"].includes(scenario)) await expect(state.finalize()).resolves.toBeUndefined();
    else await expect(state.finalize()).rejects.toThrow("Owned E2E runtime cleanup failed");
  } finally {
    if (subprocess.exitCode == null && subprocess.signalCode == null) { subprocess.kill("SIGKILL"); await once(subprocess, "close"); }
  }
});

it.each(["complete", "failed", "pending-post"])("actual ordinary navigation wrapper preserves %s behavior", async kind => {
  const evidence = createMainRequestEvidence({ baseUrl: "https://localhost:12345" });
  const page = { goto: vi.fn(async () => "navigated"), evaluate: vi.fn(async () => ({ documentId: "own-doc" })) };
  evidence.observeNative(page, { kind: "document", documentId: "own-doc" });
  const req = failedRequest(page, { method: kind === "pending-post" ? "POST" : "GET" });
  evidence.observeRequest(req, "main", page);
  const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "navigateWithSettledReads");
  const state = { mainRequestEvidence: evidence, UI_WAIT_TIMEOUT_MS: 100 };
  vm.createContext(state); vm.runInContext(wrapper.getFullText(ast) + "\nglobalThis.navigate = navigateWithSettledReads;", state);
  const navigation = state.navigate(page, "/app/calendar");
  if (kind === "pending-post") { await expect(navigation).resolves.toBe("navigated"); evidence.observeFailure(req); expect(evidence.reason(req)).toBeNull(); }
  else {
    expect(page.goto).not.toHaveBeenCalled();
    if (kind === "failed") { evidence.observeFailure(req); await expect(navigation).rejects.toThrow("Captured GET failed"); expect(page.goto).not.toHaveBeenCalled(); }
    else { evidence.observeFinished(req); await expect(navigation).resolves.toBe("navigated"); }
  }
});

it.each(["navigate", "reload", "unresolved-read"])("project/calendar receives the real main transition boundary: %s", async kind => {
  const calls = [];
  const visit = node => {
    if (ts.isCallExpression(node) && node.expression.getText(ast) === "runProjectCalendarCoverage") calls.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast); expect(calls).toHaveLength(1);
  const mainPage = {}; const otherPage = { goto: vi.fn(async () => "navigated") };
  const navigate = vi.fn(async (target, url, options) => {
    if (kind === "unresolved-read") throw new Error("Captured GET failed before navigation");
    return target.goto(url, options);
  });
  const reload = vi.fn(async () => "reloaded");
  let received;
  const state = { page: mainPage, context: {}, pool: {}, userId: 1, sharedProjectId: 2,
    legacyProjectId: 3, sharedChannelId: 4, waitFor: vi.fn(), artifactDir: "/tmp/unused-calendar-contract",
    expectedCompletedPages: new Set(), navigateWithSettledReads: navigate, reloadInBrowser: reload,
    runProjectCalendarCoverage: async args => { received = args; } };
  vm.createContext(state); await vm.runInContext(calls[0].getText(ast), state);
  expect(typeof received.navigate).toBe("function"); expect(typeof received.reload).toBe("function");
  if (kind === "reload") {
    await expect(received.reload(otherPage)).resolves.toBe("reloaded");
    expect(reload).toHaveBeenCalledExactlyOnceWith(otherPage);
  } else {
    const options = { waitUntil: "domcontentloaded" };
    const work = received.navigate(otherPage, "/app/calendar#future", options);
    if (kind === "unresolved-read") {
      await expect(work).rejects.toThrow("Captured GET failed"); expect(otherPage.goto).not.toHaveBeenCalled();
    } else {
      await expect(work).resolves.toBe("navigated");
      expect(otherPage.goto).toHaveBeenCalledExactlyOnceWith("/app/calendar#future", options);
    }
    expect(navigate).toHaveBeenCalledExactlyOnceWith(otherPage, "/app/calendar#future", options);
  }
});


it.each(["requested-npm-sigterm", "unrequested-npm-sigterm", "unrequested-code143", "requested-other-nonzero"])("actual npm shell exit preserves stop intent: %s", async scenario => {
  const selected = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["child", "processTreeAlive", "signalChild", "stopChild", "finalizeOwnedRuntime"].includes(node.name?.text));
  const state = { spawn, process, Promise, AggregateError, assert: (value, message) => { if (!value) throw new Error(message); },
    logs: [], children: [], runtimeFinalized: false, interfaceEvidence: {},
    publishQueue: null, mediaQueue: null, statsQueue: null, legalVisualQueue: null, projectExportQueue: null,
    publicationExtraQueue: null, publicationReviewReminderQueue: null, fakeServer: null, tlsProxyServer: null,
    tlsDirectory: null, redis: null, pool: null, releaseE2eBuildLock: () => {},
    waitFor: async check => { for (let i = 0; i < 400; i++) { if (check()) return true; await new Promise(resolve => setTimeout(resolve, 5)); } throw new Error("owned npm child remained"); },
  };
  vm.createContext(state); vm.runInContext(selected.map(node => node.getFullText(ast)).join("\n")
    + "\nglobalThis.start = child; globalThis.finalize = finalizeOwnedRuntime; globalThis.signal = signalChild;", state);
  const directory = mkdtempSync(join(tmpdir(), "aurora-n52-npm-exit-"));
  writeFileSync(join(directory, "package.json"), JSON.stringify({ private: true, scripts: { start: "node fixture.cjs" } }));
  writeFileSync(join(directory, "fixture.cjs"), scenario === "unrequested-code143" ? "process.exit(143)" : "process.stdout.write('OWN_NPM_READY\\n'); setInterval(() => {}, 1000)");
  const useNpm = scenario !== "requested-other-nonzero";
  const subprocess = state.start("own npm exit control", useNpm ? "/bin/sh" : process.execPath,
    useNpm ? ["-c", 'trap "exit 143" TERM; npm --prefix "$1" run start --silent & wait "$!"', "owned-npm-wrapper", directory] : ["-e", "process.on('SIGTERM', () => process.exit(23)); process.stdout.write('OWN_NPM_READY\\n'); setInterval(() => {}, 1000)"],
    { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, npm_config_update_notifier: "false", npm_config_audit: "false" }, { persistent: true });
  const closed = once(subprocess, "close");
  try {
    if (scenario === "unrequested-code143") await closed;
    else {
      await new Promise((resolveReady, reject) => {
        let output = "";
        subprocess.stdout.on("data", chunk => { output += chunk; if (output.includes("OWN_NPM_READY")) resolveReady(); });
        subprocess.once("exit", () => { if (!output.includes("OWN_NPM_READY")) reject(new Error("own npm fixture exited before ready")); });
      });
      if (scenario === "unrequested-npm-sigterm") { state.signal(subprocess, "SIGTERM"); await closed; }
    }
    if (scenario === "requested-npm-sigterm") await expect(state.finalize()).resolves.toBeUndefined();
    else await expect(state.finalize()).rejects.toThrow("Owned E2E runtime cleanup failed");
    await closed;
    expect(subprocess.exitCode).toBe(scenario === "requested-other-nonzero" ? 23 : 143);
    expect(subprocess.signalCode).toBeNull();
    expect(subprocess.auroraE2eLifecycle.stopRequested).toBe(scenario.startsWith("requested-"));
  } finally {
    if (subprocess.exitCode == null && subprocess.signalCode == null) { state.signal(subprocess, "SIGKILL"); await closed; }
    rmSync(directory, { recursive: true, force: true });
  }
}, 10_000);


it("actual navigation wrapper accepts only its captured certified RSC cancellation", async () => {
  const evidence = createMainRequestEvidence({ baseUrl: "https://localhost:12345" });
  const page = { goto: vi.fn(async () => "navigated"), evaluate: vi.fn(async () => ({ documentId: "own-doc" })) };
  evidence.observeNative(page, { kind: "document", documentId: "own-doc" });
  const req = failedRequest(page, { method: "GET", path: "/app/opportunities?_rsc=owned", headers: { rsc: "1", "next-router-prefetch": "1" } });
  evidence.observeRequest(req, "main", page);
  const wrapper = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "navigateWithSettledReads");
  const state = { mainRequestEvidence: evidence, UI_WAIT_TIMEOUT_MS: 100 };
  vm.createContext(state); vm.runInContext(wrapper.getFullText(ast) + "\nglobalThis.navigate = navigateWithSettledReads;", state);
  const navigation = state.navigate(page, "/app/calendar");
  expect(page.goto).not.toHaveBeenCalled();
  evidence.observeResponse({ request: () => req, status: () => 200, headers: () => ({ "content-type": "text/x-component" }) });
  evidence.observeFailure(req);
  expect(evidence.reason(req)).toBe("completed_rsc_prefetch");
  await expect(navigation).resolves.toBe("navigated");
  expect(page.goto).toHaveBeenCalledOnce();
});

it("untracked child code143 still fails and cleanup continues", async () => {
  const { state, calls } = runtimeCleanupFixture();
  state.children[0].exitCode = 143;
  await expect(state.finalize()).rejects.toThrow("Owned E2E runtime cleanup failed");
  expect(calls).toContain("quit"); expect(calls).toContain("pool"); expect(calls).toContain("unlock");
});

it("persists exact request diagnostics after close, including late failed requests", async () => {
  const { state, context } = fixture(false);
  const rows = [];
  context.close.mockImplementation(async () => { rows.push({ id: 1, method: "GET", path: "/api/drafts", failure: "net::ERR_ABORTED", reason: null }); });
  state.mainRequestEvidence.snapshot = () => [...rows];
  await state.finalize();
  expect(state.interfaceEvidence.mainRequestDiagnostics).toEqual(rows);
  expect(state.interfaceEvidence.mainRequestDiagnostics).toHaveLength(1);
});


it("Studio persistence is resolved after close and admits only the exact failed Request", async () => {
  const { state, context } = fixture(false);
  const exact = {}; const other = {}; const exactIssue = { kind: "requestfailed", requestId: 1 };
  const otherIssue = { kind: "requestfailed", requestId: 2 };
  state.mainFailedRequestIssues.set(exact, exactIssue); state.mainFailedRequestIssues.set(other, otherIssue);
  state.browserIssues.push(exactIssue, otherIssue);
  let closed = false;
  context.close.mockImplementation(async () => { closed = true; });
  state.finalizeStudioSessionPersistence = async () => {
    expect(closed).toBe(true);
    return [{ request: exact, reason: "persisted_studio_snapshot" }];
  };
  await state.finalize();
  expect(state.browserIssues).toEqual([otherIssue]);
  expect(state.browserObservations).toContainEqual(expect.objectContaining({ requestId: 1, reason: "persisted_studio_snapshot" }));
});

it.each(["known-owner", "missing-owner", "missing-ledger"])("Studio diagnostics retain committed receipts without requiring a failed PUT: %s", async (kind) => {
  const receipt = { user_id: 1, revision: 3, payload: { synthetic: true } };
  const query = vi.fn(async (sql, values) => {
    expect(sql.trim()).toMatch(/^select user_id, revision, payload from e2e_studio_session_receipts/u);
    expect(values).toEqual([1]);
    return { rows: [receipt] };
  });
  const snapshot = vi.fn(options => options ? [{ revision: options.receipts[0].revision }] : []);
  const state = { URL, Date, Set, Promise, setTimeout, baseUrl: "https://localhost:12345",
    mainFailedRequestIssues: new Map(), studioReceiptLedgerReady: kind !== "missing-ledger",
    studioSessionOwner: kind === "missing-owner" ? null : 1, pool: { query }, interfaceEvidence: {},
    studioSessionContract: { hashes: [] }, readStudioSessionProof: () => null,
    studioSessionEvidence: { snapshot, proofs: () => [], recoverySnapshot: () => [], departureSnapshot: () => [{ matchedWrites: 1 }] } };
  const actual = ast.statements.find(node => ts.isFunctionDeclaration(node)
    && node.name?.text === "finalizeStudioSessionPersistence").getFullText(ast);
  vm.createContext(state); vm.runInContext(actual + "\nglobalThis.finalize=finalizeStudioSessionPersistence;", state);
  expect(await state.finalize()).toEqual([]); // Diagnostic reads never create an opaque request certificate.
  if (kind === "known-owner") {
    expect(query).toHaveBeenCalledOnce();
    expect(snapshot).toHaveBeenCalledWith({ owner: 1, receipts: [receipt] });
    expect(state.interfaceEvidence.studioSessionPersistence).toEqual([{ revision: 3 }]);
    expect(state.interfaceEvidence.studioSessionDepartures).toEqual([{ matchedWrites: 1 }]);
  } else {
    expect(query).not.toHaveBeenCalled();
    expect(state.interfaceEvidence.studioSessionPersistence).toEqual([]);
  }
});

it.each([
  { visible: [true], succeeds: true },
  { visible: [true, true], succeeds: true },
  { visible: [], succeeds: false },
  { visible: [false], succeeds: false },
  { visible: [true, false], succeeds: false },
])("Studio return requires visible result paragraphs for retained history: $visible", async ({ visible, succeeds }) => {
  const marker = source.indexOf("  const providerCallsBeforeStudioReturn =");
  const start = source.indexOf("\n", marker) + 1;
  const end = source.indexOf("  await studioSessionEvidence.assertRestored(composerStudioCheckpoint", start);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start);
  const locator = { count: async () => visible.length, nth: index => ({ isVisible: async () => visible[index] }),
    waitFor: async () => {
      if (visible.length !== 1) throw new Error("native locator strict mode requires one element");
      if (!visible[0]) throw new Error("result is not visible");
    } };
  const state = { consumedStudioUrl: new URL("https://localhost:12345/app/studio?draft=1"),
    libraryComposerResult: "same completed result retained under distinct message IDs",
    navigateWithSettledReads: vi.fn(async () => undefined), replaceWithSettledReads: vi.fn(async () => undefined),
    waitFor: async check => { if (!await check()) throw new Error("visible result readiness failed"); },
    page: { getByRole: (role, options) => {
      expect(role).toBe("region"); expect(options).toEqual({ name: "Диалог с ИИ", exact: true });
      return { getByText: (text, options) => {
        expect(text).toBe(state.libraryComposerResult); expect(options).toEqual({ exact: true }); return locator;
      } };
    } } };
  const run = vm.runInNewContext(`(async () => { ${source.slice(start, end)} })()`, state);
  if (succeeds) await expect(run).resolves.toBeUndefined();
  else await expect(run).rejects.toBeInstanceOf(Error);
});


function historyNavigationFixture({ settleReads = async () => {} } = {}) {
  const baseUrl = "https://localhost:12345";
  const library = `${baseUrl}/app/library?channelId=1`;
  const studio = `${baseUrl}/app/studio?draft=1`;
  const composer = `${baseUrl}/app/composer?draft=5&from=studio`;
  const entries = [library, studio, composer]; let index = 2;
  const events = [];
  const native = { location: { replace: url => { events.push("replace"); entries[index] = url; } },
    history: { back: () => { events.push("back"); index -= 1; } } };
  const page = {
    url: () => entries[index],
    goto: async path => { events.push("goto"); entries.splice(++index, entries.length, new URL(path, baseUrl).href); },
    waitForURL: vi.fn(async () => { events.push("waitForURL"); }),
    evaluate: vi.fn(async (fn, arg) => vm.runInNewContext(`(${fn.toString()})(arg)`, { ...native, arg })),
  };
  const state = { URL, baseUrl, page, UI_WAIT_TIMEOUT_MS: 30000,
    assert: (value, message) => { if (!value) throw new Error(message); },
    mainRequestEvidence: { settleReads: vi.fn(async (...args) => { events.push("settle"); await settleReads(...args); }) } };
  const wrappers = ast.statements.filter(node => ts.isFunctionDeclaration(node)
    && ["navigateWithSettledReads", "replaceWithSettledReads", "backWithSettledReads"].includes(node.name?.text));
  vm.createContext(state); vm.runInContext(wrappers.map(node => node.getFullText(ast)).join("\n"), state);
  return { state, page, entries, events, library, studio, composer };
}

it("actual full Studio recovery slice preserves three checkpoints and the original two Back destinations", async () => {
  const { state, page, entries, library, studio, composer } = historyNavigationFixture();
  const start = source.indexOf("  const providerCallsBeforeStudioReturn =");
  const end = source.indexOf("  const blockedValidation =", start);
  const backStart = source.indexOf("  const studioBackBefore =", end);
  const backEnd = source.indexOf("  const discussReference =", backStart);
  const backs = [...source.slice(backStart, backEnd).matchAll(/  await (?:page\.evaluate\(\(\) => globalThis\.history\.back\(\)\)|backWithSettledReads\(page\));/gu)].map(match => match[0]);
  expect(start).toBeGreaterThan(0); expect(end).toBeGreaterThan(start); expect(backs).toHaveLength(2);
  const checkpoints = ["first", "second", "composer"]; const receipts = [{ revision: 1 }, { revision: 2 }, { revision: 3 }];
  const persisted = [];
  Object.assign(state, { consumedStudioUrl: new URL(studio), composerDraftUrl: new URL(composer),
    libraryComposerResult: "same text in distinct messages", userId: 7,
    fakeState: { ai: { libraryGenerationCalls: 4 } }, interfaceEvidence: { pendingAiReplay: {} },
    firstStudioRecovery: checkpoints[0], secondStudioRecovery: checkpoints[1], composerStudioCheckpoint: checkpoints[2],
    firstStudioRendered: "first UI", secondStudioRendered: "second UI",
    libraryComposerText: { waitFor: vi.fn(async () => {}) }, readEditableText: async () => state.libraryComposerResult,
    waitFor: async check => { const result = await check(); if (!result) throw new Error("checkpoint not ready"); return result; },
    pool: { query: vi.fn(async (_sql, args) => { expect(args).toEqual([7]); return { rows: receipts }; }) },
    studioSessionEvidence: {
      assertRestored: vi.fn(async (checkpoint, ownerPage, options) => {
        expect(checkpoint).toBe("composer"); expect(ownerPage).toBe(page); expect(options).toEqual({ owner: 7 });
      }),
      assertRenderedMessages: vi.fn(async (checkpoint, ownerPage) => {
        expect(checkpoint).toBe("composer"); expect(ownerPage).toBe(page); return "complete composer UI";
      }),
      assertCheckpointPersisted: (checkpoint, options) => {
        persisted.push(checkpoint); expect(options.owner).toBe(7); expect(options.receipts).toBe(receipts);
      },
    },
  });
  page.getByRole = () => ({ getByText: () => ({ count: async () => 2, nth: () => ({ isVisible: async () => true }) }) });
  await vm.runInContext(`(async () => { ${source.slice(start, end)} })()`, state);
  expect(persisted).toEqual(checkpoints);
  expect(state.interfaceEvidence.pendingAiReplay).toEqual({ exactStudioRecoveryCheckpoints: 3, studioReturnProviderCalls: 0,
    restoredStudioUi: ["first UI", "second UI", "complete composer UI"] });
  expect(state.fakeState.ai.libraryGenerationCalls).toBe(4);
  expect(page.url()).toBe(composer);
  await vm.runInContext(`(async () => { ${backs[0]} })()`, state); expect(page.url()).toBe(studio);
  await vm.runInContext(`(async () => { ${backs[1]} })()`, state); expect(page.url()).toBe(library);
  expect(entries).toEqual([library, studio, composer]);
});

it.each(["replace", "back"])("native %s waits for reads and preserves the navigation contract", async kind => {
  let finish; const pending = new Promise(resolve => { finish = resolve; });
  const { state, page, events, studio } = historyNavigationFixture({ settleReads: () => pending });
  const run = kind === "replace" ? state.replaceWithSettledReads(page, "/app/studio?draft=1") : state.backWithSettledReads(page);
  expect(page.evaluate).not.toHaveBeenCalled(); finish(); await run;
  expect(page.url()).toBe(studio);
  expect(state.mainRequestEvidence.settleReads).toHaveBeenCalledWith(page, { timeoutMs: 30000 });
  expect(events).toEqual(kind === "replace" ? ["settle", "waitForURL", "replace"] : ["settle", "back"]);
  if (kind === "replace") expect(page.waitForURL).toHaveBeenCalledWith(studio, { waitUntil: "domcontentloaded", timeout: 30000 });
});
it.each(["replace", "back"])("native %s cannot hide an unsettled or failed read", async kind => {
  const { state, page, composer } = historyNavigationFixture({ settleReads: async () => { throw new Error("Captured GET failed"); } });
  const run = kind === "replace" ? state.replaceWithSettledReads(page, "/app/studio?draft=1") : state.backWithSettledReads(page);
  await expect(run).rejects.toThrow("Captured GET failed");
  expect(page.evaluate).not.toHaveBeenCalled(); expect(page.waitForURL).not.toHaveBeenCalled(); expect(page.url()).toBe(composer);
});
it("native replace rejects foreign origin before navigation", async () => {
  const { state, page } = historyNavigationFixture();
  await expect(state.replaceWithSettledReads(page, "https://foreign.invalid/app/studio")).rejects.toThrow("same-origin");
  expect(page.evaluate).not.toHaveBeenCalled(); expect(state.mainRequestEvidence.settleReads).not.toHaveBeenCalled();
});
it("native replace rejects an unexpected final URL", async () => {
  const { state, page } = historyNavigationFixture();
  page.evaluate.mockResolvedValue(undefined);
  await expect(state.replaceWithSettledReads(page, "/app/studio?draft=1")).rejects.toThrow("exact target");
});
