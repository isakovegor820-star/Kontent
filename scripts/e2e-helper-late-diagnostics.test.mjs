import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createChannelOnboardingNetworkTracker } from "./e2e-channel-onboarding-coverage.mjs";
import { safeAuthCoverageError } from "./e2e-auth-coverage.mjs";
import { classifyEditorCancellation } from "./e2e-editor-safety-coverage.mjs";

// Execute the actual helper's final block and event callbacks, without its DB,
// provider or UI setup. This tests the wiring as well as the shared finalizer.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const sourceFor = async (file) => {
  const text = await readFile(new URL(file, import.meta.url), "utf8");
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
};
function nodes(root, predicate) {
  const found = []; const visit = (node) => { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }; visit(root); return found;
}
async function runFinal(file, bindings, event) {
  const ast = await sourceFor(file);
  const final = nodes(ast, (node) => ts.isTryStatement(node) && node.finallyBlock)
    .find((node) => node.finallyBlock.getText(ast).includes("finalizeE2eBrowserLifecycle({ context, transport"));
  expect(final, "actual outer finalizer must exist").toBeDefined();
  const declarations = nodes(ast, (node) => ts.isVariableDeclaration(node) && node.name.getText(ast) === "assertDiagnostics");
  const diagnosticDeclaration = declarations.length ? "const " + declarations[0].getText(ast) + ";" : "";
  const closure = { assert, join, finalizeE2eBrowserLifecycle, ...bindings };
  const page = new EventEmitter(); page.url = () => bindings.origin; closure.page = page;
  // Reuse actual listener expressions, so a listener removal or changed event
  // classification is reflected in this check rather than a test-only collector.
  for (const call of nodes(ast, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === 'page.on' && ts.isStringLiteral(node.arguments[0]))) {
    const type = call.arguments[0].text;
    const callback = await new AsyncFunction(...Object.keys(closure), "return " + call.arguments[1].getText(ast))(...Object.values(closure));
    page.on(type, callback);
  }
  bindings.context.close.mockImplementation(async () => { await event?.(page); });
  return new AsyncFunction(...Object.keys(closure), diagnosticDeclaration + final.finallyBlock.getText(ast))(...Object.values(closure));
}
function fixture() {
  const issues = []; const evidence = { result: "PASS" }; const written = [];
  const context = { close: vi.fn(async () => {}) };
  const transport = { stop: vi.fn(), assertClean() {}, snapshot: () => [], expectedDeniedSnapshot: () => [] };
  const bindings = { context, transport, boundary: { assertClean() {}, snapshot: () => [] }, failure: undefined, primaryError: undefined,
    failures: issues, issues, hydrationIssues: issues, result: { ok: true }, evidence, externalAttempts: [],
    createHash, safeAuthCoverageError, mkdir: vi.fn(), cleanup: [], writeFile: async (_path, body) => written.push(JSON.parse(body)), artifactDir: "/synthetic-evidence",
    loginRateLimitFixtureIngress: { release: vi.fn() }, token: "owned", counters: async () => ({}),
    redis: { del: vi.fn(), exists: async () => 0, quit: vi.fn() }, ipKey: "owned-ip", accountKey: "owned-account",
    browser: { close: vi.fn(), browserType: () => ({ name: () => "chromium" }) }, server: null, pool: { end: vi.fn() }, scopes: ["Интернет"],
    closeHttpsProxy: vi.fn(), ingressBoundary: { assertClean: vi.fn() }, productEventReceipt: { status: 200, accepted: 1, replayed: 0, persisted: 1 },
    console: { log: vi.fn() }, browserErrors: { stop: vi.fn(), snapshot: () => ({ unexpected: [] }), assertClean: vi.fn(), expectHttpError: vi.fn() }, phase: "complete", conflictDraftId: 1, expiryDraftId: 2, responseWork: [], consoleErrors: [],
    classifiedConsoleCount: 0, network: [], requests: new Map(), navigating: new Map(), transitions: [], expectedCancellations: [],
    expectedHttp: [], callerAborts: [], browserObservations: [], screenshotPages: new Set(), pages: [],
    readEvidence: { observeRequest: vi.fn(() => ({ id: 1 })), observeResponse: vi.fn(), observeFinished: vi.fn(), observeFailure: vi.fn(), reason: vi.fn(() => null) },
    readDiagnostics: { beforeClose: null, afterClose: null }, snapshotReads: () => ({ reads: [], unmatchedReads: [], pendingRequests: [] }),
    origin: "https://127.0.0.1:12345", classifyEditorCancellation, classifyE2eKnownBrowserObservation: () => null,
    expectedExpiryPaths: new Set(["/api/auth/me"]), releaseFirst: vi.fn(), releaseSecond: vi.fn(), tracingStarted: false,
  };
  bindings.diagnostics = { flush: async () => {}, stop: () => bindings.browserErrors.stop(),
    assertClean: () => bindings.browserErrors.assertClean(), snapshot: () => ({ browserErrors: bindings.browserErrors.snapshot() }) };
  return { bindings, written, issues };
}
for (const file of ["e2e-auth-coverage.mjs", "e2e-login-rate-limit-coverage.mjs", "test-trends-hydration-e2e.mjs", "e2e-editor-safety-coverage.mjs"]) {
  it(`${file} preserves its clean finalization`, async () => {
    const { bindings, issues } = fixture();
    await runFinal(file, bindings);
    expect(issues).toEqual([]); expect(bindings.context.close).toHaveBeenCalledOnce(); expect(bindings.transport.stop).toHaveBeenCalledOnce();
  });
  it(`${file} rejects a pageerror emitted during actual close`, async () => {
    const { bindings, issues } = fixture();
    await expect(runFinal(file, bindings, (page) => page.emit("pageerror", new TypeError("synthetic late page error")))).rejects.toThrow();
    expect(issues).toHaveLength(1); expect(bindings.transport.stop).toHaveBeenCalledOnce();
  });
}
it.each(["e2e-editor-safety-coverage.mjs", "test-trends-hydration-e2e.mjs"])("%s rechecks its collected console errors after close", async (file) => {
  const { bindings } = fixture();
  await expect(runFinal(file, bindings, (page) => page.emit("console", { type: () => "error", text: () => "synthetic hydration error", location: () => ({ url: "" }) }))).rejects.toThrow();
});
it("editor awaits late response classification before interpreting an expected console message", async () => {
  const { bindings, issues } = fixture(); bindings.phase = "expiry";
  await runFinal("e2e-editor-safety-coverage.mjs", bindings, (page) => {
    const request = { method: () => "GET" };
    page.emit("console", { type: () => "error", text: () => "Failed to load resource: server responded with a status of 401", location: () => ({ url: bindings.origin + "/api/auth/me" }) });
    page.emit("response", { request: () => request, url: () => bindings.origin + "/api/auth/me", status: () => 401, json: async () => { await Promise.resolve(); return { error: "unauthorized" }; } });
  });
  expect(issues).toEqual([]); expect(bindings.expectedHttp).toHaveLength(1);
});
it("editor retains late reset failures instead of ignoring every teardown request", async () => {
  const { bindings, issues } = fixture();
  await expect(runFinal("e2e-editor-safety-coverage.mjs", bindings, (page) => page.emit("requestfailed", {
    url: () => bindings.origin + "/api/drafts/2", method: () => "PATCH", failure: () => ({ errorText: "net::ERR_CONNECTION_RESET" }),
  }))).rejects.toThrow();
  expect(issues).toEqual([expect.objectContaining({ kind: "requestfailed", method: "PATCH" })]);
});
it.each([false, true])("channel keeps its tracker through close (late error=%s)", async (lateError) => {
  const { bindings, written } = fixture(); const page = new EventEmitter();
  const tracker = createChannelOnboardingNetworkTracker({ page, baseUrl: bindings.origin, waitFor: async () => {} });
  bindings.tracker = tracker; bindings.bodyObserver = { snapshot: () => [] };
  await (async () => {
    const pending = runFinal("e2e-channel-onboarding-coverage.mjs", bindings, () => {
      expect(page.listenerCount("pageerror")).toBe(1);
      if (lateError) page.emit("pageerror", new TypeError("synthetic private late error"));
    });
    if (lateError) await expect(pending).rejects.toThrow(); else await pending;
  })();
  expect(page.listenerCount("pageerror")).toBe(0);
  expect(written[0].unexpected).toHaveLength(lateError ? 1 : 0);
  expect(written[0].lifecycleFailure).toBe(lateError);
  expect(bindings.result.browserNetwork.unexpected).toEqual(written[0].unexpected);
});
it("hydration retains warnings about hydration while ordinary warnings remain outside its error scope", async () => {
  const broken = fixture();
  await expect(runFinal("test-trends-hydration-e2e.mjs", broken.bindings, (page) => page.emit("console", {
    type: () => "warning", text: () => "synthetic hydration mismatch",
  }))).rejects.toThrow("hydration errors");
  const clean = fixture();
  await runFinal("test-trends-hydration-e2e.mjs", clean.bindings, (page) => page.emit("console", {
    type: () => "warning", text: () => "synthetic ordinary informational warning",
  }));
  expect(clean.issues).toEqual([]);
});
it("editor preserves a rejecting late response task and publishes failure instead of an unhandled exit", async () => {
  const { bindings, written } = fixture(); const error = new Error("exact response evidence rejected");
  bindings.phase = "expiry"; bindings.browserErrors.expectHttpError.mockRejectedValue(error);
  await expect(runFinal("e2e-editor-safety-coverage.mjs", bindings, (page) => {
    page.emit("response", { request: () => ({ method: () => "GET" }), url: () => bindings.origin + "/api/auth/me",
      status: () => 401, json: async () => ({ error: "unauthorized" }) });
  })).rejects.toBe(error);
  expect(written[0]).toMatchObject({ ok: false, message: error.message });
});

