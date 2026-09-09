import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import ts from "typescript";
import { expect, it } from "vitest";
import { createE2eIngressBoundary } from "./e2e-ingress-boundary.mjs";

const source = await readFile(new URL("./test-trends-hydration-e2e.mjs", import.meta.url), "utf8");
const ast = ts.createSourceFile("hydration.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const named = (name) => ast.statements.find((node) => ts.isVariableStatement(node)
  && node.declarationList.declarations.some((declaration) => declaration.name.getText(ast) === name));
const functions = ast.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ["startHttpsProxy", "closeHttpsProxy", "captureProductEventRequest", "observeProductEventResponse", "waitForProductEventReceipt"].includes(node.name?.text)).map((node) => node.getText(ast)).join("\n");
function visit(node, predicate) {
  const found = []; const walk = (entry) => { if (predicate(entry)) found.push(entry); ts.forEachChild(entry, walk); }; walk(node); return found;
}

it("configures the production browser, APP_URL and session cookie for the same HTTPS origin", () => {
  const declarations = ["port", "httpsPort", "runtimeBaseUrl", "baseUrl"].map((name) => named(name)?.getText(ast)).filter(Boolean).join("\n");
  const state = vm.createContext({ process: { env: {} } });
  vm.runInContext(declarations + "; globalThis.result={baseUrl};", state);
  expect(new URL(state.result.baseUrl).protocol).toBe("https:");
  const env = named("runtimeEnv").declarationList.declarations.find((node) => node.name.getText(ast) === "runtimeEnv").initializer;
  const appUrl = env.properties.find((node) => node.name?.getText(ast) === "APP_URL");
  expect(appUrl.initializer.getText(ast)).toBe("baseUrl");
  const cookies = visit(ast, (node) => ts.isCallExpression(node) && node.expression.getText(ast) === "context.addCookies")[0];
  const cookie = vm.runInNewContext(cookies.arguments[0].getText(ast), { baseUrl: state.result.baseUrl, rawSession: "owned" })[0];
  expect(cookie.secure).toBe(true); expect(cookie.url).toBe(state.result.baseUrl);
});

async function listen(server) { await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); }); return server.address().port; }
function request(port, path, body = "owned-stream") {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname: "127.0.0.1", port, path, method: "POST", rejectUnauthorized: false,
      headers: { "content-type": "text/plain", "origin": `https://127.0.0.1:${port}` } }, (response) => {
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    }); req.on("error", reject); req.end(body);
  });
}
it("the actual hydration TLS ingress streams its own request and blocks foreign redirect responses", async () => {
  const received = [];
  const upstream = http.createServer((incoming, outgoing) => {
    const chunks = []; incoming.on("data", (chunk) => chunks.push(chunk)); incoming.on("end", () => {
      received.push({ url: incoming.url, headers: incoming.headers, body: Buffer.concat(chunks).toString() });
      if (incoming.url === "/foreign") { outgoing.writeHead(302, { location: "https://unowned.invalid/private?secret=canary" }); outgoing.end(); return; }
      outgoing.writeHead(200, { "content-type": "text/plain" }); outgoing.write("first:"); outgoing.end(Buffer.concat(chunks));
    });
  });
  const port = await listen(upstream);
  const state = vm.createContext({ assert, http, https, mkdtemp, readFile, rm, join, tmpdir, execFileSync, URL, Buffer, createHash, productEventResponses: new Map(), port,
    httpsPort: 0, baseUrl: "https://127.0.0.1:1", ingressBoundary: createE2eIngressBoundary({ baseUrl: "https://127.0.0.1:1" }),
    tlsDirectory: undefined, tlsProxyServer: undefined });
  vm.runInContext(functions + "; globalThis.start=startHttpsProxy; globalThis.close=closeHttpsProxy;", state);
  let directory;
  try {
    await state.start(); directory = state.tlsDirectory;
    const actualPort = state.tlsProxyServer.address().port;
    state.baseUrl = `https://127.0.0.1:${actualPort}`;
    state.ingressBoundary = createE2eIngressBoundary({ baseUrl: state.baseUrl });
    const response = await request(actualPort, "/api/product-events");
    expect(response).toMatchObject({ status: 200, body: "first:owned-stream" });
    expect(received[0]).toMatchObject({ url: "/api/product-events", body: "owned-stream",
      headers: { origin: state.baseUrl, "x-forwarded-proto": "https", "x-forwarded-host": new URL(state.baseUrl).host } });
    state.ingressBoundary.assertClean();
    const blocked = await request(actualPort, "/foreign"); expect(blocked.status).toBe(502);
    expect(blocked.body).not.toContain("canary"); expect(blocked.headers.location).toBeUndefined();
    expect(() => state.ingressBoundary.assertClean()).toThrow("off-origin redirect");
    expect(state.ingressBoundary.snapshot()).toEqual([{ id: 1, kind: "external_redirect", status: 302 }]);
  } finally {
    await state.close(); await state.close();
    await new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
  }
  await expect(access(directory)).rejects.toMatchObject({ code: "ENOENT" });
});

