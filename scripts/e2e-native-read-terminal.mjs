import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";

// Execute the actual consumer without importing the top-level app/DB runner.
// Both unit and native fault regressions use this same production QA function.
const mainSource = readFileSync(new URL("./test-e2e-real.mjs", import.meta.url), "utf8");
const mainAst = ts.createSourceFile("test-e2e-real.mjs", mainSource, ts.ScriptTarget.Latest, true);
const idleSource = mainAst.statements.find(node => ts.isFunctionDeclaration(node)
  && node.name?.text === "waitForFirstPartyNetworkIdle").getFullText(mainAst);
export function createMainNetworkIdleFixture({ evidence, page, pendingRequests, timeoutMs = 150 }) {
  const state = { assert, URL, Date, Promise, setTimeout, mainRequestEvidence: evidence,
    browserPendingRequests: new WeakMap([[page, pendingRequests]]),
    browserRequestIds: new WeakMap(), browserRequestResponses: new WeakMap(),
    UI_WAIT_TIMEOUT_MS: timeoutMs, baseUrl: "http://127.0.0.1",
    sanitizeE2eNetworkUrl: url => new URL(url).pathname };
  vm.runInNewContext(idleSource + "\nglobalThis.wait = waitForFirstPartyNetworkIdle;", state);
  return ({ idleMs = 0, includeProductEvents = false } = {}) => state.wait(page, "native network idle", idleMs, includeProductEvents);
}

const editorSource = readFileSync(new URL("./e2e-editor-safety-coverage.mjs", import.meta.url), "utf8");
const editorAst = ts.createSourceFile("editor.mjs", editorSource, ts.ScriptTarget.Latest, true);
const editorIdleDeclarations = [];
const visitEditor = node => {
  if (ts.isVariableDeclaration(node) && node.name.getText(editorAst) === "contentIdle") editorIdleDeclarations.push(node);
  ts.forEachChild(node, visitEditor);
};
visitEditor(editorAst); assert.equal(editorIdleDeclarations.length, 1);
export function createEditorNetworkIdleFixture({ evidence, page, requests, network, timeoutMs = 1100 }) {
  const state = { readEvidence: evidence, pages: [page], requests, network, responseWork: [], TIMEOUT: timeoutMs,
    waitFor: async (condition, label, timeout) => {
      const deadline = Date.now() + timeout;
      while (!condition()) {
        assert(Date.now() < deadline, label);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    } };
  return vm.runInNewContext(`(${editorIdleDeclarations[0].initializer.getText(editorAst)})`, state).bind(null, page, "native editor idle");
}

const findIdle = (file, name, predicate) => {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true); const found = [];
  const visit = node => {
    if (predicate(node) && node.name?.getText(ast) === name) found.push(node);
    ts.forEachChild(node, visit);
  };
  visit(ast); assert.equal(found.length, 1); return found[0].getText(ast);
};
const channelIdleSource = findIdle("./e2e-channel-onboarding-coverage.mjs", "waitForIdle", ts.isMethodDeclaration);
const zoomIdleSource = findIdle("./e2e-true-zoom-coverage.mjs", "waitForContentIdle", ts.isFunctionDeclaration);
export function createChannelNetworkIdleFixture({ evidence, requests, network }) {
  const scope = { readEvidence: evidence, requests, network, waitFor: async (condition, label, timeout) => {
    assert.equal(timeout, 60_000); const deadline = Date.now() + 1100;
    while (!condition()) {
      assert(Date.now() < deadline, label); await new Promise(resolve => setTimeout(resolve, 10));
    }
  } };
  return vm.runInNewContext(`({${channelIdleSource}}).waitForIdle`, scope).bind(null, "native channel idle");
}
export function createZoomNetworkIdleFixture({ evidence, requests, network }) {
  // Advance only this extracted consumer's test deadline clock. Browser fetch,
  // AbortSignal observations and the full zoom journey retain their real clock.
  // Both the unchanged30s deadline and750ms quiet interval execute as written.
  let tick = 0;
  const scope = { requestEvidence: evidence, requests, report: { network }, Promise, setTimeout,
    Date: { now: () => (tick += 500) } };
  return vm.runInNewContext(`(${zoomIdleSource})`, scope).bind(null, "native zoom idle");
}

