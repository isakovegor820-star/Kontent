import assert from "node:assert/strict";
import http from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import ts from "typescript";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";

const source = ts.transpileModule(readFileSync(new URL("../src/lib/project-fetch.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText.replace(/^export /gm, "");

export async function verifyNativeExportReads(browser) {
  let mode; let mime; let body; const sockets = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== "/api/project-exports/3/download") {
      response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Owned export fixture</title>"); return;
    }
    response.writeHead(200, { "content-type": mime, "content-length": String(body.length) });
    if (mode === "reset") {
      response.write(body.subarray(0, 10));
      const timer = setTimeout(() => response.destroy(), 20); response.once("close", () => clearTimeout(timer));
    } else response.end(body);
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`; const results = [];
  try {
    for (const [kind, contentType] of [
      ["pdf", "application/pdf"], ["csv", "text/csv"],
      ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
      ["reset", "application/pdf"], ["overflow", "application/pdf"],
    ]) {
      mode = kind; mime = contentType; body = Buffer.alloc(kind === "overflow" ? 65_537 : 14_612, 120);
      const { context, transport } = await createE2eBrowserContext(browser, { baseUrl });
      const evidence = createMainRequestEvidence({ baseUrl });
      try {
        await evidence.install(context); const page = await context.newPage();
        page.on("request", request => evidence.observeRequest(request, "native-export", page));
        page.on("response", response => evidence.observeResponse(response));
        page.on("requestfinished", request => evidence.observeFinished(request));
        page.on("requestfailed", request => evidence.observeFailure(request));
        await page.goto(baseUrl);
        await page.addScriptTag({ content: source + ";window.fixtureProjectFetch=projectFetch;setClientProjectId(1);" });
        const outcome = await page.evaluate(async () => {
          try { const response = await window.fixtureProjectFetch("/api/project-exports/3/download");
            const blob = await response.blob(); return { bytes: blob.size }; }
          catch (error) { return { error: error.name }; }
        });
        await evidence.flushExportDownloads(page);
        const rows = evidence.snapshot().filter(row => row.path === "/api/project-exports/3/download");
        assert.equal(rows.length, 1); const row = rows[0];
        if (kind === "reset") {
          assert.equal(outcome.error, "TypeError"); assert.equal(row.exportBody ?? null, null); assert.equal(row.reason, null);
        } else if (kind === "overflow") {
          assert.equal(outcome.bytes, body.length); assert.equal(row.exportBody?.sha256 ?? null, null); assert.equal(row.reason, null);
        } else {
          assert.equal(outcome.bytes, body.length);
          assert.equal(row.exportBody?.bytes, body.length, "actual projectFetch reader completion was not observed");
          assert.equal(row.exportBody?.sha256, createHash("sha256").update(body).digest("hex"));
          assert.equal(row.exportBody?.count, 1); assert.equal(row.bodyCompletion.eofCount, 1);
          assert.equal(row.bodyCompletion.fulfilledClosedCount, 1);
        }
        results.push({ kind, result: "PASS", bytes: outcome.bytes ?? null, failure: row.failure, reason: row.reason });
      } finally { await context.close(); await transport.stop(); transport.assertClean(); }
    }
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  return results;
}