function receiptFixture() {
  let now = 0;
  const state = vm.createContext({ assert, Buffer, createHash, productEventResponses: new Map(),
    Date: { now: () => now }, setTimeout: (callback) => { now += 1000; queueMicrotask(callback); } });
  vm.runInContext(functions + "; globalThis.capture=captureProductEventRequest; globalThis.observe=observeProductEventResponse; globalThis.wait=waitForProductEventReceipt;", state);
  const incoming = new EventEmitter(); incoming.method = "POST"; incoming.url = "/api/product-events"; incoming.complete = true;
  const request = state.capture(incoming);
  const response = new EventEmitter(); response.statusCode = 200; response.complete = true;
  response.headers = { "x-request-id": "owned-response-id", "content-type": "application/json" };
  state.observe(response, request);
  return { state, incoming, response, request, elapsed: () => now };
}
it("retains complete original request and response bytes without asking CDP to retrieve a keepalive body", async () => {
  const f = receiptFixture(); const input = '{"events":[{"eventId":"owned"}]}';
  f.incoming.emit("data", Buffer.from(input)); f.incoming.emit("end");
  f.response.emit("data", Buffer.from('{"ok":true,"accepted":1,'));
  f.response.emit("data", Buffer.from('"requestId":"owned-response-id"}')); f.response.emit("end");
  const record = await f.state.wait("owned-response-id");
  expect(record.request.bodySha256).toBe(createHash("sha256").update(input).digest("hex"));
  expect(record.body).toEqual({ ok: true, accepted: 1, requestId: "owned-response-id" });
  expect(record.complete).toBe(true); expect(f.elapsed()).toBe(0);
});
it.each(["aborted", "incomplete", "oversized", "invalid_json", "duplicate_id", "request_aborted", "request_oversized"])("rejects original telemetry %s evidence instead of issuing a success receipt", async (fault) => {
  const f = receiptFixture();
  f.incoming.emit("data", Buffer.from(fault === "request_oversized" ? "x".repeat(65_537) : "owned"));
  if (fault === "request_aborted") f.incoming.emit("aborted");
  f.incoming.emit("end");
  if (fault === "duplicate_id") f.state.observe(f.response, f.request);
  if (fault === "aborted") f.response.emit("aborted");
  if (fault === "incomplete") f.response.complete = false;
  f.response.emit("data", Buffer.from(fault === "oversized" ? "x".repeat(65_537) : fault === "invalid_json" ? "{" : '{"ok":true}'));
  f.response.emit("end");
  await expect(f.state.wait("owned-response-id")).rejects.toThrow("ingress stream failed");
});
it("bounds missing or unfinished receipt retrieval instead of waiting indefinitely", async () => {
  const f = receiptFixture();
  await expect(f.state.wait("owned-response-id")).rejects.toThrow("within 10 seconds");
  expect(f.elapsed()).toBe(10_000);
});
