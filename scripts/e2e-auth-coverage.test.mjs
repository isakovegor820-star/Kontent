import { test } from "vitest";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAuthCoverageDiagnostics, waitForAuthWorkspaceReady } from "./e2e-auth-coverage.mjs";

const baseUrl = "https://127.0.0.1:63345";
const csp = "Refused to apply a stylesheet because its hash, its nonce, or 'unsafe-inline' does not appear in the style-src directive of the Content Security Policy.";
function fixture() {
  const page = new EventEmitter(); page.url = () => baseUrl + "/reset-password"; page.evaluate = async () => undefined;
  const context = new EventEmitter(); context.pages = () => [page];
  const diagnostics = createAuthCoverageDiagnostics({ context, baseUrl, engine: "webkit" });
  function request(path, method = "GET", target = page) {
    const value = { url: () => baseUrl + path, method: () => method, resourceType: () => "fetch", headers: () => ({}), frame: () => ({ page: () => target }) };
    context.emit("request", value); return value;
  }
  function response(req, status = 401, body = { error: "unauthorized" }) {
    const value = { request: () => req, url: req.url, status: () => status, json: async () => body, headers: () => ({ "content-type": "application/json" }) };
    context.emit("response", value); return value;
  }
  function consoleError(text = csp, { args = [], line = 0, column = 0, target = page, path = "/reset-password" } = {}) {
    const value = { type: () => "error", page: () => target, text: () => text, args: () => args,
      location: () => ({ url: baseUrl + path, lineNumber: line, columnNumber: column }) };
    context.emit("console", value);
  }
  async function logout() {
    const scope = diagnostics.beginLogout(page, { sessionRowsBefore: 1 });
    const req = request("/api/auth/logout", "POST"); const res = response(req, 200, { ok: true });
    await diagnostics.confirmLogout(scope, res, { sessionRowsAfter: 0 }); return scope;
  }
  return { page, context, diagnostics, request, response, consoleError, logout };
}

