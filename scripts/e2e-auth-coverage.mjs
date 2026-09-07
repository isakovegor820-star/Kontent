import { createE2eBrowserErrorCollector } from "./e2e-browser-error-collector.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createMainRequestEvidence } from "./e2e-main-request-evidence.mjs";
import { classifyE2eKnownBrowserObservation } from "./e2e-browser-config.mjs";

// Reset links may occur in native Playwright messages and stacks. Only hashed
// failure facts may leave this untraced Auth context, including cleanup failures.
const safeAuthErrors = new WeakSet();
const authErrorNames = new Set(["Error", "AggregateError", "AssertionError", "TimeoutError", "TypeError", "RangeError", "ReferenceError", "SyntaxError", "URIError", "EvalError", "AbortError"]);
export function safeAuthCoverageError(error) {
  const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
  const hash = value => createHash("sha256").update(value).digest("hex");
  const redact = (value, ancestors) => {
    if (value && typeof value === "object" && safeAuthErrors.has(value)) return value;
    const rawName = read(value, "name");
    const name = typeof rawName === "string" ? rawName : "Error";
    const rawMessage = read(value, "message");
    const message = typeof rawMessage === "string" ? rawMessage : typeof value === "string" ? value : "Non-Error failure";
    const stack = read(value, "stack");
    const repeated = ancestors.has(value);
    const authFailure = Object.freeze({ name: authErrorNames.has(name) ? name : "Error", nameHash: hash(name),
      messageHash: hash(message), ...(typeof stack === "string" ? { stackHash: hash(stack) } : {}), ...(repeated ? { repeated: true } : {}) });
    const next = new Set(ancestors).add(value);
    const rawErrors = read(value, "errors"); const rawCause = read(value, "cause");
    const errors = !repeated && Array.isArray(rawErrors) ? Object.freeze(rawErrors.map(child => redact(child, next))) : undefined;
    const cause = !repeated && rawCause !== undefined ? redact(rawCause, next) : undefined;
    const authFailures = Object.freeze([authFailure, ...(errors?.flatMap(child => child.authFailures) ?? []), ...(cause?.authFailures ?? [])]);
    const safe = new Error(`Auth coverage failed: ${JSON.stringify(authFailures)}`);
    safe.name = "AuthCoverageError";
    safe.authFailure = authFailure;
    safe.authFailures = authFailures;
    if (errors) safe.errors = errors;
    if (cause) safe.cause = cause;
    safeAuthErrors.add(safe);
    return Object.freeze(safe);
  };
  return redact(error, new Set());
}

// In-memory synthetic mailbox. No message body or reset token is written to artifacts.
export const fakeMailState = { messages: [] };
export function handleFakeMailRequest(req, res, raw) {
  if (req.url !== "/resend/emails") return false;
  assert.equal(req.headers.authorization, "Bearer e2e-resend-not-live");
  assert(req.headers["idempotency-key"]?.startsWith("password-reset-"));
  const body = JSON.parse(raw);
  assert.deepEqual(body.to, ["qa-e2e@aurora.test"]);
  const resetUrl = body.text.match(/https:\/\/127\.0\.0\.1:\d+\/reset-password#token=[A-Za-z0-9_-]+/u)?.[0];
  assert(resetUrl, "synthetic mail has no reset link");
  fakeMailState.messages.push({ resetUrl, idempotencyKey: req.headers["idempotency-key"] });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ id: "synthetic-mail-receipt" }));
  return true;
}


