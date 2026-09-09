import { expect, it } from "vitest";
import { createMainFaultEvidence } from "./e2e-main-fault-evidence.mjs";

const baseUrl = "https://127.0.0.1:63345";
function fixture({ required = true, rules } = {}) {
  const evidence = createMainFaultEvidence({ baseUrl }); const page = {}; const label = "main";
  const rule = { method: "POST", url: baseUrl + "/api/media/assets", status: 422, jsonError: "invalid_image" };
  evidence.beginScope(label, { page, rules: rules ?? [rule], required });
  const request = ({ method = "POST", url = rule.url, failure = "net::ERR_INTERNET_DISCONNECTED", target = page, context = label, observed = true } = {}) => {
    const value = { method: () => method, url: () => url, failure: () => ({ errorText: failure }) };
    if (observed) evidence.observeRequest(value, context, target);
    return value;
  };
  const response = (req, { status = 422, body = { error: "invalid_image" }, type = "application/json", raw, target = page, context = label, bodyPromise } = {}) => {
    const value = { request: () => req, url: () => req.url(), status: () => status, headers: () => ({ "content-type": type }),
      body: () => bodyPromise ?? Promise.resolve(Buffer.from(raw ?? JSON.stringify(body))) };
    evidence.observeResponse(value, context, target); return value;
  };
  const console = ({ text = "Failed to load resource: the server responded with a status of 422 (Unprocessable Entity)", url = rule.url, args = [], line = 0, column = 0, target = page, context = label } = {}) => {
    const message = { type: () => "error", text: () => text, location: () => ({ url, lineNumber: line, columnNumber: column }), args: () => args };
    return { message, captured: evidence.recordNativeConsole(message, context, target) };
  };
  const finish = async () => { evidence.endScope(label); return evidence.finalize(); };
  return { evidence, page, label, rule, request, response, console, finish };
}