test("only the exact current-project request in a SQL-confirmed logout explains its native 401", async () => {
  const f = fixture(); const scope = await f.logout(); const req = f.request("/api/projects/current");
  f.response(req); f.consoleError("Failed to load resource: the server responded with a status of 401 (Unauthorized)", { path: "/api/projects/current" });
  f.diagnostics.endLogout(scope); await f.diagnostics.flush(); f.diagnostics.assertClean();
  assert.equal(f.diagnostics.snapshot().requests.find(row => row.registered).path, "/api/projects/current");
});
test("a response delivered before SQL confirmation is acknowledged only after the exact session deletion", async () => {
  const f = fixture(); const scope = f.diagnostics.beginLogout(f.page, { sessionRowsBefore: 1 });
  const logout = f.request("/api/auth/logout", "POST"); f.response(f.request("/api/projects/current"));
  assert.throws(() => f.diagnostics.assertClean());
  await f.diagnostics.confirmLogout(scope, f.response(logout, 200, { ok: true }), { sessionRowsAfter: 0 });
  await f.diagnostics.flush(); f.diagnostics.assertClean();
});
for (const responseBeforeConfirmation of [false, true]) {
  test(`telemetry denied during this exact logout requires its confirmed session deletion (${responseBeforeConfirmation})`, async () => {
    const f = fixture(); const scope = f.diagnostics.beginLogout(f.page, { sessionRowsBefore: 1 });
    const logout = f.request("/api/auth/logout", "POST");
    const telemetry = f.request("/api/product-events", "POST");
    if (responseBeforeConfirmation) {
      f.response(telemetry); assert.throws(() => f.diagnostics.assertClean());
    }
    await f.diagnostics.confirmLogout(scope, f.response(logout, 200, { ok: true }), { sessionRowsAfter: 0 });
    if (!responseBeforeConfirmation) f.response(telemetry);
    f.consoleError("Failed to load resource: the server responded with a status of 401 (Unauthorized)", { path: "/api/product-events" });
    f.diagnostics.endLogout(scope); await f.diagnostics.flush(); f.diagnostics.assertClean();
    const rows = f.diagnostics.snapshot().requests.filter(row => row.registered);
    assert.deepEqual(rows.map(row => [row.method, row.path, row.status, row.sessionDeletionConfirmed]), [["POST", "/api/product-events", 401, true]]);
  });
}
for (const variant of ["before-boundary", "before-logout-post", "after-boundary", "other-page", "query", "wrong-method", "other-write", "wrong-status", "wrong-body", "lost-body", "native-failure", "script-console", "extra-console", "foreign-origin"]) {
  test(`logout never excuses unproved telemetry: ${variant}`, async () => {
    const f = fixture(); let scope;
    if (variant !== "before-boundary") scope = variant === "before-logout-post"
      ? f.diagnostics.beginLogout(f.page, { sessionRowsBefore: 1 }) : await f.logout();
    if (variant === "after-boundary") f.diagnostics.endLogout(scope);
    const path = variant === "query" ? "/api/product-events?unexpected=1" : variant === "other-write" ? "/api/drafts" : "/api/product-events";
    let req;
    if (variant === "foreign-origin") {
      req = { url: () => "https://unrelated.invalid/api/product-events", method: () => "POST", resourceType: () => "fetch", headers: () => ({}), frame: () => ({ page: () => f.page }) };
      f.context.emit("request", req);
    } else req = f.request(path, variant === "wrong-method" ? "GET" : "POST", variant === "other-page" ? new EventEmitter() : f.page);
    if (variant === "native-failure") { req.failure = () => ({ errorText: "cancelled" }); f.context.emit("requestfailed", req); }
    else if (variant === "lost-body") f.context.emit("response", { request: () => req, url: req.url, status: () => 401, headers: () => ({}), json: async () => { throw new Error("body lost"); } });
    else f.response(req, variant === "wrong-status" ? 403 : 401, { error: variant === "wrong-body" ? "forbidden" : "unauthorized" });
    if (variant === "before-logout-post") await f.diagnostics.confirmLogout(scope, f.response(f.request("/api/auth/logout", "POST"), 200, { ok: true }), { sessionRowsAfter: 0 });
    if (variant === "script-console" || variant === "extra-console") {
      const count = variant === "extra-console" ? 2 : 1;
      for (let i = 0; i < count; i++) f.consoleError("Failed to load resource: the server responded with a status of 401 (Unauthorized)", { path, args: variant === "script-console" ? ["script"] : [] });
    }
    await f.diagnostics.flush().catch(() => {}); assert.throws(() => f.diagnostics.assertClean());
  });
}
for (const variant of ["before-logout", "after-logout", "other-path", "query", "post", "other-page", "wrong-error", "wrong-status", "script-console", "extra-native-console", "request-before-post"]) {
  test(`unexpected ${variant} remains failure`, async () => {
    const f = fixture(); let scope;
    if (variant === "request-before-post") {
      scope = f.diagnostics.beginLogout(f.page, { sessionRowsBefore: 1 }); f.response(f.request("/api/projects/current"));
      await f.diagnostics.confirmLogout(scope, f.response(f.request("/api/auth/logout", "POST"), 200, { ok: true }), { sessionRowsAfter: 0 });
    } else {
      if (variant !== "before-logout") scope = await f.logout();
      if (variant === "after-logout") f.diagnostics.endLogout(scope);
      const req = f.request(variant === "other-path" ? "/api/posts" : variant === "query" ? "/api/projects/current?unexpected=1" : "/api/projects/current", variant === "post" ? "POST" : "GET", variant === "other-page" ? new EventEmitter() : f.page);
      f.response(req, variant === "wrong-status" ? 403 : 401, { error: variant === "wrong-error" ? "forbidden" : "unauthorized" });
      if (variant === "script-console") f.consoleError("Failed to load resource: the server responded with a status of 401 (Unauthorized)", { path: "/api/projects/current", args: ["script"] });
      if (variant === "extra-native-console") for (let i = 0; i < 2; i++) f.consoleError("Failed to load resource: the server responded with a status of 401 (Unauthorized)", { path: "/api/projects/current" });
    }
    await f.diagnostics.flush().catch(() => {}); assert.throws(() => f.diagnostics.assertClean());
  });
}
for (const variant of ["retained-session", "foreign-request", "missing-ok", "duplicate-logout"]) {
  test(`cannot confirm logout with ${variant}`, async () => {
    const f = fixture(); const scope = f.diagnostics.beginLogout(f.page, { sessionRowsBefore: 1 });
    const req = f.request("/api/auth/logout", "POST");
    if (variant === "duplicate-logout") f.request("/api/auth/logout", "POST");
    const res = f.response(variant === "foreign-request" ? f.request("/api/other", "POST") : req, 200, { ok: variant !== "missing-ok" });
    await assert.rejects(f.diagnostics.confirmLogout(scope, res, { sessionRowsAfter: variant === "retained-session" ? 1 : 0 }));
    f.response(f.request("/api/projects/current")); await f.diagnostics.flush(); assert.throws(() => f.diagnostics.assertClean());
  });
}
test("native screenshot error inside this page's capture and queue flush is the existing known observation", async () => {
  const f = fixture(); f.page.evaluate = async () => f.consoleError();
  await f.diagnostics.screenshot(f.page, async () => {}, {}); f.diagnostics.assertClean();
  assert.equal(f.diagnostics.snapshot().browserErrors.knownBrowserObservations.length, 1);
});
for (const variant of ["before", "late", "other-page", "script-args", "script-location", "other-message"]) {
  test(`screenshot ${variant} console remains failure`, async () => {
    const f = fixture(); const emit = () => f.consoleError(variant === "other-message" ? "unrelated CSP" : csp, {
      target: variant === "other-page" ? new EventEmitter() : f.page,
      args: variant === "script-args" ? [csp] : [], line: variant === "script-location" ? 12 : 0,
    });
    if (variant === "before") emit();
    await f.diagnostics.screenshot(f.page, async () => { if (!["before", "late"].includes(variant)) emit(); }, {});
    if (variant === "late") emit();
    assert.throws(() => f.diagnostics.assertClean());
  });
}
test("closed renderer queue flush fails rather than manufacturing a screenshot PASS", async () => {
  const f = fixture(); f.page.evaluate = async () => { throw new Error("closed"); };
  await assert.rejects(f.diagnostics.screenshot(f.page, async () => {}, {}), /closed/u);
});
test("late body classification failure survives repeated diagnostic flushes", async () => {
  const f = fixture(); await f.logout(); const req = f.request("/api/projects/current");
  const response = { request: () => req, url: req.url, status: () => 401, headers: () => ({}), json: async () => { throw new Error("body lost"); } };
  f.context.emit("response", response); await assert.rejects(f.diagnostics.flush()); await assert.rejects(f.diagnostics.flush());
  assert.throws(() => f.diagnostics.assertClean());
});
test("semantic selected-project readiness precedes the existing strict read barrier", async () => {
  const order = []; const selected = { waitFor: async () => order.push("visible"), count: async () => 1, isEnabled: async () => true, inputValue: async () => "7" };
  await waitForAuthWorkspaceReady({ page: { waitForURL: async () => order.push("protected"), locator: () => selected, getByRole: () => ({ waitFor: async () => {}, filter: () => ({ waitFor: async () => {} }) }) },
    waitFor: async predicate => { assert(await predicate()); order.push("project-ready"); },
    readEvidence: { settleReads: async (_page, options) => { assert.equal(options.timeoutMs, 30_000); order.push("settled"); } } });
  assert.deepEqual(order, ["protected", "visible", "project-ready", "settled"]);
});

