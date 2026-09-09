import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";
import { E2E_RESERVED_BROWSER_HOST } from "./e2e-browser-origin.mjs";
import { createE2eIngressBoundary } from "./e2e-ingress-boundary.mjs";

/** Test the actual browser transport before it receives any application data.
 * Both destinations are disposable fixtures; the second must receive no bytes. */
export async function verifyNativeBrowserBoundary(browser) {
  const directory = await mkdtemp(join(tmpdir(), "aurora-browser-boundary-"));
  const results = [];
  try {
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
      "-subj", `/CN=${E2E_RESERVED_BROWSER_HOST}`, "-addext", `subjectAltName=IP:127.0.0.1,DNS:${E2E_RESERVED_BROWSER_HOST}`,
      "-keyout", join(directory, "key.pem"), "-out", join(directory, "cert.pem")], { stdio: "ignore" });
    const tls = { key: await readFile(join(directory, "key.pem")), cert: await readFile(join(directory, "cert.pem")) };
    for (const protocol of ["http:", "https:"]) {
      const sockets = new Set(); let foreignConnections = 0; let foreignRequests = 0;
      const create = handler => protocol === "http:" ? http.createServer(handler) : https.createServer(tls, handler);
      const track = server => server.on("connection", socket => {
        sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
      });
      const listen = server => new Promise((resolve, reject) => {
        server.once("error", reject); server.listen(0, "127.0.0.1", resolve);
      });
      const foreign = track(create((_request, response) => { foreignRequests++; response.end("synthetic denied destination"); }));
      foreign.on("connection", () => { foreignConnections++; });
      let own; let browserOrigin; let ingressBoundary;
      try {
        await listen(foreign); const foreignUrl = `${protocol}//127.0.0.1:${foreign.address().port}/`;
        own = track(create((request, response) => {
          if (request.url === "/redirect") {
            const headers = { location: foreignUrl };
            if (!ingressBoundary.accept({ requestUrl: request.url, status: 302, headers })) {
              response.destroy();
              return;
            }
            response.writeHead(302, headers); response.end();
          }
          else { response.setHeader("content-type", "text/html"); response.end("<!doctype html><title>Owned boundary</title>"); }
        }));
        await listen(own); const baseUrl = `${protocol}//127.0.0.1:${own.address().port}`;
        browserOrigin = `${protocol}//${E2E_RESERVED_BROWSER_HOST}:${own.address().port}`;
        ingressBoundary = createE2eIngressBoundary({ baseUrl: browserOrigin });
        for (const vector of ["direct", "redirect"]) {
          const row = { protocol, vector }; const beforeConnections = foreignConnections; const beforeRequests = foreignRequests;
          const beforeIngressDenials = ingressBoundary.snapshot().length;
          const { context, transport } = await createE2eBrowserContext(browser, { baseUrl, browserOrigin, ignoreHTTPSErrors: true });
          try {
            const boundary = await installE2eBrowserBoundary(context, { baseUrl: browserOrigin });
            const page = await context.newPage(); await page.goto(browserOrigin);
            const result = await page.evaluate(async target => {
              try { await fetch(target, { signal: AbortSignal.timeout(3_000) }); return "unexpected success"; }
              catch (error) { return error.name; }
            }, vector === "direct" ? foreignUrl : `${browserOrigin}/redirect`);
            row.foreignConnections = foreignConnections - beforeConnections;
            row.foreignRequests = foreignRequests - beforeRequests;
            row.denials = transport.snapshot().length + boundary.snapshot().length
              + ingressBoundary.snapshot().length - beforeIngressDenials;
            assert.equal(row.foreignConnections, 0, "browser bypassed its transport and connected to a denied destination");
            assert.equal(row.foreignRequests, 0); assert.notEqual(result, "unexpected success");
            assert(row.denials > 0, "denial must be retained by the actual boundary");
            assert.throws(() => { transport.assertClean(); boundary.assertClean(); ingressBoundary.assertClean(); });
            row.result = "PASS";
          } catch (error) { row.result = "FAIL"; row.error = String(error); }
          finally { await context.close(); await transport.stop(); results.push(row); }
        }
      } finally {
        for (const socket of sockets) socket.destroy();
        for (const server of [own, foreign]) if (server?.listening) await new Promise(resolve => server.close(resolve));
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert(results.length === 4 && results.every(row => row.result === "PASS"), `Native browser isolation failed: ${JSON.stringify(results)}`);
  return results;
}
