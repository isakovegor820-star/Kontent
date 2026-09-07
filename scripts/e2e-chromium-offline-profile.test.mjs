import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants } from "node:fs";
import http from "node:http";
import https from "node:https";
import tls from "node:tls";
import ts from "typescript";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createE2eBrowserProxy } from "./e2e-browser-proxy.mjs";
import { createE2eChromiumOfflineProfile, resolveE2eBrowserServiceFixture } from "./e2e-chromium-offline-profile.mjs";

let certificateDir;
let certificate;
const cleanup = [];
beforeAll(async () => {
  certificateDir = await mkdtemp(join(tmpdir(), "aurora-e2e-service-cert-test-"));
  await promisify(execFile)("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", join(certificateDir, "key.pem"), "-out", join(certificateDir, "cert.pem"), "-subj", "/CN=localhost"], { timeout: 10_000 });
  certificate = { key: await readFile(join(certificateDir, "key.pem")), cert: await readFile(join(certificateDir, "cert.pem")) };
});
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); });
afterAll(async () => { if (certificateDir) await rm(certificateDir, { recursive: true, force: true }); });

async function profile(baseUrl = "https://127.0.0.1:12345") {
  const value = await createE2eChromiumOfflineProfile({ baseUrl, tls: certificate, zoom: 2 });
  cleanup.push(value.stop);
  return value;
}

function connect(proxy, authority) {
  return new Promise((resolve, reject) => {
    const address = new URL(proxy.proxyOptions.server);
    const request = http.request({ hostname: address.hostname, port: address.port, method: "CONNECT", path: authority });
    request.on("connect", (response, socket) => resolve({ response, socket }));
    request.on("error", reject);
    request.end();
  });
}

it.each(["https://127.0.0.1:12345", "http://localhost:12345", "https://[::1]:12345"])("brands a distinct owned sink and preserves actual native zoom preferences for %s", async baseUrl => {
  const value = await profile(baseUrl);
  const target = resolveE2eBrowserServiceFixture(value.serviceFixture, baseUrl);
  expect(target.host).toBe("127.0.0.1");
  expect(new URL(target.origin).hostname).not.toBe(new URL(baseUrl).hostname);
  const preferences = JSON.parse(await readFile(join(value.profilePath, "Default", "Preferences"), "utf8"));
  expect(Math.pow(1.2, preferences.partition.default_zoom_level.x)).toBeCloseTo(2);
  expect(value.launchArgs.some(arg => /disable-features|disable-web-security|ignore-certificate-errors=/u.test(arg))).toBe(false);
  expect(value.launchArgs.filter(arg => arg.startsWith("--ignore-certificate-errors-spki-list="))).toHaveLength(1);
  for (const arg of value.launchArgs.filter(arg => arg.includes("-url="))) expect(new URL(arg.split("=")[1]).origin).toBe(target.origin);
  expect(() => resolveE2eBrowserServiceFixture({ ...value.serviceFixture }, baseUrl)).toThrow("active owned");
  expect(() => resolveE2eBrowserServiceFixture(value.serviceFixture, baseUrl.replace(":12345", ":12346"))).toThrow("another application");
  await value.stop();
  expect(() => resolveE2eBrowserServiceFixture(value.serviceFixture, baseUrl)).toThrow("active owned");
  await expect(access(value.profilePath)).rejects.toMatchObject({ code: "ENOENT" });
});