test("bounded response drain catches a task enqueued during the first response body read", async () => {
  const f = fixture(); await f.logout(); let completeFirst;
  const first = f.request("/api/projects/current");
  f.context.emit("response", { request: () => first, url: first.url, status: () => 401, headers: () => ({}), json: () => new Promise(resolve => { completeFirst = resolve; }) });
  const draining = f.diagnostics.flush({ timeoutMs: 100 });
  const second = f.request("/api/projects/current");
  f.context.emit("response", { request: () => second, url: second.url, status: () => 401, headers: () => ({}), json: async () => { throw new Error("late unread body"); } });
  completeFirst({ error: "unauthorized" }); await assert.rejects(draining, /auth response diagnostics failed/u);
  await assert.rejects(f.diagnostics.flush());
});
test("a never-completed body times out without a diagnostic success", async () => {
  const f = fixture(); await f.logout(); const req = f.request("/api/projects/current");
  f.context.emit("response", { request: () => req, url: req.url, status: () => 401, headers: () => ({}), json: () => new Promise(() => {}) });
  await assert.rejects(f.diagnostics.flush({ timeoutMs: 10 }), /timed out/u);
  assert.throws(() => f.diagnostics.assertClean());
});
test("a readiness barrier failure prevents the caller from reaching logout", async () => {
  let logout = false; const selected = { waitFor: async () => {}, count: async () => 1, isEnabled: async () => true, inputValue: async () => "7" };
  await assert.rejects(async () => {
    await waitForAuthWorkspaceReady({ page: { waitForURL: async () => {}, locator: () => selected, getByRole: () => ({ waitFor: async () => {}, filter: () => ({ waitFor: async () => {} }) }) },
      waitFor: async fn => assert(await fn()), readEvidence: { settleReads: async () => { throw new Error("unknown read failure"); } } });
    logout = true;
  }, /unknown read failure/u); assert.equal(logout, false);
});
test("diagnostic snapshots do not persist reset fragments, query values, headers or response payloads", async () => {
  const f = fixture(); await f.logout();
  const req = f.request("/api/projects/current?private=secret-query#token=secret-token");
  f.response(req, 401, { error: "unauthorized", privateValue: "secret-body" });
  const value = JSON.stringify(f.diagnostics.snapshot());
  for (const secret of ["secret-query", "secret-token", "secret-body", "headers", "privateValue"]) assert(!value.includes(secret));
  assert.throws(() => f.diagnostics.assertClean());
});