it.each(["window-only", "raw-abort-only", "exact-request"])("editor final admission requires native Request proof: %s", async (kind) => {
  const { bindings, issues } = fixture(); let owned;
  bindings.readEvidence.reason.mockImplementation(request => kind === "exact-request" && request === owned ? "caller_abort_signal" : null);
  const pending = runFinal("e2e-editor-safety-coverage.mjs", bindings, page => {
    const at = Date.now();
    owned = { url: () => bindings.origin + "/api/drafts/2", method: () => "GET", headers: () => ({}),
      resourceType: () => "fetch", failure: () => ({ errorText: "net::ERR_ABORTED" }) };
    const navigation = { id: 1, page: -1, startedAt: at - 100, finishedAt: at + 1000, complete: true, destination: "/login" };
    if (kind === "window-only") { bindings.navigating.set(page, navigation); bindings.transitions.push(navigation); }
    if (kind === "raw-abort-only") bindings.callerAborts.push({ aborted: true, page: -1, url: owned.url(), at });
    page.emit("request", owned); page.emit("requestfailed", owned);
  });
  if (kind === "exact-request") {
    await pending; expect(issues).toEqual([]);
    expect(bindings.expectedCancellations).toEqual([expect.objectContaining({ reason: "caller_abort_signal" })]);
    expect(bindings.readEvidence.reason).toHaveBeenCalledWith(owned);
  } else { await expect(pending).rejects.toThrow("unexpected browser/runtime errors"); expect(issues).toHaveLength(1); }
});
