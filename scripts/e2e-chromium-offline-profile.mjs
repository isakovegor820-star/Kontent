import assert from "node:assert/strict";
import { createHash, X509Certificate } from "node:crypto";
import https from "node:https";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);
const ownedFixtures = new WeakMap();

function applicationOrigin(value) {
  const url = new URL(value);
  assert(["http:", "https:"].includes(url.protocol) && LOOPBACK.has(url.hostname)
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "explicit loopback application origin required");
  return url;
}

/** Only this module can authorize its currently listening, fixed-response fixture. */
export function resolveE2eBrowserServiceFixture(fixture, baseUrl) {
  const base = applicationOrigin(baseUrl);
  const owned = ownedFixtures.get(fixture);
  assert(owned?.active, "active owned Chromium service fixture required");
  assert.equal(base.origin, owned.baseOrigin, "Chromium service fixture belongs to another application origin");
  assert(new URL(owned.origin).hostname !== base.hostname,
    "Chromium service fixture must have a different hostname from the application");
  return { origin: owned.origin, host: "127.0.0.1", port: owned.port };
}

/** Keep full Chromium's native zoom while its cloud services use only an owned 403 sink. */
export async function createE2eChromiumOfflineProfile({ baseUrl, tls, zoom = 2 }) {
  const base = applicationOrigin(baseUrl);
  assert(Number.isFinite(zoom) && zoom > 0 && zoom <= 5, "valid native Chromium zoom required");
  assert(tls?.key && tls?.cert, "owned fixture TLS key and certificate required");
  const spki = createHash("sha256")
    .update(new X509Certificate(tls.cert).publicKey.export({ type: "spki", format: "der" }))
    .digest("base64");
  const profilePath = await mkdtemp(join(tmpdir(), "aurora-e2e-offline-chromium-"));
  const requests = [];
  const sockets = new Set();
  let owned;
  let stopping;
  const server = https.createServer({ key: tls.key, cert: tls.cert }, (request, response) => {
    // Browser services can include credentials or form signatures. Never retain them.
    request.resume();
    request.on("error", () => response.destroy());
    response.on("error", () => response.destroy());
    requests.push({ id: requests.length + 1, kind: "owned_browser_service", status: 403 });
    response.writeHead(403, { "content-type": "text/plain", "cache-control": "no-store" });
    response.end("Owned browser service disabled");
  });
  server.on("connection", socket => {
    sockets.add(socket);
    socket.on("error", () => socket.destroy());
    socket.once("close", () => sockets.delete(socket));
  });
  const stop = () => {
    if (stopping) return stopping;
    if (owned) owned.active = false;
    stopping = (async () => {
      try {
        if (server.listening) await new Promise((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          for (const socket of sockets) socket.destroy();
        });
      } finally { await rm(profilePath, { recursive: true, force: true }); }
    })();
    return stopping;
  };
  try {
    await mkdir(join(profilePath, "Default"));
    await writeFile(join(profilePath, "Default", "Preferences"), JSON.stringify({
      search: { suggest_enabled: false },
      partition: { default_zoom_level: { x: Math.log(zoom) / Math.log(1.2) } },
    }));
    await writeFile(join(profilePath, "Local State"), JSON.stringify({
      network_time: { network_time_queries_enabled: false },
    }));
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const port = server.address().port;
    // Google URL classification sometimes compares only hostnames, not ports.
    const hostname = base.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const origin = `https://${hostname}:${port}`;
    const url = `${origin}/`;
    owned = { origin, port, baseOrigin: base.origin, active: true };
    const serviceFixture = Object.freeze({ kind: "aurora-owned-chromium-service-fixture", origin });
    ownedFixtures.set(serviceFixture, owned);
    const launchArgs = Object.freeze([
      `--ignore-certificate-errors-spki-list=${spki}`,
      `--gaia-url=${url}`,
      `--google-base-url=${url}`,
      `--google-url=${url}`,
      `--gcm-checkin-url=${url}owned-browser-checkin`,
      `--gcm-registration-url=${url}owned-browser-registration`,
      `--autofill-server-url=${url}owned-browser-autofill/`,
    ]);
    return {
      profilePath, launchArgs, serviceFixture, stop,
      snapshot: () => ({ kind: "owned_browser_services", stopped: !owned.active,
        requests: requests.map(request => ({ ...request })) }),
    };
  } catch (error) { await stop(); throw error; }
}