for (const method of ["GET", "POST"]) {
  test(`unproved actual ${method} requestfailed survives flush and stop`, async () => {
    const f = fixture(); const req = f.request("/api/unknown", method); req.failure = () => ({ errorText: "cancelled" });
    f.context.emit("requestfailed", req); await f.diagnostics.flush(); f.diagnostics.stop();
    assert.throws(() => f.diagnostics.assertClean(), /auth has unproved request failures/u);
  });
}

test("the actual limiter logout slice uses readiness, exact session verification and the shared boundary", async () => {
  const { readFile } = await import("node:fs/promises"); const { createHash } = await import("node:crypto");
  const source = await readFile(new URL("./e2e-login-rate-limit-coverage.mjs", import.meta.url), "utf8");
  const code = source.slice(source.indexOf("    await waitForAuthWorkspaceReady("), source.indexOf("    for (let attempt = 2;"));
  assert(code.startsWith("    await waitForAuthWorkspaceReady("));
  const execute = new Function("assert", "createHash", "return async function(page,waitFor,pool,userId,context,diagnostics,waitForAuthWorkspaceReady,goto){" + code + "}")(assert, createHash);
  for (const failure of [false, true]) {
    const rows = [1, 1, 0]; const order = []; const response = {}; const scope = {};
    const page = { waitForResponse: async () => response, getByRole: role => ({ click: async () => order.push("logout-click"), waitFor: async () => order.push(role) }), waitForURL: async () => order.push("landing") };
    const diagnostics = { readEvidence: { settleReads: async () => order.push("landing-settled") },
      beginLogout: (_page, facts) => { assert.equal(facts.sessionRowsBefore, 1); order.push("boundary"); return scope; },
      confirmLogout: async (actualScope, actualResponse, facts) => { assert.equal(actualScope, scope); assert.equal(actualResponse, response); assert.equal(facts.sessionRowsAfter, 0); order.push("confirmed"); },
      endLogout: actualScope => { assert.equal(actualScope, scope); order.push("end"); } };
    const pool = { query: async (sql, values) => { assert.equal(values[0], 7); if (sql.includes("token_hash")) assert.equal(values[1], createHash("sha256").update("owned-test-session").digest("hex")); return { rows: [{ n: rows.shift() }] }; } };
    const run = () => execute(page, () => {}, pool, 7, { cookies: async () => [{ name: "sid", value: "owned-test-session" }] }, diagnostics,
      async () => { order.push("ready"); if (failure) throw new Error("unsafe read"); }, async () => order.push("next-screen"));
    if (failure) { await assert.rejects(run(), /unsafe read/u); assert.deepEqual(order, ["ready"]); }
    else { await run(); assert.deepEqual(order, ["ready", "boundary", "logout-click", "confirmed", "landing", "heading", "landing-settled", "end", "next-screen"]); assert.deepEqual(rows, []); }
  }
});
