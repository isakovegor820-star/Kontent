import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createE2eIngressBoundary } from "./e2e-ingress-boundary.mjs";
import { createE2eBrowserErrorCollector } from "./e2e-browser-error-collector.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { constants } from "node:fs";
import pg from "pg";
import IORedis from "ioredis";
import { chromium } from "playwright-core";

import { migrate } from "./migrate.mjs";

const databaseUrl = String(process.env.E2E_DATABASE_URL || "").trim();
const redisUrl = String(process.env.E2E_REDIS_URL || "").trim();
if (!databaseUrl || !redisUrl) throw new Error("E2E_DATABASE_URL and E2E_REDIS_URL are required");
const databaseTarget = new URL(databaseUrl);
const redisTarget = new URL(redisUrl);
if (!["localhost", "127.0.0.1"].includes(databaseTarget.hostname)
  || databaseTarget.pathname.slice(1) !== "aurora_e2e_real") {
  throw new Error("Trends hydration E2E requires disposable local database aurora_e2e_real");
}
if (!["localhost", "127.0.0.1"].includes(redisTarget.hostname) || redisTarget.pathname !== "/15") {
  throw new Error("Trends hydration E2E requires disposable local Redis database 15");
}

const port = Number(process.env.E2E_TRENDS_PORT || 43210);
const httpsPort = Number(process.env.E2E_TRENDS_HTTPS_PORT || 43211);
assert([port, httpsPort].every((value) => Number.isInteger(value) && value > 0 && value <= 65535)
  && port !== httpsPort, "hydration requires distinct valid HTTP runtime and HTTPS ingress ports");
const runtimeBaseUrl = `http://127.0.0.1:${port}`;
const baseUrl = `https://127.0.0.1:${httpsPort}`;
const ingressBoundary = createE2eIngressBoundary({ baseUrl });
let tlsDirectory; let tlsProxyServer;
const productEventResponses = new Map();
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const runtimeEnv = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  APP_URL: baseUrl,
  NEXT_PUBLIC_APP_URL: baseUrl,
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES: "1",
  AURORA_RUNTIME_ROLE: "web",
  AURORA_DB_POOL_MAX_WEB: "3",
  AURORA_SENTRY_DISABLED: "1",
  NEXT_PUBLIC_AURORA_SENTRY_DISABLED: "1",
  SENTRY_AUTH_TOKEN: "",
  TOKENS_MASTER_KEY: "trends-e2e-only-master-key-with-enough-entropy-2026",
  TOKENS_KEY_ID: "1",
};

function waitForExit(process) {
  return new Promise((resolve) => process.once("exit", resolve));
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${runtimeBaseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("production Next.js server did not become healthy");
}

function captureProductEventRequest(incoming) {
  if (incoming.method !== "POST" || incoming.url !== "/api/product-events") return null;
  const record = { complete: false, bodySha256: null, error: null };
  const chunks = []; let bytes = 0;
  incoming.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 65_536) chunks.push(Buffer.from(chunk)); else record.error = "request_too_large";
  });
  incoming.once("aborted", () => { record.error = "request_aborted"; });
  incoming.once("error", () => { record.error = "request_failed"; });
  incoming.once("end", () => {
    if (record.error || !incoming.complete) { record.error ??= "request_incomplete"; return; }
    record.bodySha256 = createHash("sha256").update(Buffer.concat(chunks)).digest("hex");
    record.complete = true;
  });
  return record;
}

function observeProductEventResponse(response, request) {
  if (!request || response.statusCode !== 200) return;
  const requestId = response.headers["x-request-id"];
  if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
  if (productEventResponses.has(requestId)) { productEventResponses.set(requestId, { error: "duplicate_response_id" }); return; }
  const record = { requestId, request, complete: false, body: null, error: null };
  productEventResponses.set(requestId, record);
  if (response.headers["content-type"]?.split(";")[0] !== "application/json") record.error = "response_not_json";
  const chunks = []; let bytes = 0;
  response.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes <= 65_536) chunks.push(Buffer.from(chunk)); else record.error = "response_too_large";
  });
  response.once("aborted", () => { record.error = "response_aborted"; });
  response.once("error", () => { record.error = "response_failed"; });
  response.once("end", () => {
    if (record.error || !response.complete) { record.error ??= "response_incomplete"; return; }
    try { record.body = JSON.parse(Buffer.concat(chunks).toString("utf8")); record.complete = true; }
    catch { record.error = "invalid_json"; }
  });
}

async function waitForProductEventReceipt(requestId) {
  assert.equal(typeof requestId, "string", "telemetry response must carry its original request ID");
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const record = productEventResponses.get(requestId);
    assert(!record?.error && !record?.request?.error, "original telemetry ingress stream failed");
    if (record?.complete && record.request?.complete) return record;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("original telemetry ingress receipt did not complete within 10 seconds");
}

