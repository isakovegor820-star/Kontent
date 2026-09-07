import assert from "node:assert/strict";

/** Guard response redirects before a browser receives the local TLS response. */
export function createE2eIngressBoundary({ baseUrl, onBlocked = () => {} }) {
  const base = new URL(baseUrl);
  assert(["http:", "https:"].includes(base.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)
    && !base.username && !base.password, "explicit loopback ingress origin required");
  const blocked = [];
  return {
    accept({ requestUrl, status, headers }) {
      const locations = Object.entries(headers).filter(([key]) => key.toLowerCase() === "location");
      if (status < 300 || status >= 400 || locations.length === 0) return true;
      try {
        assert.equal(locations.length, 1);
        const value = locations[0][1]; assert.equal(typeof value, "string");
        const request = new URL(requestUrl, base); assert.equal(request.origin, base.origin);
        const destination = new URL(value, request);
        assert(!destination.username && !destination.password && destination.origin === base.origin);
        return true;
      } catch {
        // Destination/userinfo/path/query may contain secrets; retain no raw URL.
        const record = { id: blocked.length + 1, kind: "external_redirect", status };
        blocked.push(record);
        try { onBlocked({ ...record }); } catch { /* Retained records still fail the gate. */ }
        return false;
      }
    },
    snapshot: () => blocked.map((record) => ({ ...record })),
    assertClean: () => assert.equal(blocked.length, 0, "TLS ingress attempted an off-origin redirect"),
  };
}
