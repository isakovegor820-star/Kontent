import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { resolveE2eBrowserServiceFixture } from "./e2e-chromium-offline-profile.mjs";
import { resolveOwnedE2eBrowserOrigins } from "./e2e-browser-origin.mjs";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "proxy-connection", "te", "trailer", "transfer-encoding", "upgrade"];

function transportHeaders(headers) {
  const result = { ...headers };
  for (const name of String(headers.connection || "").split(",")) delete result[name.trim().toLowerCase()];
  for (const name of HOP_HEADERS) delete result[name];
  return result;
}

/** A transport boundary also sees redirects and requests bypassing Playwright routes. */
export async function createE2eBrowserProxy({ baseUrl, browserOrigin = baseUrl, serviceFixture, onBlocked = () => {} }) {
  assert(!process.env.PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK,
    "Chromium loopback proxying must remain enabled");
  const { base, browser: browserBase } = resolveOwnedE2eBrowserOrigins(baseUrl, browserOrigin);
  const targetHost = base.hostname === "[::1]" ? "::1" : "127.0.0.1";
  const targetPort = Number(base.port || (base.protocol === "https:" ? 443 : 80));
  const serviceTarget = serviceFixture ? resolveE2eBrowserServiceFixture(serviceFixture, baseUrl) : null;
  const blocked = [];
  const expectedDenied = [];
  const sockets = new Set();
  const agent = new http.Agent({ keepAlive: true });
  let attachedContext;
  let stopping;
  let expectedConnect;
  const track = (socket) => {
    if (sockets.has(socket)) return socket;
    sockets.add(socket);
    // A peer may reset even a denied CONNECT before its response is written.
    // Retain the denial and close only this owned socket; do not crash the runner.
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const recordBlocked = (request, protocol, transport) => {
    // Never put destinations, headers, body, path or query credentials in evidence.
    const record = { id: blocked.length + 1, kind: "external_request", method: request.method,
      protocol, transport };
    blocked.push(record);
    // A diagnostics consumer must not interrupt denial or crash the proxy server.
    try { onBlocked({ ...record }); } catch { /* assertClean still fails on the retained record. */ }
  };
  const destination = (raw, connect = false) => {
    try {
      // Playwright APIRequestContext tunnels HTTP as well as HTTPS through CONNECT.
      let url = new URL(connect ? `${base.protocol}//${raw}` : raw);
      if (connect && serviceTarget) {
        const serviceUrl = new URL(`https://${raw}`);
        if (serviceUrl.origin === serviceTarget.origin) url = serviceUrl;
      }
      if (url.username || url.password) return null;
      if (url.origin === serviceTarget?.origin) {
        // Recheck liveness so a stopped fixture's port can never admit another service.
        resolveE2eBrowserServiceFixture(serviceFixture, baseUrl);
      } else if (url.origin !== browserBase.origin) return null;
      if (connect && (url.pathname !== "/" || url.search || url.hash)) return null;
      if (!connect && url.protocol !== "http:") return null;
      return url;
    } catch { return null; }
  };
  const server = http.createServer((incoming, outgoing) => {
    const url = destination(incoming.url);
    if (!url) {
      recordBlocked(incoming, "http:", "http");
      outgoing.writeHead(403, { "content-type": "text/plain", "connection": "close" });
      outgoing.end("Blocked by isolated browser boundary");
      return;
    }
    const upstream = http.request({ host: targetHost, port: targetPort, agent,
      method: incoming.method, path: `${url.pathname}${url.search}`,
      headers: { ...transportHeaders(incoming.headers), host: base.host } }, (response) => {
      const status = response.statusCode || 502;
      const locations = [];
      for (let index = 0; index < response.rawHeaders.length; index += 2) {
        if (response.rawHeaders[index].toLowerCase() === "location") locations.push(response.rawHeaders[index + 1]);
      }
      if (status >= 300 && status < 400 && locations.length) {
        let redirect;
        try { if (locations.length === 1) redirect = new URL(locations[0], url); } catch { /* Invalid redirects are denied. */ }
        if (!redirect || redirect.origin !== browserBase.origin || redirect.username || redirect.password) {
          recordBlocked(incoming, redirect?.protocol ?? "invalid", "redirect");
          response.destroy();
          outgoing.destroy();
          return;
        }
      }
      outgoing.writeHead(status, transportHeaders(response.headers));
      response.on("error", () => outgoing.destroy());
      response.pipe(outgoing);
    });
    upstream.on("socket", track);
    // A missing/reset owned upstream is a transport failure. Converting it to
    // an HTTP success path can make browser code treat a denied redirect as a
    // completed fetch, so preserve the native failure by closing the response.
    upstream.on("error", () => outgoing.destroy());
    incoming.on("aborted", () => upstream.destroy());
    outgoing.on("close", () => { if (!outgoing.writableEnded) upstream.destroy(); });
    incoming.pipe(upstream);
  });
  server.on("connection", track);
  server.on("connect", (request, socket, head) => {
    if (!destination(request.url, true)) {
      let requestedOrigin;
      try {
        const target = new URL(`https://${request.url}`);
        if (!target.username && !target.password && target.pathname === "/" && !target.search && !target.hash) requestedOrigin = target.origin;
      } catch { /* Malformed authority is always an unexpected denial. */ }
      if (expectedConnect && expectedConnect.origin === requestedOrigin && expectedConnect.denied === 0) {
        expectedConnect.denied++;
        expectedDenied.push({ id: expectedDenied.length + 1, kind: "expected_denied_fixture_connect",
          method: "CONNECT", protocol: "https:", transport: "connect" });
      } else recordBlocked(request, "https:", "connect");
      socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const isService = destination(request.url, true).origin === serviceTarget?.origin;
    const upstream = track(net.connect({ host: isService ? serviceTarget.host : targetHost,
      port: isService ? serviceTarget.port : targetPort }));
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
    socket.on("close", () => upstream.destroy());
    upstream.on("close", () => socket.destroy());
    upstream.once("connect", () => {
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length) upstream.write(head);
      socket.pipe(upstream); upstream.pipe(socket);
    });
  });
  server.on("upgrade", (request, socket) => {
    recordBlocked(request, "http:", "upgrade");
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  server.on("clientError", (_error, socket) => {
    recordBlocked({ method: "UNKNOWN" }, "invalid", "malformed");
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const stop = () => {
    if (stopping) return stopping;
    stopping = new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
      agent.destroy();
      for (const socket of sockets) socket.destroy();
    });
    return stopping;
  };
  return {
    // Pinned Playwright forces Chromium loopback proxying when bypass is omitted.
    // WebKit's macOS loopback bypass is avoided by the reserved browser origin.
    proxyOptions: { server: `http://127.0.0.1:${server.address().port}` },
    attach(context) {
      assert(!attachedContext || attachedContext === context, "one browser proxy belongs to one context");
      if (!attachedContext) {
        attachedContext = context;
        context.once("close", () => { void stop().catch(() => {}); });
      }
    },
    snapshot: () => blocked.map((record) => ({ ...record })),
    expectedDeniedSnapshot: () => expectedDenied.map((record) => ({ ...record })),
    async withExpectedDeniedConnect({ origin }, action) {
      const fixture = new URL(origin);
      assert(fixture.protocol === "https:" && fixture.origin === origin && fixture.origin !== browserBase.origin
        && !fixture.username && !fixture.password && typeof action === "function",
      "an exact external HTTPS fixture origin and awaited action are required");
      assert(!expectedConnect, "fixture CONNECT scopes cannot overlap");
      expectedConnect = { origin: fixture.origin, denied: 0 };
      try { return await action(); } finally { expectedConnect = undefined; }
    },
    assertClean: () => assert.equal(blocked.length, 0, "browser attempted an unexpected external request through proxy"),
    stop,
  };
}
