import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { expect, it, vi } from "vitest";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";

const source = await readFile(new URL("./e2e-editor-safety-coverage.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("editor.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const all = (predicate) => { const result = []; const visit = n => { if (predicate(n)) result.push(n); ts.forEachChild(n, visit); }; visit(ast); return result; };
async function variable(name, scope) {
  const found = all(n => ts.isVariableDeclaration(n) && n.name.getText(ast) === name);
  assert.equal(found.length, 1, `actual ${name} declaration required`);
  return new AsyncFunction(...Object.keys(scope), `return (${found[0].initializer.getText(ast)});`)(...Object.values(scope));
}
function fixture() {
  const page = new EventEmitter();
  const observer = { observeRequest: vi.fn(() => ({ id: 51 })), observeResponse: vi.fn(), observeFinished: vi.fn(), observeFailure: vi.fn(),
    snapshot: vi.fn(() => [{ id: 51, path: "/api/drafts/15", status: null, failure: null, callerMatched: true, callerFailure: true }]),
    snapshotUnmatchedReads: vi.fn(() => []), reason: () => { throw Error("observational helper must not grant cancellation"); },
    proofs: () => { throw Error("observational helper must not grant cancellation"); }, settleReads: () => { throw Error("old idle contract must remain in use"); } };
  const scope = { context: { newPage: async () => page }, pages: [], origin: "https://127.0.0.1:12345", network: [], requests: new Map(),
    phase: "recovery", issues: [], responseWork: [], expectedHttp: [], consoleErrors: [], browserObservations: [], screenshotPages: new Set(),
    browser: { browserType: () => ({ name: () => "firefox" }) }, classifyE2eKnownBrowserObservation: () => null,
    navigating: new Map(), browserErrors: { expectHttpError: vi.fn() }, readEvidence: observer, createHash, callerAborts: [], assert };
  return { page, observer, scope };
}
it("feeds the same real Request identities and late terminal events to the observer", async () => {
  const { page, observer, scope } = fixture();
  const recordPage = await variable("recordPage", scope); await recordPage();
  const request = { url: () => scope.origin + "/api/drafts/15", method: () => "GET", headers: () => ({}), resourceType: () => "fetch", failure: () => ({ errorText: "NS_BINDING_ABORTED" }) };
  const response = { request: () => request, status: () => 200, headers: () => ({ "content-type": "application/json" }) };
  page.emit("request", request); page.emit("response", response); page.emit("requestfinished", request); page.emit("requestfailed", request);
  expect(observer.observeRequest).toHaveBeenCalledExactlyOnceWith(request, "editor:page0", page);
  expect(observer.observeResponse).toHaveBeenCalledExactlyOnceWith(response);
  expect(observer.observeFinished).toHaveBeenCalledExactlyOnceWith(request);
  expect(observer.observeFailure).toHaveBeenCalledExactlyOnceWith(request);
  expect(scope.network[0]).toMatchObject({ nativeRequestId: 51, finishedAt: expect.any(Number), failedAt: expect.any(Number) });
  expect(scope.issues).toEqual([expect.objectContaining({ kind: "requestfailed", requestId: 1 })]);
});
it("delivery snapshots retain unresolved identity but whitelist raw abort metadata", async () => {
  const { scope } = fixture();
  scope.network.push({ id: 469, nativeRequestId: 51, page: 1, method: "GET", path: "/api/drafts/15", startedAt: 100, url: scope.origin + "/api/drafts/15?token=private-query" });
  scope.callerAborts.push({ page: 1, method: "GET", url: scope.origin + "/api/drafts/15?token=private-query#private-fragment", at: 101, receivedAt: 102, aborted: true, body: "private-body", token: "private-token" });
  const snapshotReads = await variable("snapshotReads", scope); const snapshot = snapshotReads();
  expect(snapshot).toMatchObject({ semantics: "delivery-time observations; missing events are not completion evidence", initialized: true,
    pendingRequests: [{ id: 469, nativeRequestId: 51, page: 1, method: "GET", path: "/api/drafts/15", startedAt: 100, status: null }],
    callerAborts: [{ page: 1, method: "GET", path: "/api/drafts/15", urlHash: expect.stringMatching(/^[a-f0-9]{64}$/u), at: 101, receivedAt: 102, aborted: true }] });
  expect(JSON.stringify(snapshot)).not.toMatch(/private-query|private-fragment|private-body|private-token/u);
  expect(snapshot.reads[0]).toMatchObject({ status: null, failure: null, callerFailure: true });
});
it("an unresolved GET keeps the unchanged contentIdle predicate false despite native abort observations", async () => {
  const { scope, page } = fixture(); scope.pages.push(page);
  scope.network.push({ id: 469, page: 0, path: "/api/drafts/15", method: "GET" });
  const waitFor = vi.fn(async (condition, label, timeout) => { expect(timeout).toBe(45_000); expect(condition()).toBe(false); throw Error(label); });
  const contentIdle = await variable("contentIdle", { ...scope, waitFor, TIMEOUT: 45_000 });
  await expect(contentIdle(page, "held original")).rejects.toThrow("held original: requests did not settle");
  expect(waitFor).toHaveBeenCalledOnce();
});
it("writes separate before-close and after-close observations while preserving late failure", async () => {
  const { scope, observer } = fixture(); const written = []; const readDiagnostics = { beforeClose: null, afterClose: null };
  const snapshotReads = await variable("snapshotReads", scope);
  const original = Error("original idle failure");
  const context = { close: async () => { scope.network.push({ id: 469, page: 0, method: "GET", path: "/api/drafts/15", startedAt: 100 });
    observer.snapshot.mockReturnValue([{ id: 51, path: "/api/drafts/15", callerFailure: false }]); } };
  const outer = all(n => ts.isTryStatement(n) && n.finallyBlock?.getText(ast).includes("finalizeE2eBrowserLifecycle({ context, transport"))[0];
  assert(outer);
  const bindings = { ...scope, context, transport: { stop: async () => {}, snapshot: () => [], assertClean: () => {} }, boundary: { snapshot: () => [], assertClean: () => {} }, failure: original,
    releaseFirst: () => {}, releaseSecond: () => {}, tracingStarted: false, browserErrors: { stop: () => {}, snapshot: () => ({ unexpected: [] }) },
    readDiagnostics, snapshotReads, assertDiagnostics: () => {}, finalizeE2eBrowserLifecycle, join, artifactDir: "/owned-synthetic", result: undefined,
    conflictDraftId: 15, expiryDraftId: null, expectedCancellations: [], transitions: [], writeFile: async (_path, body) => written.push(JSON.parse(body)) };
  await expect(new AsyncFunction(...Object.keys(bindings), outer.finallyBlock.getText(ast))(...Object.values(bindings))).rejects.toBe(original);
  expect(written[0]).toMatchObject({ ok: false, message: original.message, readDiagnostics: {
    beforeClose: { pendingRequests: [], reads: [{ callerFailure: true }] },
    afterClose: { pendingRequests: [{ id: 469 }], reads: [{ callerFailure: false }] },
  } });
});
it("does not serialize forged caller metadata as raw diagnostic scalars", async () => {
  const { scope } = fixture();
  scope.callerAborts.push({ page: "private-page", method: "private-method", url: scope.origin + "/api/drafts/15?private-query", at: "private-at", receivedAt: { token: "private-received" }, aborted: "private-boolean" });
  const snapshotReads = await variable("snapshotReads", scope);
  const snapshot = snapshotReads();
  expect(snapshot.callerAborts).toEqual([{ page: null, method: null, path: "/api/drafts/15", urlHash: expect.stringMatching(/^[a-f0-9]{64}$/u), at: null, receivedAt: null, aborted: false }]);
  expect(JSON.stringify(snapshot)).not.toMatch(/private-/u);
});