async function startHttpsProxy() {
  tlsDirectory = await mkdtemp(join(tmpdir(), "aurora-hydration-tls-"));
  const keyPath = join(tlsDirectory, "key.pem");
  const certificatePath = join(tlsDirectory, "certificate.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "1",
    "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    "-keyout", keyPath, "-out", certificatePath], { stdio: "ignore" });
  tlsProxyServer = https.createServer({ key: await readFile(keyPath), cert: await readFile(certificatePath) }, (incoming, outgoing) => {
    const requestEvidence = captureProductEventRequest(incoming);
    const upstream = http.request({ hostname: "127.0.0.1", port, path: incoming.url, method: incoming.method,
      headers: { ...incoming.headers, "x-forwarded-proto": "https", "x-forwarded-host": new URL(baseUrl).host,
        "x-forwarded-for": incoming.socket.remoteAddress } }, (response) => {
      observeProductEventResponse(response, requestEvidence);
      if (!ingressBoundary.accept({ requestUrl: incoming.url, status: response.statusCode || 502, headers: response.headers })) {
        response.resume(); outgoing.writeHead(502, { "content-type": "text/plain" });
        outgoing.end("Redirect blocked by isolated TLS ingress"); return;
      }
      outgoing.writeHead(response.statusCode || 502, response.headers);
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableEnded) upstream.destroy(); });
    upstream.on("error", () => {
      if (!outgoing.headersSent) outgoing.writeHead(502, { "content-type": "text/plain" });
      outgoing.end("runtime unavailable");
    });
    incoming.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    tlsProxyServer.once("error", reject);
    tlsProxyServer.listen(httpsPort, "127.0.0.1", resolve);
  });
}

async function closeHttpsProxy() {
  try {
    if (tlsProxyServer?.listening) await new Promise((resolve, reject) => tlsProxyServer.close((error) => error ? reject(error) : resolve()));
  } finally {
    if (tlsDirectory) await rm(tlsDirectory, { recursive: true, force: true });
  }
}

async function browserExecutable() {
  const explicit = String(process.env.E2E_BROWSER_EXECUTABLE || "").trim();
  if (!explicit) return undefined; // Use the pinned Playwright headless-shell default.
  await access(explicit, constants.X_OK);
  return explicit;
}

