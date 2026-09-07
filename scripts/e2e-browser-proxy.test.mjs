import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createE2eBrowserProxy } from "./e2e-browser-proxy.mjs";

const cleanup = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.unstubAllEnvs(); });
async function listen(server) {
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  return `http://127.0.0.1:${server.address().port}`;
}
async function proxy(options) {
  const result = await createE2eBrowserProxy(options); cleanup.push(result.stop); return result;
}
function request(proxyUrl, destination, { method = "GET", headers = {}, body = "" } = {}) {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: url.hostname, port: url.port, method, path: destination, headers }, res => {
      const chunks = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
      res.on("error", reject);
    });
    req.on("error", reject); req.end(body);
  });
}
function connect(proxyUrl, authority, payload = null) {
  const url = new URL(proxyUrl);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port) });
    let buffered = Buffer.alloc(0); let sent = false;
    socket.on("error", reject);
    socket.once("connect", () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
    socket.on("data", data => {
      buffered = Buffer.concat([buffered, data]);
      const end = buffered.indexOf("\r\n\r\n"); if (end === -1) return;
      if (!buffered.toString().startsWith("HTTP/1.1 200") || !payload) { socket.destroy(); resolve(buffered.toString()); return; }
      if (!sent) { sent = true; socket.write(payload); }
      if (buffered.subarray(end + 4).equals(payload)) { socket.destroy(); resolve(buffered); }
    });
  });
}

