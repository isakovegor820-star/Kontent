import assert from "node:assert/strict";

export const E2E_RESERVED_BROWSER_HOST = "aurora-e2e.invalid";
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function parseOrigin(value, allowedHosts) {
  const url = new URL(value);
  assert(["http:", "https:"].includes(url.protocol) && allowedHosts.has(url.hostname)
    && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash,
  "explicit loopback or reserved browser origin required");
  return url;
}

export function parseOwnedE2eBrowserOrigin(value) {
  return parseOrigin(value, new Set([...LOOPBACK_HOSTS, E2E_RESERVED_BROWSER_HOST]));
}

export function resolveOwnedE2eBrowserOrigins(baseUrl, browserOrigin = baseUrl) {
  const base = parseOrigin(baseUrl, LOOPBACK_HOSTS);
  const browser = parseOwnedE2eBrowserOrigin(browserOrigin);
  assert(browser.protocol === base.protocol && browser.port === base.port
    && (browser.hostname === base.hostname || browser.hostname === E2E_RESERVED_BROWSER_HOST),
  "reserved browser origin must map exactly to the owned loopback listener");
  return { base, browser };
}
