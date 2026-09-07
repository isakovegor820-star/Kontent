import { expect, it } from "vitest";
import { createPostsSnapshotEvidence } from "./e2e-posts-snapshot-evidence.mjs";

const baseUrl = "https://localhost:12345";
function fixture({ method = "GET", path = "/api/posts?cursor=own", status = 409, body = '{"error":"posts_snapshot_changed"}' } = {}) {
  const evidence = createPostsSnapshotEvidence({ baseUrl }); const page = {};
  const request = { method: () => method, url: () => baseUrl + path };
  const response = { request: () => request, url: request.url, status: () => status,
    headers: () => ({ "content-type": "application/json" }), body: async () => Buffer.from(body) };
  const message = { type: () => "error", args: () => [], text: () => `Failed to load resource: the server responded with a status of ${status} (Conflict)`,
    location: () => ({ url: request.url(), lineNumber: 0, columnNumber: 0 }) };
  return { evidence, page, request, response, message };
}
it.each(["before-body", "after-body"])("the exact GET409 body proves a native protocol diagnostic: %s", async when => {
  const f = fixture(); f.evidence.observeRequest(f.request, "main", f.page);
  if (when === "before-body") expect(f.evidence.recordNativeConsole(f.message, "main", f.page)).toBe(true);
  f.evidence.observeResponse(f.response, "main", f.page);
  if (when === "after-body") expect(f.evidence.recordNativeConsole(f.message, "main", f.page)).toBe(true);
  f.evidence.beginTeardown(); const result = await f.evidence.finalize();
  expect(result.issues).toEqual([]); expect(result.proofs).toHaveLength(1); expect(result.observations).toHaveLength(1);
});
it.each(["wrong-error", "malformed", "missing-body", "oversize", "http-error-body"])("%s cannot supply protocol evidence", async kind => {
  const f = fixture({ body: kind === "wrong-error" ? '{"error":"access_denied"}' : kind === "malformed" ? "{" : kind === "oversize" ? "x".repeat(65_537) : '{"error":"posts_snapshot_changed"}' });
  if (kind === "missing-body") f.response.body = async () => { throw new Error("body unavailable"); };
  if (kind === "http-error-body") f.response.headers = () => ({ "content-type": "text/html" });
  f.evidence.observeRequest(f.request, "main", f.page); f.evidence.observeResponse(f.response, "main", f.page);
  expect(f.evidence.recordNativeConsole(f.message, "main", f.page)).toBe(true);
  f.evidence.beginTeardown(); const result = await f.evidence.finalize();
  expect(result.issues.length).toBeGreaterThan(0); expect(result.proofs).toEqual([]); expect(result.observations).toEqual([]);
});
it.each(["no-request", "wrong-page", "wrong-context", "other-path", "no-cursor", "empty-cursor", "wrong-status", "script-console", "teardown"])("%s console retains normal failure handling", async kind => {
  const f = fixture({ path: kind === "other-path" ? "/api/drafts?cursor=own" : kind === "no-cursor" ? "/api/posts" : kind === "empty-cursor" ? "/api/posts?cursor=" : undefined, status: kind === "wrong-status" ? 403 : 409 });
  if (kind === "script-console") f.message.args = () => [{}];
  if (kind !== "no-request") f.evidence.observeRequest(f.request, "main", f.page);
  f.evidence.observeResponse(f.response, "main", f.page);
  if (kind === "teardown") f.evidence.beginTeardown();
  expect(f.evidence.recordNativeConsole(f.message, kind === "wrong-context" ? "other" : "main", kind === "wrong-page" ? {} : f.page)).toBe(false);
  f.evidence.beginTeardown();
});
it.each(["POST", "GET"])("an unproved second %s cannot borrow the same URL's valid receipt", async method => {
  const f = fixture(); f.evidence.observeRequest(f.request, "main", f.page); f.evidence.observeResponse(f.response, "main", f.page);
  const second = { ...f.request, method: () => method }; f.evidence.observeRequest(second, "main", f.page);
  f.evidence.observeResponse({ ...f.response, request: () => second, body: async () => Buffer.from('{"error":"other_conflict"}') }, "main", f.page);
  f.evidence.recordNativeConsole(f.message, "main", f.page); f.evidence.beginTeardown();
  const result = await f.evidence.finalize(); expect(result.issues.length).toBeGreaterThan(0); expect(result.observations).toEqual([]);
});
it("one observed response cannot account for two distinct native messages", async () => {
  const f = fixture(); f.evidence.observeRequest(f.request, "main", f.page); f.evidence.observeResponse(f.response, "main", f.page);
  f.evidence.recordNativeConsole(f.message, "main", f.page); f.evidence.recordNativeConsole({ ...f.message }, "main", f.page);
  f.evidence.beginTeardown(); const result = await f.evidence.finalize();
  expect(result.observations).toHaveLength(1); expect(result.issues).toHaveLength(1);
});
