import assert from "node:assert/strict";
import http from "node:http";
import { createAuthCoverageDiagnostics } from "./e2e-auth-coverage.mjs";

// Exercise the actual installed Firefox/Playwright identity bridge in CI. A
// future private-API change must fail this probe, not silently widen admission.
export async function verifyNativeFirefoxFaviconEvidence(browser) {
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    const path = new URL(request.url, "http://localhost").pathname;
    if (path === "/icon.svg") {
      response.setHeader("content-type", "image/svg+xml");
      const timer = setTimeout(() => response.end('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>'), 500);
      response.once("close", () => clearTimeout(timer));
    } else {
      response.setHeader("content-type", "text/html");
      response.end('<!doctype html><link rel="icon" href="/icon.svg"><h1>Native icon fixture</h1>');
    }
  });
  server.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const report = [];
  try {
    for (const ordinaryImage of [false, true]) {
      const context = await browser.newContext();
      const diagnostics = createAuthCoverageDiagnostics({ context, baseUrl, engine: "firefox" });
      await diagnostics.install();
      try {
        const page = await context.newPage();
        for (let step = 0; step < 4; step++) {
          const icon = page.waitForRequest(request => request.url() === `${baseUrl}/icon.svg`);
          await page.goto(`${baseUrl}/page-${step}`);
          await icon;
          if (ordinaryImage && step === 1) {
            const image = page.waitForRequest(request => request.url() === `${baseUrl}/icon.svg?ordinary=1`);
            await page.evaluate(() => {
              const image = document.createElement("img");
              image.src = "/icon.svg?ordinary=1"; document.body.append(image);
            });
            await image;
            await page.evaluate(() => window.stop());
          }
        }
        await new Promise(resolve => setTimeout(resolve, 550));
        await diagnostics.flush(); await context.close();
        const snapshot = diagnostics.snapshot();
        assert.deepEqual(snapshot.browserErrors.unexpected, []);
        assert.deepEqual(snapshot.unmatchedReadFailures, []);
        const certified = snapshot.readFailures.filter(row => row.reason === "browser_cancelled_favicon");
        assert(certified.length >= 2, "fixture must actually cancel native favicon requests");
        assert(certified.every(row => row.failure === "NS_BINDING_ABORTED" && row.finishedAt === null));
        if (ordinaryImage) {
          assert(snapshot.readFailures.some(row => row.resourceType === "image" && row.reason === null), "ordinary image cancellation must stay unexplained");
          assert.throws(() => diagnostics.assertClean(), /auth has unproved request failures/u);
        } else diagnostics.assertClean();
        report.push({ ordinaryImage, certified: certified.length, unproved: snapshot.readFailures.filter(row => !row.reason).length });
      } finally { diagnostics.stop(); await context.close(); }
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  }
  return report;
}
