import assert from "node:assert/strict";
import http from "node:http";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";

// These are the actual shipped polling/fence/fetch functions. The fixture owns
// only loopback HTTP and never imports the application or its environment.
const source = ["workspace-polling.ts", "client-workspace-isolation.ts", "project-fetch.ts"]
  .map(file => ts.transpileModule(readFileSync(new URL(`../src/lib/${file}`, import.meta.url), "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText.replace(/^export /gm, "")).join("\n");

export async function verifyNativeWorkspacePolling(browser) {
  const sockets = new Set(); let mode;
  const server = http.createServer((request, response) => {
    if (!request.url.startsWith("/api/")) {
      response.setHeader("content-type", "text/html");
      response.end("<!doctype html><title>Owned polling lifecycle</title>");
    } else if (mode === "network") {
      const timer = setTimeout(() => response.destroy(), 30);
      response.once("close", () => clearTimeout(timer));
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`; const report = [];
  try {
    for (mode of ["navigate", "reload", "dispose", "network"]) {
      const context = await browser.newContext();
      await context.route("**/*", route => new URL(route.request().url()).origin === baseUrl ? route.continue() : route.abort());
      const evidence = createMainRequestEvidence({ baseUrl }); await evidence.install(context);
      context.on("request", request => evidence.observeRequest(request, "polling", request.frame().page()));
      context.on("response", response => evidence.observeResponse(response));
      context.on("requestfinished", request => evidence.observeFinished(request));
      context.on("requestfailed", request => evidence.observeFailure(request));
      const nativeFailures = [];
      context.on("requestfailed", request => {
        const url = new URL(request.url());
        if (url.origin === baseUrl && ["/api/channels", "/api/posts", "/api/ai/usage"].includes(url.pathname)) {
          nativeFailures.push({ path: url.pathname, errorText: request.failure()?.errorText ?? null });
        }
      });
      try {
        const page = await context.newPage(); await page.goto(baseUrl);
        await page.addScriptTag({ content: source + `;window.startPolling = startVisibleWorkspacePolling;
          window.createFence = createWorkspaceRequestFence;window.ownedFetch = projectFetch;setClientProjectId(1);` });
        await page.evaluate(() => {
          const real = window.createFence(); const ai = window.createFence();
          const reads = []; window.reads = reads;
          const read = (paths, fence) => {
            const ticket = fence.start("project:1");
            const work = Promise.all(paths.map(path => window.ownedFetch(path, { signal: ticket.signal })
              .then(response => response.json()).then(() => "success", error => error.name)));
            reads.push(work); return work.then(() => undefined);
          };
          window.stopPolling = window.startPolling({ visibility: document, lifecycle: window,
            refreshReal: () => read(["/api/channels", "/api/posts"], real),
            refreshAiUsage: () => read(["/api/ai/usage"], ai),
            cancelReads: () => { real.invalidate(); ai.invalidate(); } });
        });
        const deadline = Date.now() + 3000;
        while (evidence.snapshot().filter(row => row.path.startsWith("/api/")).length < 3) {
          assert(Date.now() < deadline, "All three real reads must start before the lifecycle event");
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        if (mode === "network") {
          assert.deepEqual(await page.evaluate(() => Promise.all(window.reads)), [["TypeError", "TypeError"], ["TypeError"]]);
          await page.goto(baseUrl + "/destination");
        } else if (mode === "dispose") {
          // Bound the RED oracle too: a broken stop leaves its HTTP calls open.
          await page.evaluate(() => window.stopPolling());
        } else if (mode === "reload") await page.reload();
        else await page.goto(baseUrl + "/destination");
        await page.evaluate(() => undefined);
        await new Promise(resolve => setTimeout(resolve, 60));
        const rows = evidence.snapshot().filter(row => row.path.startsWith("/api/"))
          .map(({ path, callerFailure, failure, reason, nativeMatchCount, requestMatchCount }) =>
            ({ path, callerFailure, failure, reason, nativeMatchCount, requestMatchCount }));
        report.push({ mode, rows, nativeFailures });
      } finally { await context.close(); }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  const failures = report.flatMap(({ mode, rows }) => rows.filter(row =>
    row.nativeMatchCount !== 1 || row.requestMatchCount !== 1
    || (mode === "network" ? row.callerFailure !== false || row.reason !== null
      : row.callerFailure !== true || !["caller_abort_signal", "native_caller_abort_without_transport_terminal"].includes(row.reason)))
    .map(row => ({ mode, ...row })));
  assert.deepEqual(failures, [], `Polling lifecycle left unproved reads (${browser.browserType().name()}): ${JSON.stringify(report)}`);
  return report;
}