let server;
let browser;
let transport; let context; let failure; let scopes; let productEventReceipt;
const hydrationIssues = [];
const browserErrors = createE2eBrowserErrorCollector({ baseUrl });
try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: runtimeEnv, logger: { log() {} } });
  await redis.flushdb();

  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: process.cwd(), env: runtimeEnv, stdio: "inherit",
  });
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(), env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth();
  await startHttpsProxy();

  browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() });
  const isolated = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true });
  context = isolated.context; transport = isolated.transport;
  browserErrors.observeContext(context);
  await context.addInitScript(() => {
    globalThis.__auroraSelectedTrendScopes = [];
    const capture = () => {
      const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
        .find((tab) => ["Моя ниша", "Интернет"].includes(tab.textContent?.trim() || ""));
      const label = selected?.textContent?.trim();
      if (label && globalThis.__auroraSelectedTrendScopes.at(-1) !== label) {
        globalThis.__auroraSelectedTrendScopes.push(label);
      }
    };
    new MutationObserver(capture).observe(document, { subtree: true, childList: true, attributes: true });
    document.addEventListener("DOMContentLoaded", capture);
  });
  const page = await context.newPage();
  browserErrors.attach(page);
  page.on("console", (message) => {
    if (["warning", "error"].includes(message.type()) && /hydrat|server rendered|client properties/iu.test(message.text())) {
      hydrationIssues.push(message.text());
    }
  });
  page.on("pageerror", (error) => hydrationIssues.push(error.message));

  // Provision a hash-only session in the disposable DB: this is a hydration check.
  // The browser still uses the real production HTTPS mutation/session contracts.
  const rawSession = "trends-hydration-e2e-session";
  const sessionHash = createHash("sha256").update(rawSession, "utf8").digest("hex");
  const userId = Number((await pool.query(
    `insert into users (email, name, onboarding_completed_at)
     values ('trends-hydration@example.test', 'Trends QA', now()) returning id`,
  )).rows[0]?.id);
  const projectId = Number((await pool.query(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     values ('Trends hydration', 'UTC', $1, $1) returning id`,
    [userId],
  )).rows[0]?.id);
  await pool.query(
    `insert into project_members (project_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
    [projectId, userId],
  );
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id) values ($1, $2)`,
    [userId, projectId],
  );
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at, device, credential_epoch)
     select $1, id, now() + interval '1 hour', 'trends-hydration-e2e', credential_epoch
       from users where id = $2`,
    [sessionHash, userId],
  );
  await context.addCookies([{
    name: "sid", value: rawSession, url: baseUrl, httpOnly: true, sameSite: "Lax", secure: true,
  }]);
  await pool.query(
    `insert into channels (user_id, project_id, network, tg_chat_id, title, handle, is_active, status)
     values ($1, $2, 'tg', -100900000301, 'Trends hydration',
             'trends_hydration', true, 'active')`,
    [userId, projectId],
  );

  // Product telemetry uses a keepalive beacon, so global network-idle is not a
  // meaningful readiness boundary. Hydration is ready when the route has loaded
  // and the selected tab from the direct URL is visible and committed in the DOM.
  const telemetryResponsePromise = page.waitForResponse((response) =>
    response.url() === `${baseUrl}/api/product-events` && response.request().method() === "POST",
  { timeout: 60_000 });
  // Keep the original rejecting promise for the awaited witness without an early unhandled rejection.
  void telemetryResponsePromise.catch(() => {});
  await page.goto("/app/trends?scope=internet", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const internetTab = page.getByRole("tab", { name: "Интернет", exact: true });
  await internetTab.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => Array.from(
    document.querySelectorAll('[role="tab"][aria-selected="true"]'),
  ).some((tab) => tab.textContent?.trim() === "Интернет"), undefined, { timeout: 60_000 });
  if (await internetTab.getAttribute("aria-selected") !== "true") {
    throw new Error("Internet tab was not selected after direct navigation");
  }
  scopes = await page.evaluate(() => globalThis.__auroraSelectedTrendScopes);
  if (scopes.includes("Моя ниша")) throw new Error(`scope changed niche → internet: ${JSON.stringify(scopes)}`);
  if (!scopes.includes("Интернет")) throw new Error(`Internet scope was never rendered: ${JSON.stringify(scopes)}`);
  if (new URL(page.url()).searchParams.get("scope") !== "internet") {
    throw new Error(`scope query was not preserved: ${page.url()}`);
  }
  const telemetryResponse = await telemetryResponsePromise;
  assert.equal(telemetryResponse.status(), 200, "hydration telemetry must reach the real production route");
  // Read the original bounded TLS stream: Chromium may discard keepalive CDP bodies.
  const ingressReceipt = await waitForProductEventReceipt(telemetryResponse.headers()["x-request-id"]);
  assert.equal(ingressReceipt.request.bodySha256, createHash("sha256").update(telemetryResponse.request().postData() ?? "").digest("hex"));
  const telemetryBody = ingressReceipt.body;
  assert.equal(telemetryBody.requestId, ingressReceipt.requestId);
  const events = telemetryResponse.request().postDataJSON()?.events;
  assert(Array.isArray(events) && events.length > 0);
  assert.equal(telemetryBody.ok, true);
  assert.equal(telemetryBody.accepted, events.length);
  assert.equal(telemetryBody.replayed, 0);
  const stored = (await pool.query(
    `select event_id::text, section_id, feature_id, action, stage, outcome
       from product_events where project_id = $1 and user_id = $2 and event_id = any($3::uuid[])
       order by event_id`, [projectId, userId, events.map((event) => event.eventId)],
  )).rows;
  assert.deepEqual(stored, events.map((event) => ({ event_id: event.eventId, section_id: event.sectionId,
    feature_id: event.featureId, action: event.action, stage: event.stage, outcome: event.outcome,
  })).sort((left, right) => left.event_id.localeCompare(right.event_id)));
  assert(stored.some((event) => event.action === "loaded" && event.stage === "completed" && event.outcome === "success"));
  productEventReceipt = { status: telemetryResponse.status(), accepted: telemetryBody.accepted,
    replayed: telemetryBody.replayed, persisted: stored.length, requestBodySha256: ingressReceipt.request.bodySha256 };
  if (hydrationIssues.length > 0) throw new Error(`hydration errors: ${JSON.stringify(hydrationIssues)}`);
} catch (error) { failure = error; throw error; }
finally {
  await finalizeE2eBrowserLifecycle({ context, transport, error: failure,
    cleanup: [
      async () => { if (browser) await browser.close(); },
      async () => {
        if (server && server.exitCode == null) {
          const exited = waitForExit(server);
          server.kill("SIGTERM");
          await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 5_000))]);
          if (server.exitCode == null) server.kill("SIGKILL");
        }
      },
      () => closeHttpsProxy(),
      () => redis.quit(),
      () => pool.end(),
      () => browserErrors.stop(),
    ],
    assertDiagnostics: () => { ingressBoundary.assertClean(); browserErrors.assertClean(); if (hydrationIssues.length > 0) throw new Error(`hydration errors after cleanup: ${JSON.stringify(hydrationIssues)}`); },
    writeEvidence: ({ error }) => {
      if (!error) console.log(`[trends:hydration] production direct-open passed; selected scopes=${JSON.stringify(scopes)}; HTTPS telemetry=${JSON.stringify(productEventReceipt)}`);
    } });
}