// Deterministic loss of the target's SDK terminal observation, backed by real
// fetch/AbortSignal events. Never suppress an event in the production QA path.
export async function verifyNativeReadTerminalEvidence(browser) {
  let fault; const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/drafts/14") {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Read lifetime fixture</title>");
    } else if (fault === "network") {
      const timer = setTimeout(() => response.destroy(), 30);
      response.once("close", () => clearTimeout(timer));
    }
    // Other modes remain pending at the HTTP layer until abort/cleanup.
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`; const report = []; const idleFailures = [];
  try {
    for (const mode of ["abort", "network", "pending"]) {
      fault = mode; const context = await browser.newContext();
      const evidence = createMainRequestEvidence({ baseUrl }); await evidence.install(context);
      let target; let withheld = 0;
      context.on("request", request => {
        evidence.observeRequest(request, "main", request.frame().page());
        if (request.url() === `${baseUrl}/api/drafts/14`) { assert(!target); target = request; }
      });
      context.on("response", response => evidence.observeResponse(response));
      context.on("requestfinished", request => evidence.observeFinished(request));
      context.on("requestfailed", request => {
        if (request === target) withheld++;
        else evidence.observeFailure(request);
      });
      try {
        const page = await context.newPage(); await page.goto(baseUrl);
        const started = page.waitForRequest(request => request.url() === `${baseUrl}/api/drafts/14`);
        await page.evaluate(() => {
          window.fixtureAbort = new AbortController();
          window.fixtureRead = fetch("/api/drafts/14", { signal: window.fixtureAbort.signal })
            .then(response => response.json()).then(() => "success", error => error.name);
        });
        await started;
        if (mode === "abort") {
          assert.equal(await page.evaluate(async () => { window.fixtureAbort.abort(); return window.fixtureRead; }), "AbortError");
        } else if (mode === "network") assert.equal(await page.evaluate(() => window.fixtureRead), "TypeError");
        await page.evaluate(() => undefined);
        if (mode === "abort") await evidence.settleReads(page, { timeoutMs: 500 });
        else await assert.rejects(evidence.settleReads(page, { timeoutMs: 100 }), /Captured GET/u);
        const pendingRequests = new Set([target]);
        const editorRow = { page: 0, method: "GET", path: "/api/drafts/14" };
        const consumers = {
          main: createMainNetworkIdleFixture({ evidence, page, pendingRequests }),
          editor: createEditorNetworkIdleFixture({ evidence, page, requests: new Map([[target, editorRow]]), network: [editorRow] }),
          channel: createChannelNetworkIdleFixture({ evidence, requests: new Map([[target, editorRow]]), network: [editorRow] }),
          zoom: createZoomNetworkIdleFixture({ evidence, requests: new Map([[target, editorRow]]), network: [editorRow] }),
        };
        const idleOutcomes = {};
        for (const [consumer, waitForIdle] of Object.entries(consumers)) {
          try { await waitForIdle(); idleOutcomes[consumer] = "settled"; }
          catch (error) {
            assert.match(error.message, /did not settle/u);
            idleOutcomes[consumer] = "rejected";
          }
          if (idleOutcomes[consumer] !== (mode === "abort" ? "settled" : "rejected")) idleFailures.push({ mode, consumer, actual: idleOutcomes[consumer] });
        }
        assert(pendingRequests.has(target), "Idle consumer must preserve the original observation for later contradictions");
        const row = evidence.snapshot().find(row => row.path === "/api/drafts/14");
        assert(row); assert.equal(row.nativeMatchCount, 1); assert.equal(row.requestMatchCount, 1);
        assert.equal(row.status, null); assert.equal(row.failure, null); assert.equal(row.finishedAt, null);
        assert.equal(row.reason, mode === "abort" ? "native_caller_abort_without_transport_terminal" : null);
        report.push({ mode, callerFailure: row.callerFailure, withheldTerminalEvents: withheld, reason: row.reason,
          idleOutcomes, pendingObservationRetained: true });
      } finally { await context.close(); }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  assert.deepEqual(idleFailures, [], `Actual idle consumers differ from safe native outcomes: ${JSON.stringify(report)}`);
  return report;
}