it("always returns 403 without retaining or reflecting browser credentials, paths, query or body", async () => {
  const value = await profile();
  const target = resolveE2eBrowserServiceFixture(value.serviceFixture, "https://127.0.0.1:12345");
  const response = await new Promise((resolve, reject) => {
    const request = https.request({ hostname: target.host, port: target.port, servername: new URL(target.origin).hostname,
      rejectUnauthorized: false, method: "POST", path: "/private-canary?token=query-canary",
      headers: { authorization: "Bearer header-canary", cookie: "cookie-canary" } }, response => {
      const chunks = []; response.on("data", chunk => chunks.push(chunk)); response.on("error", reject);
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString() }));
    });
    request.on("error", reject); request.end("body-canary");
  });
  expect(response.status).toBe(403); expect(response.headers.location).toBeUndefined();
  expect(response.body).toBe("Owned browser service disabled");
  expect(value.snapshot().requests).toEqual([{ id: 1, kind: "owned_browser_service", status: 403 }]);
  expect(JSON.stringify(value.snapshot())).not.toMatch(/canary|authorization|cookie|token|PRIVATE KEY/u);
  const snapshot = value.snapshot(); snapshot.requests.length = 0;
  expect(value.snapshot().requests).toHaveLength(1);
});

it.each(["http:", "https:"])("proxy admits only the branded HTTPS 403 sink beside a %s application and rejects stopped ports", async protocol => {
  const baseUrl = `${protocol}//127.0.0.1:12345`;
  const value = await profile(baseUrl);
  const proxy = await createE2eBrowserProxy({ baseUrl, serviceFixture: value.serviceFixture }); cleanup.push(proxy.stop);
  const authority = new URL(value.serviceFixture.origin).host;
  const tunnel = await connect(proxy, authority); expect(tunnel.response.statusCode).toBe(200);
  const body = await new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: tunnel.socket, servername: "localhost", rejectUnauthorized: false });
    const chunks = [];
    secure.on("secureConnect", () => secure.write("GET /owned HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
    secure.on("data", bytes => chunks.push(bytes)); secure.on("error", reject);
    secure.on("end", () => resolve(Buffer.concat(chunks).toString()));
  });
  expect(body).toContain("403 Forbidden"); expect(value.snapshot().requests).toHaveLength(1); proxy.assertClean();
  for (const forbidden of ["www.google.com:443", authority.replace("localhost", "127.0.0.1"), `user:canary@${authority}`]) {
    const denied = await connect(proxy, forbidden); expect(denied.response.statusCode).toBe(403); denied.socket.destroy();
  }
  expect(proxy.snapshot()).toHaveLength(3); expect(() => proxy.assertClean()).toThrow("unexpected external request");
  await value.stop();
  const stopped = await connect(proxy, authority); expect(stopped.response.statusCode).toBe(403); stopped.socket.destroy();
  expect(proxy.snapshot()).toHaveLength(4);
});

it.each(["https://provider.invalid", "https://user:canary@localhost:12345", "https://127.0.0.1:12345/app"])("rejects unsafe application origins before creating a profile: %s", async baseUrl => {
  await expect(createE2eChromiumOfflineProfile({ baseUrl, tls: certificate })).rejects.toThrow("explicit loopback");
});

// Extract just the real selector; importing this destructive integration runner would start its DB setup.
async function hydrationExecutable(explicit) {
  const source = await readFile(new URL("./test-trends-hydration-e2e.mjs", import.meta.url), "utf8");
  const ast = ts.createSourceFile("test-trends-hydration-e2e.mjs", source, ts.ScriptTarget.Latest, true);
  const selector = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "browserExecutable");
  expect(selector, "hydration must retain a separately executable browser selector").toBeDefined();
  return new Function("process", "access", "constants", "chromium", `${selector.getText(ast)}; return browserExecutable();`)(
    { env: { E2E_BROWSER_EXECUTABLE: explicit } }, access, constants, { executablePath: () => process.execPath });
}

it("hydration leaves an empty executable unset for the official Playwright default", async () => {
  expect(await hydrationExecutable("  ")).toBeUndefined();
});

it("hydration honors a valid explicit executable instead of substituting its default", async () => {
  expect(await hydrationExecutable(`  ${process.execPath}  `)).toBe(process.execPath);
});

it("hydration fails an invalid explicit executable without a bundled-browser fallback", async () => {
  await expect(hydrationExecutable(join(certificateDir, "owned-missing-browser"))).rejects.toMatchObject({ code: "ENOENT" });
});