// These observations explain only the explicitly verified logout and screenshot
// operations below. They do not exempt unrelated requests or console errors.
export function createAuthCoverageDiagnostics({ context, baseUrl, engine }) {
  const origin = new URL(baseUrl).origin;
  const screenshotPages = new Set(); const requests = new Map(); const work = []; const errors = [];
  let phase = "created"; let sequence = 0; let activeLogout;
  const readEvidence = createMainRequestEvidence({ baseUrl });
  const browserErrors = createE2eBrowserErrorCollector({ baseUrl, classifyKnownConsole: ({ message, page }) => {
    const location = message.location();
    if (!page || !screenshotPages.has(page) || new URL(page.url()).origin !== origin
      || message.args().length !== 0 || location.lineNumber !== 0 || location.columnNumber !== 0) return null;
    return classifyE2eKnownBrowserObservation({ engine, eventKind: "console", message: message.text(),
      currentUrl: page.url(), webPort: Number(new URL(baseUrl).port), screenshotInProgress: true });
  } });
  browserErrors.observeContext(context);
  const enqueue = task => { const observed = task.catch(error => { errors.push(error); }); work.push(observed); };
  const acknowledge = row => {
    if (row.registrationStarted || !row.response || !row.logout?.confirmed || row.status !== 401
      || !((row.method === "GET" && row.exactCurrent) || (row.method === "POST" && row.exactTelemetry)) || !row.owned
      || row.page !== row.logout.page || row.id <= row.logout.requestId) return;
    // A departing document's telemetry can reach auth after this exact session
    // was deleted. Only the verified unauthorized response explains rejection;
    // incomplete responses, other writes and requests outside this scope fail.
    row.registrationStarted = true;
    enqueue(browserErrors.expectHttpError(row.response, { method: row.method, path: row.path, status: 401, error: "unauthorized" }).then(() => { row.registered = true; }));
  };
  const handlers = {
    request(request) {
      const page = request.frame().page(); const url = new URL(request.url());
      const row = { id: ++sequence, page, request, phase, method: request.method(), path: url.origin === origin ? url.pathname : "[other-origin]", owned: url.origin === origin, exactCurrent: url.href === origin + "/api/projects/current", exactTelemetry: url.href === origin + "/api/product-events", logout: activeLogout };
      requests.set(request, row); readEvidence.observeRequest(request, "auth", page);
      if (activeLogout && page === activeLogout.page && row.owned && row.method === "POST" && row.path === "/api/auth/logout") {
        activeLogout.requests.push(request); activeLogout.requestId = row.id;
      }
    },
    response(response) {
      readEvidence.observeResponse(response);
      const row = requests.get(response.request()); if (!row) return;
      row.response = response; row.status = response.status(); acknowledge(row);
    },
    requestfinished(request) { readEvidence.observeFinished(request); },
    requestfailed(request) { readEvidence.observeFailure(request); },
  };
  for (const [event, handler] of Object.entries(handlers)) context.on(event, handler);
  const logoutScopes = new Set();
  return {
    browserErrors, readEvidence,
    install: () => readEvidence.install(context),
    setPhase(value) { assert(/^[a-z0-9-]+$/u.test(value)); phase = value; },
    beginLogout(page, { sessionRowsBefore }) {
      assert.equal(sessionRowsBefore, 1); assert(!activeLogout, "logout boundary already active");
      const scope = { page, requests: [], requestId: Infinity, confirmed: false, before: 1 };
      logoutScopes.add(scope); activeLogout = scope; phase = "logout"; return scope;
    },
    async confirmLogout(scope, response, { sessionRowsAfter }) {
      assert(logoutScopes.has(scope) && activeLogout === scope && !scope.confirmed, "unknown or settled logout boundary");
      assert.equal(scope.requests.length, 1); assert.equal(scope.requests[0], response.request(), "logout requires its actual Request");
      assert.equal(response.status(), 200); assert.equal((await response.json()).ok, true);
      assert.equal(sessionRowsAfter, 0, "logout must remove its exact previously observed session");
      scope.confirmed = true; scope.after = 0;
      for (const row of requests.values()) if (row.logout === scope) acknowledge(row);
    },
    endLogout(scope) { assert(activeLogout === scope && scope.confirmed); activeLogout = undefined; phase = "logged-out"; },
    async screenshot(page, capture, options) {
      assert(!screenshotPages.has(page)); screenshotPages.add(page); let failure;
      try { await capture(page, options); } catch (error) { failure = error; }
      try { await page.evaluate(() => undefined); } catch (error) { failure = failure ? new AggregateError([failure, error], "screenshot and native queue flush failed") : error; }
      finally { screenshotPages.delete(page); }
      if (failure) throw failure;
    },
    async flush({ timeoutMs = 3_000 } = {}) {
      assert(Number.isFinite(timeoutMs) && timeoutMs > 0 && timeoutMs <= 3_000);
      let timer;
      const drain = async () => { let count; do { count = work.length; await Promise.all(work.slice()); } while (work.length !== count); };
      try { await Promise.race([drain(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Auth response diagnostics timed out")), timeoutMs); })]); }
      finally { clearTimeout(timer); }
      assert.deepEqual(errors, [], "auth response diagnostics failed");
    },
    assertClean() {
      browserErrors.assertClean(); assert.deepEqual(errors, [], "auth response diagnostics failed");
      assert.deepEqual(readEvidence.snapshot().filter(row => row.failure && !row.reason), [], "auth has unproved request failures");
      assert.deepEqual(readEvidence.snapshotUnmatchedReads().filter(row => row.failed), [], "auth has unpaired native read failures");
    },
    stop() { for (const [event, handler] of Object.entries(handlers)) context.off(event, handler); browserErrors.stop(); },
    snapshot() {
      return { phase, logout: [...logoutScopes].map(scope => ({ before: scope.before, after: scope.after ?? null, confirmed: scope.confirmed, requests: scope.requests.length })),
        requests: [...requests.values()].map(row => ({ id: row.id, phase: row.phase, method: row.method, path: row.path,
          status: row.status ?? null, logoutRequest: row.logout?.requestId === row.id,
          sessionDeletionConfirmed: row.logout?.confirmed === true, registered: row.registered === true })),
        readFailures: readEvidence.snapshot().filter(row => row.failure),
        unmatchedReadFailures: readEvidence.snapshotUnmatchedReads().filter(row => row.failed),
        browserErrors: browserErrors.snapshot(), responseDiagnosticFailures: errors.map(error => ({ name: error.name })) };
    },
  };
}

export async function waitForAuthWorkspaceReady({ page, waitFor, readEvidence }) {
  await page.waitForURL(url => url.pathname.startsWith("/app/"));
  const selectedProject = page.locator('select[id$="-project-switcher"]:visible');
  await selectedProject.waitFor({ state: "visible" });
  assert.equal(await selectedProject.count(), 1, "protected workspace needs one visible project selector");
  await waitFor(async () => await selectedProject.isEnabled() && Number(await selectedProject.inputValue()) > 0,
    "protected workspace did not resolve its selected project", 30_000);
  await page.getByRole("heading", { name: "Календарь", exact: true }).waitFor();
  await page.getByRole("status").filter({ hasText: "Загружаем расписание…" }).waitFor({ state: "hidden" });
  await readEvidence.settleReads(page, { timeoutMs: 30_000 });
}

export async function runAuthCoverage({ browser, baseUrl, pool, userId, waitFor, artifactDir, captureScreenshot }) {
  // A separate untraced browser context keeps the synthetic bearer reset token out of
  // trace archives. UI outcomes and database effects, never token values, are recorded.
  const { context, transport } = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true });
  let boundary; let failure; let result;
  const failures = [];
  let diagnostics; let browserErrors; let readEvidence;
  try {
  boundary = await installE2eBrowserBoundary(context, { baseUrl });
  diagnostics = createAuthCoverageDiagnostics({ context, baseUrl, engine: browser.browserType().name() });
  ({ browserErrors, readEvidence } = diagnostics);
  await diagnostics.install();
  const page = await context.newPage();
  browserErrors.attach(page);
  page.on("pageerror", (error) => failures.push(error.name));
  page.on("crash", () => failures.push("crash"));
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", () => { document.documentElement.dataset.authUnhandled = "true"; });
    window.addEventListener("securitypolicyviolation", () => { document.documentElement.dataset.authCsp = "true"; });
  });
  const goto = async url => { await readEvidence.settleReads(page, { timeoutMs: 30_000 }); return page.goto(url); };
  let signInCount = 0;
  const signIn = async (password, expectedStatus) => {
    diagnostics.setPhase(`login-${++signInCount}`);
    await goto("/login");
    await page.locator("#email").fill("qa-e2e@aurora.test");
    await page.locator("#password").fill(password);
    const response = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/login" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Войти в платформу", exact: true }).click();
    const received = await response;
    assert.equal(received.status(), expectedStatus);
    if (expectedStatus === 401) await browserErrors.expectHttpError(received, { method: "POST", path: "/api/auth/login", status: 401, error: "invalid" });
  };
    await signIn("wrong-fixture-password", 401);
    await page.getByRole("alert").filter({ hasText: "Почта или пароль не подошли" }).waitFor();
    await signIn("qa-password-2026", 200);
    await waitForAuthWorkspaceReady({ page, waitFor, readEvidence });
    const oldCookies = await context.cookies();
    const oldSid = oldCookies.find((cookie) => cookie.name === "sid")?.value;
    assert(oldSid, "successful login must issue a session");
    const oldVerifier = createHash("sha256").update(oldSid, "utf8").digest("hex");
    const currentSessionRows = async () => Number((await pool.query(
      "select count(*) as n from sessions where user_id=$1 and token_hash=$2", [userId, oldVerifier],
    )).rows[0].n);
    assert.equal(await currentSessionRows(), 1, "login session must exist before logout");
    const logoutScope = diagnostics.beginLogout(page, { sessionRowsBefore: 1 });
    const logout = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/logout" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Выйти из аккаунта", exact: true }).click();
    await diagnostics.confirmLogout(logoutScope, await logout, { sessionRowsAfter: await currentSessionRows() });
    // Shell's explicit successful logout destination is the public landing page.
    // Session expiry redirects to /login; logout is a separate navigation contract.
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { name: "Юридический контент с проверкой рисков и доказательств", exact: true }).waitFor();
    await readEvidence.settleReads(page, { timeoutMs: 30_000 });
    diagnostics.endLogout(logoutScope);
    const { context: staleContext, transport: staleTransport } = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true });
    let staleFailure;
    try {
      await staleContext.addCookies(oldCookies);
      assert.equal((await staleContext.request.get("/api/auth/me")).status(), 401, "logout retained a usable session");
    } catch (error) { staleFailure = error; throw error; }
    finally { await finalizeE2eBrowserLifecycle({ context: staleContext, transport: staleTransport, error: staleFailure }); }

    diagnostics.setPhase("forgot-password");
    const initialMailCount = fakeMailState.messages.length;
    await goto("/forgot-password");
    await page.locator("#reset-email").fill("qa-e2e@aurora.test");
    const forgot = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/password/forgot");
    await page.getByRole("button", { name: "Отправить инструкцию", exact: true }).click();
    assert.equal((await forgot).status(), 202);
    await page.getByRole("status").filter({ hasText: "Если аккаунт существует" }).waitFor();
    await waitFor(() => fakeMailState.messages.length > initialMailCount, "password recovery worker did not deliver synthetic mail", 45_000);
    const resetUrl = fakeMailState.messages.at(-1).resetUrl;
    diagnostics.setPhase("reset-password");
    await goto(resetUrl);
    await page.locator("#new-password").fill("qa-new-password-2026");
    await page.locator("#confirm-password").fill("different-password-2026");
    await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
    await page.getByText("Пароли не совпадают.", { exact: true }).waitFor();
    assert(await page.locator("#confirm-password").evaluate((element) => element === document.activeElement));
    await page.locator("#confirm-password").fill("qa-new-password-2026");
    const reset = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/password/reset");
    await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
    assert.equal((await reset).status(), 200);
    await page.getByRole("status").filter({ hasText: "Пароль изменён" }).waitFor();
    assert.equal(new URL(page.url()).hash, "");
    assert.equal(Number((await pool.query("select count(*) as n from sessions where user_id=$1 and expires_at>now()", [userId])).rows[0].n), 0);
    await diagnostics.screenshot(page, captureScreenshot, { path: `${artifactDir}/interface-password-reset.png`, fullPage: true });
    // Open the already-used link again from another screen, as from the mailbox.
    // A hash-only navigation on the terminal reset screen does not mount a new form.
    await goto("/login");
    await goto(resetUrl);
    await page.locator("#new-password").fill("another-password-2026");
    await page.locator("#confirm-password").fill("another-password-2026");
    const reuse = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/password/reset");
    await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
    const reused = await reuse;
    assert.equal(reused.status(), 422);
    assert.equal((await reused.json()).error, "used");
    await browserErrors.expectHttpError(reused, { method: "POST", path: "/api/auth/password/reset", status: 422, error: "used" });
    await page.getByRole("status").filter({ hasText: "уже использована" }).waitFor();
    await signIn("qa-password-2026", 401);
    await signIn("qa-new-password-2026", 200);
    await waitForAuthWorkspaceReady({ page, waitFor, readEvidence });
    assert.deepEqual(failures, []);
    assert.equal(await page.evaluate(() => Boolean(document.documentElement.dataset.authUnhandled || document.documentElement.dataset.authCsp)), false);
    return result = { loginForm: true, badCredentials: 401, logoutRevokesSession: true, logoutDatabaseRows: { before: 1, after: 0 }, recoveryForm: true, workerMail: "local-fake", passwordMismatchFocus: true, resetRevokesSessions: true, resetReuse: 422, newPasswordLogin: true, realMail: false };
  } catch (error) { failure = error; throw error; }
  finally {
    try { await finalizeE2eBrowserLifecycle({ context, transport, boundary, error: failure,
      beforeClose: [() => diagnostics?.flush()],
      cleanup: [() => diagnostics?.flush(), () => diagnostics?.stop()],
      assertDiagnostics: () => { diagnostics?.assertClean(); assert.deepEqual(failures, [], "auth coverage has unexpected browser errors after cleanup"); },
      writeEvidence: async ({ error, externalAttempts, transportAttempts }) => {
        const evidence = { result: result ?? null, complete: !error, externalAttempts, transportAttempts, ...(diagnostics?.snapshot() ?? { phase: "setup" }),
          failure: error ? { ...safeAuthCoverageError(error).authFailure, causes: safeAuthCoverageError(error).authFailures } : null };
        if (result) Object.assign(result, { externalAttempts, transportAttempts, browserErrors: browserErrors.snapshot() });
        await mkdir(artifactDir, { recursive: true });
        await writeFile(`${artifactDir}/auth-coverage-result.json`, JSON.stringify(evidence, null, 2));
      } }); } catch (error) { throw safeAuthCoverageError(error); }
  }
}
