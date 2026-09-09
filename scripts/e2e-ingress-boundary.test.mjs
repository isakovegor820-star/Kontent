import { expect, it, vi } from "vitest";
import { createE2eIngressBoundary } from "./e2e-ingress-boundary.mjs";
const baseUrl = "https://127.0.0.1:8443";
it.each(["/login", "../next", "?page=2", "#local", `${baseUrl}/app/calendar`])("retains local redirect %s", (location) => {
  const guard = createE2eIngressBoundary({ baseUrl });
  expect(guard.accept({ requestUrl: "/app/start", status: 307, headers: { location } })).toBe(true);
  guard.assertClean();
});
it.each(["https://127.0.0.1:9443/private?token=secret", "http://127.0.0.1:8443/", "https://localhost:8443/", "//foreign.invalid/secret", "https://user:secret@127.0.0.1:8443/", "javascript:alert(1)", ["/local", "https://foreign.invalid"]])("denies unsafe redirect %s", (location) => {
  const onBlocked = vi.fn(); const guard = createE2eIngressBoundary({ baseUrl, onBlocked });
  expect(guard.accept({ requestUrl: "/app/start", status: 302, headers: { Location: location } })).toBe(false);
  expect(onBlocked).toHaveBeenCalledOnce(); expect(() => guard.assertClean()).toThrow("off-origin redirect");
  expect(JSON.stringify(guard.snapshot())).not.toMatch(/token|secret|foreign|private/u);
});
it("preserves non-redirect responses and bodies without inspecting or buffering them", () => {
  const guard = createE2eIngressBoundary({ baseUrl });
  expect(guard.accept({ requestUrl: "/api/stream", status: 200, headers: { "content-type": "text/event-stream" } })).toBe(true);
  expect(guard.accept({ requestUrl: "/created", status: 201, headers: { location: "https://foreign.invalid" } })).toBe(true);
  expect(guard.accept({ requestUrl: "/not-modified", status: 304, headers: {} })).toBe(true);
  guard.assertClean();
});
it("denies conflicting location headers and never lets a diagnostics exception admit a redirect", () => {
  const guard = createE2eIngressBoundary({ baseUrl, onBlocked: () => { throw new Error("consumer failed"); } });
  expect(guard.accept({ requestUrl: "/", status: 301, headers: { location: "/safe", Location: "/also-safe" } })).toBe(false);
  expect(() => guard.assertClean()).toThrow(); const records = guard.snapshot(); records.length = 0; expect(guard.snapshot()).toHaveLength(1);
});
it.each(["https://remote.invalid", "file:///tmp/fixture", "https://user:secret@localhost:8443"])("refuses an unsafe base %s", (base) => {
  expect(() => createE2eIngressBoundary({ baseUrl: base })).toThrow("explicit loopback");
});