describe("isolated browser transport proxy", () => {
  it.each([
    { kind: "aurora-owned-chromium-service-fixture", origin: "https://www.google.com" },
    { kind: "aurora-owned-chromium-service-fixture", origin: "https://localhost:12346" },
  ])("does not admit a caller-forged browser-service fixture", async serviceFixture => {
    await expect(createE2eBrowserProxy({ baseUrl: "https://127.0.0.1:12345", serviceFixture }))
      .rejects.toThrow("active owned Chromium service fixture required");
  });
  it("survives actual peer resets while retaining CONNECT, upgrade and malformed denials", async () => {
    // Keep uncaught socket errors in a separate process: the defective helper must exit nonzero.
    const script = `
      import net from 'node:net';
      import { createE2eBrowserProxy } from ${JSON.stringify(new URL("./e2e-browser-proxy.mjs", import.meta.url).href)};
      const guard = await createE2eBrowserProxy({baseUrl:'https://127.0.0.1:12345'});
      const url = new URL(guard.proxyOptions.server);
      const requests = ['CONNECT t.me:443 HTTP/1.1\\r\\nHost: t.me:443\\r\\n\\r\\n',
        'GET / HTTP/1.1\\r\\nHost: fixture\\r\\nConnection: Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\n',
        'INVALID\\r\\n\\r\\n'];
      for (const request of requests) for (let index = 0; index < 20; index++) {
        await new Promise(resolve => {
          const socket = net.connect({host:url.hostname,port:Number(url.port)});
          socket.on('error',()=>{}); socket.on('close',resolve);
          socket.once('connect',()=>{socket.write(request);setImmediate(()=>socket.resetAndDestroy())});
        });
      }
      await new Promise(resolve=>setTimeout(resolve,20));
      const denied=guard.snapshot(); await guard.stop();
      console.log(JSON.stringify({completed:60,transports:[...new Set(denied.map(row=>row.transport))]}));
    `;
    const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 10_000 });
    const report = JSON.parse(result.stdout);
    expect(report.completed).toBe(60);
    expect(report.transports.sort()).toEqual(["connect", "malformed", "upgrade"]);
  });
  it("fails before listening if Chromium loopback proxying was disabled", async () => {
    vi.stubEnv("PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK", "1");
    await expect(createE2eBrowserProxy({ baseUrl: "http://127.0.0.1:12345" })).rejects.toThrow("loopback proxying must remain enabled");
  });
  it.each(["https://provider.invalid", "file:///tmp/fixture", "https://user:canary@localhost:8443", "ftp://127.0.0.1", "http://127.0.0.1.evil.invalid"])("rejects unsafe base before listening: %s", async baseUrl => {
    await expect(createE2eBrowserProxy({ baseUrl })).rejects.toThrow("explicit loopback");
  });

  it("preserves the allowed request body, response and Location while stripping proxy credentials", async () => {
    const observed = [];
    const baseUrl = await listen(http.createServer((req, res) => {
      let body = ""; req.on("data", chunk => { body += chunk; });
      req.on("end", () => {
        observed.push({ method: req.method, path: req.url, headers: req.headers, body });
        res.writeHead(307, { location: "/next", "x-fixture": "preserved" }); res.end("redirect body");
      });
    }));
    const guard = await proxy({ baseUrl });
    const result = await request(guard.proxyOptions.server, `${baseUrl}/start?case=1`, { method: "POST", body: "exact-body",
      headers: { host: "must-not-reach-upstream.invalid", cookie: "fixture=1", authorization: "synthetic", "proxy-authorization": "must-not-leak", "x-fixture": "preserved" } });
    expect(result).toMatchObject({ status: 307, body: "redirect body", headers: { location: "/next", "x-fixture": "preserved" } });
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ method: "POST", path: "/start?case=1", body: "exact-body",
      headers: { host: new URL(baseUrl).host, cookie: "fixture=1", authorization: "synthetic", "x-fixture": "preserved" } });
    expect(observed[0].headers["proxy-authorization"]).toBeUndefined(); guard.assertClean();
  });

  it("denies a foreign actual listener, userinfo, aliases and malformed destinations before connection", async () => {
    const effect = vi.fn((_req, res) => res.end("must not happen"));
    const foreign = await listen(http.createServer(effect));
    const baseUrl = await listen(http.createServer((_req, res) => res.end("allowed")));
    const callback = vi.fn(() => { throw new Error("diagnostic consumer failed"); });
    const guard = await proxy({ baseUrl, onBlocked: callback });
    for (const target of [foreign + "/canary?token=canary", baseUrl.replace("127.0.0.1", "localhost"), baseUrl.replace("http://", "http://user:canary@"), "https://provider.invalid/canary"]) {
      expect((await request(guard.proxyOptions.server, target)).status).toBe(403);
    }
    // Invalid HTTP request-target syntax is rejected by Node before the URL handler.
    expect((await request(guard.proxyOptions.server, "invalid-target")).status).toBe(400);
    expect(effect).not.toHaveBeenCalled(); expect(callback).toHaveBeenCalledTimes(5);
    expect(() => guard.assertClean()).toThrow("unexpected external request");
    const snapshot = guard.snapshot(); expect(snapshot).toHaveLength(5);
    expect(JSON.stringify(snapshot)).not.toMatch(/canary|provider|token|localhost|127\.0\.0\.1/u);
    snapshot.length = 0; expect(guard.snapshot()).toHaveLength(5);
  });

  it.each(["http:", "https:"])("tunnels opaque bytes only to the exact %s authority and denies foreign CONNECT before effect", async protocol => {
    let foreignConnections = 0;
    const foreign = await listen(net.createServer(socket => { foreignConnections++; socket.end(); }));
    const own = await listen(net.createServer(socket => socket.on("data", bytes => socket.write(bytes))));
    const baseUrl = own.replace("http:", protocol); const guard = await proxy({ baseUrl });
    const bytes = Buffer.from([0, 1, 255, 13, 10, 128]);
    const response = await connect(guard.proxyOptions.server, new URL(baseUrl).host, bytes);
    assert(Buffer.isBuffer(response)); expect(response.subarray(response.indexOf("\r\n\r\n") + 4)).toEqual(bytes);
    guard.assertClean();
    const denied = await connect(guard.proxyOptions.server, new URL(foreign).host);
    expect(denied).toContain("403 Forbidden"); expect(foreignConnections).toBe(0);
    expect(guard.snapshot()).toMatchObject([{ method: "CONNECT", transport: "connect" }]);
    expect(() => guard.assertClean()).toThrow("unexpected external request");
  });

  it("owns one context and stops its listener when the context closes", async () => {
    const guard = await proxy({ baseUrl: "http://127.0.0.1:12345" });
    const context = new EventEmitter(); guard.attach(context); guard.attach(context);
    expect(() => guard.attach(new EventEmitter())).toThrow("one context");
    context.emit("close"); await guard.stop(); await guard.stop();
    await expect(request(guard.proxyOptions.server, "http://127.0.0.1:12345/")).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("allows only one explicitly scoped expected denial, and never a connection upstream", async () => {
    const effect = vi.fn(socket => socket.end());
    const foreign = await listen(net.createServer(effect));
    const origin = foreign.replace("http:", "https:");
    const guard = await proxy({ baseUrl: "https://127.0.0.1:12345" });
    await guard.withExpectedDeniedConnect({ origin }, async () => {
      expect(await connect(guard.proxyOptions.server, new URL(origin).host)).toContain("403 Forbidden");
      guard.assertClean(); expect(effect).not.toHaveBeenCalled();
    });
    expect(guard.expectedDeniedSnapshot()).toMatchObject([{ kind: "expected_denied_fixture_connect" }]);
    const copy = guard.expectedDeniedSnapshot(); copy.length = 0; expect(guard.expectedDeniedSnapshot()).toHaveLength(1);
    expect(await connect(guard.proxyOptions.server, new URL(origin).host)).toContain("403 Forbidden");
    expect(() => guard.assertClean()).toThrow("unexpected external request");
    expect(effect).not.toHaveBeenCalled();
  });

  it.each(["http://t.me", "https://t.me/path", "https://user:canary@t.me", "https://t.me?token=canary", "https://127.0.0.1:12345"])("rejects invalid fixture scope %s", async origin => {
    const guard = await proxy({ baseUrl: "https://127.0.0.1:12345" });
    await expect(guard.withExpectedDeniedConnect({ origin }, async () => {})).rejects.toThrow("exact external HTTPS");
    expect(guard.expectedDeniedSnapshot()).toEqual([]);
  });

  it("rejects overlap, a second CONNECT, a mismatched authority and requests after action rejection", async () => {
    const guard = await proxy({ baseUrl: "https://127.0.0.1:12345" });
    await expect(guard.withExpectedDeniedConnect({ origin: "https://t.me" }, async () => {
      await expect(guard.withExpectedDeniedConnect({ origin: "https://other.invalid" }, async () => {})).rejects.toThrow("cannot overlap");
      expect(await connect(guard.proxyOptions.server, "t.me:443")).toContain("403 Forbidden");
      expect(await connect(guard.proxyOptions.server, "t.me:443")).toContain("403 Forbidden");
      expect(await connect(guard.proxyOptions.server, "t.me:444")).toContain("403 Forbidden");
      throw new Error("fixture action rejected");
    })).rejects.toThrow("fixture action rejected");
    expect(await connect(guard.proxyOptions.server, "t.me:443")).toContain("403 Forbidden");
    expect(guard.expectedDeniedSnapshot()).toHaveLength(1);
    expect(guard.snapshot()).toHaveLength(3);
    expect(() => guard.assertClean()).toThrow("unexpected external request");
  });
});