it("admits exactly one native console after the actual matching response body is proved", async () => {
  const f = fixture(); const request = f.request(); f.response(request);
  const message = f.console(); expect(message.captured).toBe(true);
  expect(f.evidence.recordNativeConsole(message.message, f.label, f.page)).toBe(true);
  const result = await f.finish(); expect(result.issues).toEqual([]); expect(result.observations).toHaveLength(1);
  expect(result.proofs[0]).toMatchObject({ method: "POST", status: 422, path: "/api/media/assets" });
  expect(result.proofs[0].bodySha256).toMatch(/^[a-f0-9]{64}$/u);
});
it.each([
  { status: 500 }, { body: { error: "wrong_error" } }, { raw: "not JSON" },
  { type: "text/plain" }, { raw: "x".repeat(65_537) },
])("rejects an unverified scoped HTTP failure: %j", async (delta) => {
  const f = fixture(); f.response(f.request(), delta); f.console();
  expect((await f.finish()).issues.some((item) => item.kind === "unverified_fault_response")).toBe(true);
});
it.each([{ method: "PATCH" }, { url: baseUrl + "/api/media/assets?other=1" }, { observed: false }])("cannot retroactively approve a different request contract: %j", async (delta) => {
  const f = fixture(); f.response(f.request(delta)); f.console(); expect((await f.finish()).issues).not.toEqual([]);
});
it("a silent proved request never masks another unproved request with the same URL/status", async () => {
  const f = fixture(); f.response(f.request()); f.response(f.request(), { body: { error: "unrelated" } }); f.console();
  const result = await f.finish(); expect(result.issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_response" }));
  expect(result.observations).toEqual([]);
});
it("tracks a later outside-scope response identity to prevent aliasing while preserving unrelated negatives", async () => {
  const f = fixture(); f.response(f.request()); f.evidence.endScope(f.label);
  f.response(f.request(), { body: { error: "unrelated" } });
  f.response(f.request({ url: baseUrl + "/api/ai/generate" }), { status: 409, body: { error: "generation_in_progress" } });
  expect(f.console().captured).toBe(true);
  const result = await f.evidence.finalize(); expect(result.issues.map((item) => item.kind)).toEqual(["unverified_fault_response", "unverified_fault_console"]);
  expect(result.issues.every((item) => item.path === "/api/media/assets")).toBe(true); expect(result.observations).toEqual([]);
});
it("leaves unrelated outside-scope errors to existing main classification", async () => {
  const f = fixture({ required: false }); f.evidence.endScope(f.label);
  f.response(f.request({ url: baseUrl + "/api/ai/generate" }), { status: 409 });
  expect(f.console({ url: baseUrl + "/api/ai/generate" }).captured).toBe(false);
  expect((await f.evidence.finalize()).issues).toEqual([]);
});
it.each([
  { args: ["script"] }, { line: 1 }, { column: 1 }, { text: "__AURORA_E2E_UNHANDLED_REJECTION__422" },
  { text: "__AURORA_E2E_CSP_VIOLATION__422" }, { text: "script error 422" },
  { url: "https://foreign.invalid/api/media/assets" }, { target: {} }, { context: "reviewer" },
])("never captures script/unhandled/CSP/unrelated context console: %j", async (delta) => {
  const f = fixture(); f.response(f.request()); expect(f.console(delta).captured).toBe(false);
  expect((await f.finish()).issues).toEqual([]); // Main retains every false-return diagnostic.
});
it("one proved request cannot excuse two distinct native console messages", async () => {
  const f = fixture(); f.response(f.request()); f.console(); f.console();
  const result = await f.finish(); expect(result.observations).toHaveLength(1);
  expect(result.issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_console" }));
});
it("keeps the scope captured at request start while awaiting its late response body", async () => {
  const f = fixture(); const req = f.request(); f.evidence.endScope(f.label);
  let resolve; const pending = new Promise((done) => { resolve = done; });
  f.response(req, { bodyPromise: pending }); expect(f.console().captured).toBe(true);
  let done = false; const final = f.evidence.finalize().then((value) => { done = true; return value; });
  await Promise.resolve(); expect(done).toBe(false);
  resolve(Buffer.from('{"error":"invalid_image"}')); expect((await final).issues).toEqual([]);
});
it("returns failed evidence instead of throwing an asynchronous body failure", async () => {
  const f = fixture(); f.response(f.request(), { bodyPromise: Promise.reject(new Error("PRIVATE_BODY_FAILURE")) }); f.console();
  const result = await f.finish(); expect(result.issues).not.toEqual([]); expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY_FAILURE");
});
it("synchronously defers only an exact eligible response and still rejects its invalid body", async () => {
  const f = fixture(); const req = f.request();
  const wrongBody = f.response(req, { body: { error: "unverified" } });
  expect(f.evidence.observeResponse(wrongBody, f.label, f.page)).toBe(true);
  const unrelated = f.response(f.request({ method: "PATCH" }));
  expect(f.evidence.observeResponse(unrelated, f.label, f.page)).toBe(false);
  expect((await f.finish()).issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_response" }));
});
it("does not use a scope opened after the request started", async () => {
  const f = fixture({ required: false }); f.evidence.endScope(f.label); const req = f.request();
  f.evidence.beginScope(f.label, { page: f.page, rules: [f.rule] }); f.response(req); f.console();
  expect((await f.finish()).issues).not.toEqual([]);
});
it("requires a proved fault when requested and a closed scope before success", async () => {
  const f = fixture(); const result = await f.evidence.finalize();
  expect(result.issues.map((item) => item.kind)).toEqual(["fault_scope_not_closed", "required_fault_not_proved"]);
});
it("never captures a late console or grants a new request allowance during teardown", async () => {
  const f = fixture(); f.response(f.request()); f.evidence.beginTeardown();
  expect(f.console().captured).toBe(false); f.response(f.request());
  expect((await f.finish()).issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_response" }));
});
it("verifies restart GET text from the real local TLS relay, without permitting mutations", async () => {
  const f = fixture({ required: false, rules: [{ method: "GET", readOnly: true, matchUrl: (url) => url.pathname.startsWith("/api/"), status: 502, text: "runtime unavailable" }] });
  const req = f.request({ method: "GET", url: baseUrl + "/api/channels?project=7" });
  f.response(req, { status: 502, type: "text/plain", raw: "runtime unavailable" });
  f.console({ url: req.url(), text: "Failed to load resource: the server responded with a status of 502 (Bad Gateway)" });
  expect((await f.finish()).issues).toEqual([]);
  f.evidence.beginScope(f.label, { page: f.page, rules: [{ method: "GET", readOnly: true, matchUrl: () => true, status: 502, text: "runtime unavailable" }], required: false });
  f.response(f.request({ method: "PATCH" }), { status: 502, type: "text/plain", raw: "runtime unavailable" });
  expect((await f.finish()).issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_response", method: "PATCH" }));
});
it("validates legal rendering's actual unsafe_layout code", async () => {
  const f = fixture({ rules: [{ method: "POST", url: baseUrl + "/api/legal-visuals/7/renders", status: 422, jsonError: "unsafe_layout" }] });
  const req = f.request({ url: baseUrl + "/api/legal-visuals/7/renders" }); f.response(req, { body: { error: "unsafe_layout", issues: ["synthetic"] } });
  f.console({ url: req.url() }); expect((await f.finish()).issues).toEqual([]);
});
it.each([false, true])("only the exact explicitly route-aborted Request can prove offline PATCH (explicit=%s)", async (explicitRouteAbort) => {
  const f = fixture({ rules: [{ method: "PATCH", url: baseUrl + "/api/drafts/7", failure: "net::ERR_INTERNET_DISCONNECTED", explicitRouteAbort: true }] });
  const req = f.request({ method: "PATCH", url: baseUrl + "/api/drafts/7" });
  f.evidence.observeFailure(req, f.label, f.page, { explicitRouteAbort });
  expect(f.console({ url: req.url(), text: "Failed to load resource: net::ERR_INTERNET_DISCONNECTED" }).captured).toBe(true);
  const result = await f.finish(); expect(result.issues.length === 0).toBe(explicitRouteAbort);
  if (explicitRouteAbort) expect(result.proofs).toContainEqual(expect.objectContaining({ method: "PATCH", explicitRouteAbort: true }));
});
it("never upgrades an unproved failure on a second observation", async () => {
  const f = fixture({ rules: [{ method: "PATCH", url: baseUrl + "/api/drafts/7", failure: "net::ERR_INTERNET_DISCONNECTED", explicitRouteAbort: true }] });
  const req = f.request({ method: "PATCH", url: baseUrl + "/api/drafts/7" });
  f.evidence.observeFailure(req, f.label, f.page); f.evidence.observeFailure(req, f.label, f.page, { explicitRouteAbort: true });
  expect((await f.finish()).issues).not.toEqual([]);
});
it("does not retain an explicit abort proof when a contradictory HTTP response arrives later", async () => {
  const f = fixture({ rules: [{ method: "PATCH", url: baseUrl + "/api/drafts/7", failure: "net::ERR_INTERNET_DISCONNECTED", explicitRouteAbort: true }] });
  const req = f.request({ method: "PATCH", url: baseUrl + "/api/drafts/7" });
  f.evidence.observeFailure(req, f.label, f.page, { explicitRouteAbort: true }); f.response(req, { status: 200 });
  expect((await f.finish()).issues).toContainEqual(expect.objectContaining({ kind: "unverified_fault_request" }));
});
it("rejects unsafe configuration instead of creating an implicit mutation/window allowance", () => {
  for (const rule of [{ method: "PATCH", matchUrl: () => true, status: 500, text: "x" },
    { method: "POST", url: baseUrl + "/api/media/assets", status: 422 },
    { method: "GET", url: "https://foreign.invalid/api/a", status: 502, text: "x" }]) {
    expect(() => fixture({ rules: [rule] })).toThrow();
  }
});
