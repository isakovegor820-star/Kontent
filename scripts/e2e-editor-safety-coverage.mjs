import { createE2eBrowserErrorCollector } from "./e2e-browser-error-collector.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import { installE2eBrowserBoundary } from "./e2e-browser-boundary.mjs";
import { selectProjectWithSettledReads } from "./e2e-project-selection.mjs";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";
import { classifyE2eKnownBrowserObservation } from "./e2e-browser-config.mjs";

const TIMEOUT = 45_000;

/** Classify only evidenced cancellations; resets, broken bodies and mutations remain failures. */
export function classifyEditorCancellation(request) {
  if (!request || !/^(?:net::ERR_ABORTED|NS_BINDING_ABORTED|cancelled|Load request cancelled)$/u.test(request.failure ?? "")) return null;
  const successful = request.status >= 200 && request.status < 300;
  if (request.method === "POST" && request.path === "/api/product-events" && successful) return "acknowledged_keepalive";
  if (request.method !== "GET") return null;
  const rsc = !request.path.startsWith("/api/") && request.rsc === "1" && successful
    && request.contentType?.startsWith("text/x-component");
  if (rsc && (request.prefetch === "1" || Boolean(request.segmentPrefetch))) return "completed_rsc_prefetch";
  return null;
}

async function seedEditorActors(pool, projectId) {
  // Execute the actual password implementation. The standalone Node runner cannot
  // resolve its unrelated extensionless TypeScript re-export, so remove only that
  // re-export in memory and transpile this exact source; no product file is changed.
  const source = await readFile(new URL("../src/lib/password.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("password.ts", source, ts.ScriptTarget.Latest, true);
  const standalone = ast.statements.filter((node) => !ts.isExportDeclaration(node)).map((node) => node.getFullText(ast)).join("\n");
  const code = ts.transpileModule(standalone, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hashPassword } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  const key = randomUUID();
  const ownerEmail = `qa-editor-${key}@aurora.test`; const otherEmail = `qa-editor-other-${key}@aurora.test`;
  const ownerPassword = "qa-editor-password-2026"; const otherPassword = "qa-editor-other-password-2026";
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ids = [];
    for (const [email, password, name] of [[ownerEmail, ownerPassword, "QA Editor"], [otherEmail, otherPassword, "QA Other Editor"]]) {
      const userId = Number((await client.query("insert into users(email,password_hash,name,onboarding_completed_at) values($1,$2,$3,now()) returning id", [email, await hashPassword(password), name])).rows[0].id);
      // Both can read/write the shared server draft; only local account identity
      // prevents the second actor from seeing the first actor's private outbox.
      await client.query("insert into project_members(project_id,user_id,role,status) values($1,$2,'author','active')", [projectId, userId]);
      await client.query("insert into user_project_preferences(user_id,selected_project_id) values($1,$2)", [userId, projectId]);
      ids.push(userId);
    }
    await client.query("commit");
    return { userId: ids[0], otherUserId: ids[1], ownerEmail, ownerPassword, otherEmail, otherPassword };
  } catch (error) { await client.query("rollback"); throw error; }
  finally { client.release(); }
}
const pendingCopies = (page, userId, draftId) => page.evaluate(({ userId, draftId }) => {
  const records = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key?.startsWith(`aurora:draft-outbox:v1:${userId}:`)) continue;
    const record = JSON.parse(localStorage.getItem(key));
    if (record.userId === userId && record.draftId === draftId) records.push(record);
  }
  return records;
}, { userId, draftId });

/** Own browser context and exact session expiry; never mutates another journey's session.
 * Fixture POSTs create manual drafts only. All competing content edits/recovery use actual UI.
 * An optional stopAfterConflict supports the archived-source RED without auth follow-up. */
export async function runEditorSafetyCoverage({ browser, baseUrl, pool, projectId, channelId,
  waitFor, readEditableText = (locator) => locator.innerText(), captureScreenshot,
  artifactDir,
  stopAfterConflict = false }) {
  const database = new URL(String(pool.options.connectionString || ""));
  assert(["127.0.0.1", "localhost"].includes(database.hostname)
    && ["/aurora_e2e_real", "/aurora_n32_ui_test"].includes(database.pathname), "isolated editor database required");
  const origin = new URL(baseUrl).origin;
  assert(["127.0.0.1", "localhost"].includes(new URL(origin).hostname), "loopback editor runtime required");
  const { userId, ownerEmail, ownerPassword, otherEmail, otherPassword } = await seedEditorActors(pool, projectId);
  const { context, transport } = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const pages = [];
  const issues = []; const expectedHttp = []; const responseWork = []; const consoleErrors = [];
  const network = []; const requests = new Map(); const navigating = new Map(); const transitions = []; const expectedCancellations = [];
  const callerAborts = []; const browserObservations = []; const screenshotPages = new Set();
  let phase = "setup"; let conflictDraftId = null; let expiryDraftId = null;
  let releaseFirst = () => {}; let releaseSecond = () => {};
  let a; let b; let boundary; let failure; let result; let tracingStarted = false;
  let readEvidence = null;
  const readDiagnostics = { beforeClose: null, afterClose: null };
  const snapshotReads = () => ({
    // These snapshots explain event delivery; they never settle the existing idle
    // predicate or grant a cancellation exception. No flush/barrier is added.
    semantics: "delivery-time observations; missing events are not completion evidence",
    initialized: readEvidence !== null,
    pendingRequests: network.filter((row) => !row.finishedAt && !row.failedAt).map((row) => ({
      id: row.id, nativeRequestId: row.nativeRequestId ?? null, page: row.page, method: row.method,
      path: row.path, startedAt: row.startedAt, status: row.status ?? null,
    })),
    callerAborts: callerAborts.map((row) => {
      let path = null;
      try { path = new URL(row.url).pathname; } catch { /* Invalid metadata stays unavailable. */ }
      return { page: Number.isSafeInteger(row.page) && row.page >= 0 ? row.page : null,
        method: row.method === "GET" ? "GET" : null, path,
        urlHash: createHash("sha256").update(String(row.url)).digest("hex"),
        at: Number.isFinite(row.at) && row.at >= 0 ? row.at : null,
        receivedAt: Number.isFinite(row.receivedAt) && row.receivedAt >= 0 ? row.receivedAt : null, aborted: row.aborted === true };
    }),
    reads: (readEvidence?.snapshot() ?? []).map((row) => {
      const observation = { ...row }; delete observation.reason; return observation;
    }),
    unmatchedReads: readEvidence?.snapshotUnmatchedReads() ?? [],
  });
  const browserErrors = createE2eBrowserErrorCollector({ baseUrl,
    classifyKnownConsole: ({ message, page }) => page ? classifyE2eKnownBrowserObservation({ engine: browser.browserType().name(),
      eventKind: "console", message: message.text(), currentUrl: page.url(), webPort: Number(new URL(origin).port),
      screenshotInProgress: screenshotPages.has(page) }) : null });
  let classifiedConsoleCount = 0;
  const assertDiagnostics = async () => {
    // Response-body classification may finish after its response event or close.
    // Await every captured task before deciding whether its console message is expected.
    let drained = 0;
    while (drained < responseWork.length) {
      const batch = responseWork.slice(drained); drained += batch.length;
      await Promise.all(batch);
    }
    for (let index = issues.length - 1; index >= 0; index--) {
      const issue = issues[index];
      if (issue.kind !== "requestfailed") continue;
      const entry = [...requests].find(([, row]) => row.id === issue.requestId);
      const reason = entry ? readEvidence.reason(entry[0]) : null;
      if (!reason) continue;
      expectedCancellations.push({ ...entry[1], reason }); issues.splice(index, 1);
    }
    for (; classifiedConsoleCount < consoleErrors.length; classifiedConsoleCount++) {
      const error = consoleErrors[classifiedConsoleCount];
      const url = (() => { try { return new URL(error.url); } catch { return null; } })();
      const resourceError = /Failed to load resource:.*(?:401|409)|server responded with a status of (?:401|409)/iu.test(error.text);
      if (resourceError && url?.origin === origin && expectedHttp.some((row) => row.phase === error.phase && row.path === url.pathname)) continue;
      issues.push({ kind: "console", ...error });
    }
    browserErrors.assertClean();
    assert.deepEqual(issues, [], "editor gate has unexpected browser/runtime errors");
  };
  try {
  browserErrors.observeContext(context);
  await context.tracing.start({ screenshots: true, snapshots: false, sources: false }); tracingStarted = true;
  boundary = await installE2eBrowserBoundary(context, { baseUrl, onBlocked: (record) => issues.push(record) });
  // Deferred import avoids the classifier's reverse module dependency. Reuse
  // its native identity/body observations and exact Request admission.
  const { createMainRequestEvidence } = await import("./e2e-main-request-evidence.mjs");
  readEvidence = createMainRequestEvidence({ baseUrl });
  await readEvidence.install(context);
  await context.exposeBinding("__recordEditorCallerAbort", ({ page }, record) => {
    callerAborts.push({ ...record, page: pages.indexOf(page), receivedAt: Date.now() });
  });
  await context.addInitScript(() => {
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const method = String(init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
      const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
      if (signal && method === "GET" && url.origin === location.origin) {
        // Observe the caller's actual AbortSignal; do not alter transport or response.
        const observe = () => { void window.__recordEditorCallerAbort({ url: url.href, method, at: Date.now(), aborted: signal.aborted }); };
        if (signal.aborted) observe(); else signal.addEventListener("abort", observe, { once: true });
      }
      return Reflect.apply(originalFetch, this, [input, init]);
    };
  });
  const screenshot = async (page, options) => {
    if (!captureScreenshot) return;
    screenshotPages.add(page);
    try { await captureScreenshot(page, options); }
    finally { await page.evaluate(() => undefined).catch(() => {}); screenshotPages.delete(page); }
  };
  const expectedExpiryPaths = new Set(["/api/auth/me", "/api/projects", "/api/projects/current", "/api/channels", "/api/posts", "/api/ai/usage"]);
  const recordPage = async () => {
    const page = await context.newPage(); pages.push(page);
    page.on("request", (request) => {
      if (new URL(request.url()).origin !== origin) return;
      const nativeRow = readEvidence.observeRequest(request, `editor:page${pages.indexOf(page)}`, page);
      const record = { id: network.length + 1, nativeRequestId: nativeRow.id, phase, method: request.method(), path: new URL(request.url()).pathname,
        url: request.url(), rsc: request.headers()["rsc"], prefetch: request.headers()["next-router-prefetch"],
        segmentPrefetch: request.headers()["next-router-segment-prefetch"], type: request.resourceType(), startedAt: Date.now(), page: pages.indexOf(page) };
      requests.set(request, record); network.push(record);
    });
    page.on("requestfinished", (request) => { readEvidence.observeFinished(request); const record = requests.get(request); if (record) record.finishedAt = Date.now(); });
    page.on("pageerror", (error) => issues.push({ kind: "pageerror", phase, message: error.message }));
    page.on("crash", () => issues.push({ kind: "crash", phase }));
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const known = classifyE2eKnownBrowserObservation({ engine: browser.browserType().name(), eventKind: "console", message: message.text(),
        currentUrl: page.url(), webPort: Number(new URL(origin).port), screenshotInProgress: screenshotPages.has(page) });
      if (known) browserObservations.push({ phase, ...known });
      else consoleErrors.push({ phase, text: message.text(), url: message.location().url });
    });
    page.on("response", (response) => {
      readEvidence.observeResponse(response);
      const tracked = requests.get(response.request());
      if (tracked) { tracked.status = response.status(); tracked.responseAt = Date.now(); tracked.contentType = response.headers()["content-type"]; }
      if (response.status() < 400 || new URL(response.url()).origin !== origin) return;
      const record = { phase, method: response.request().method(), path: new URL(response.url()).pathname, status: response.status() };
      const task = (async () => {
        const body = await response.json().catch(() => null);
        const conflict = record.phase === "conflict" && record.method === "PATCH"
          && record.path === `/api/drafts/${conflictDraftId}` && record.status === 409 && body?.error === "version_conflict";
        const expiry = ["expiry", "logout"].includes(record.phase) && record.status === 401
          && record.method === "GET" && expectedExpiryPaths.has(record.path) && body?.error === "unauthorized";
        if (conflict || expiry) {
          expectedHttp.push({ ...record, code: body.error });
          await browserErrors.expectHttpError(response, { method: record.method, path: record.path, status: record.status, error: body.error });
        }
        else issues.push({ kind: "unexpected_http", ...record, code: body?.error ?? null });
      })();
      // Keep the original rejecting promise for both idle/final assertions, while
      // preventing Node from exiting before the awaited lifecycle can record it.
      void task.catch(() => undefined); responseWork.push(task);
    });
    page.on("requestfailed", (request) => {
      readEvidence.observeFailure(request);
      const tracked = requests.get(request);
      if (tracked) { tracked.failedAt = Date.now(); tracked.failure = request.failure()?.errorText; }
      if (new URL(request.url()).origin !== origin) return;
      const path = new URL(request.url()).pathname;
      if (tracked) tracked.navigationId = navigating.get(page)?.id;
      issues.push({ kind: "requestfailed", requestId: tracked?.id, phase, method: request.method(), path, error: request.failure()?.errorText });
    });
    return page;
  };
  a = await recordPage(); b = await recordPage();
  const contentIdle = async (page, label) => {
    let idleSince = null;
    await waitFor(() => {
      // Native caller completion can precede a missing SDK terminal event.
      // Preserve raw rows and recheck exact Request proofs for contradictions.
      const callerCompleted = new Set([...requests]
        .filter(([request, row]) => !row.finishedAt && !row.failedAt
          && readEvidence.reason(request) === "native_caller_abort_without_transport_terminal")
        .map(([, row]) => row));
      const blocking = network.filter((row) => row.page === pages.indexOf(page) && !row.finishedAt && !row.failedAt
        && !callerCompleted.has(row)
        && !(row.path === "/api/product-events" && row.status >= 200 && row.status < 300));
      if (blocking.length) { idleSince = null; return false; }
      idleSince ??= Date.now(); return Date.now() - idleSince >= 750;
    }, `${label}: requests did not settle`, TIMEOUT);
    await Promise.all(responseWork);
  };
  const transition = async (page, label, action) => {
    await contentIdle(page, `${label} before transition`);
    await readEvidence.settleReads(page, { timeoutMs: TIMEOUT });
    const navigation = { id: transitions.length + 1, page: pages.indexOf(page), label, startedAt: Date.now(), complete: false };
    transitions.push(navigation); navigating.set(page, navigation);
    try {
      await action(); await contentIdle(page, label);
      navigation.destination = new URL(page.url()).pathname; navigation.complete = true;
    } finally { navigation.finishedAt = Date.now(); navigating.delete(page); }
  };
  const login = async (email, password) => {
    if (new URL(a.url() === "about:blank" ? origin : a.url()).pathname !== "/login") {
      await transition(a, "login page", async () => {
        const hydratedAuth = a.waitForResponse((r) => r.url() === `${origin}/api/auth/me` && r.request().method() === "GET", { timeout: TIMEOUT });
        await a.goto("/login", { waitUntil: "domcontentloaded", timeout: TIMEOUT });
        await (await hydratedAuth).finished();
      });
    } else await contentIdle(a, "existing login page");
    await a.locator("#email").fill(email); await a.locator("#password").fill(password);
    await transition(a, "authenticated landing", async () => {
      const reply = a.waitForResponse((r) => r.url() === `${origin}/api/auth/login` && r.request().method() === "POST", { timeout: TIMEOUT });
      await a.getByRole("button", { name: "Войти в платформу", exact: true }).click();
      assert.equal((await reply).status(), 200);
      await a.waitForURL((url) => url.pathname.startsWith("/app/"), { timeout: TIMEOUT });
    });
  };
  const selectProject = (page) => selectProjectWithSettledReads(page, projectId, { waitFor,
    settleReads: target => readEvidence.settleReads(target, { timeoutMs: TIMEOUT }), timeoutMs: TIMEOUT });
  const openDraft = async (page, id) => {
    await transition(page, "editor Calendar", () => page.goto("/app/calendar", { waitUntil: "domcontentloaded", timeout: TIMEOUT }));
    await selectProject(page); await contentIdle(page, "selected Calendar project");
    await transition(page, "open draft", () => page.goto(`/app/composer?draft=${id}`, { waitUntil: "domcontentloaded", timeout: TIMEOUT }));
    const editor = page.locator("#composer-text");
    await editor.waitFor({ state: "visible", timeout: TIMEOUT });
    await waitFor(async () => await editor.getAttribute("contenteditable") === "true", "editor did not become editable", TIMEOUT);
    return editor;
  };
  const createFixture = async (text) => {
    const reply = await context.request.post("/api/drafts", { headers: { origin, "x-aurora-project-id": String(projectId) }, data: {
      clientKey: `draft_${randomUUID()}`, text, formatting: [], media: null, scheduledAt: null, schedule: null,
      origin: "manual", sourceRef: null, channelIds: [channelId], aiValidation: null,
    } });
    assert.equal(reply.status(), 201, "manual editor fixture was not admitted");
    const body = await reply.json(); assert(body.draft?.id && body.draft.version === 1);
    return body.draft;
  };
  const dbDraft = async (id) => {
    const row = (await pool.query("select text,version from drafts where id=$1 and project_id=$2", [id, projectId])).rows[0];
    return { text: row?.text, version: Number(row?.version) };
  };
  const conflictVisible = async () => {
    const disclosure = b.locator('[data-editor-section="composer-protection"]');
    if (await disclosure.count() && await disclosure.evaluate((el) => !el.open)) await disclosure.locator("summary").click();
    await b.getByText("Есть более свежая версия в другой вкладке. Текущую не перезаписали.", { exact: false }).waitFor({ state: "attached", timeout: TIMEOUT });
  };
  const interfaceReview = [];
  const inspectRecoveryInterface = async (page, draftId, expectedText) => {
    await contentIdle(page, "recovery interface ready");
    const previousViewport = page.viewportSize();
    await page.setViewportSize({ width: 390, height: 844 });
    const panel = page.getByRole("region", { name: "Локальные копии черновика", exact: true });
    await panel.scrollIntoViewIfNeeded();
    const geometry = await panel.evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      const controls = [...element.querySelectorAll("a,button")].map((node) => {
        const rect = node.getBoundingClientRect(); return { name: node.textContent.trim(), width: rect.width, height: rect.height };
      });
      return { viewport: innerWidth, scrollWidth: document.documentElement.scrollWidth, width: bounds.width, controls };
    });
    assert(geometry.scrollWidth <= geometry.viewport + 1, "narrow recovery UI overflows horizontally");
    assert(geometry.controls.every((control) => control.width >= 24 && control.height >= 24), "recovery control target is too small");
    const before = await pendingCopies(page, userId, draftId);
    const trigger = panel.getByRole("button", { name: "Удалить локальную копию 1", exact: true });
    await trigger.focus(); await page.keyboard.press("Enter");
    const dialog = page.getByRole("dialog", { name: "Удалить локальную копию?", exact: true });
    await dialog.waitFor();
    await waitFor(() => dialog.getByRole("button", { name: "Отмена", exact: true }).evaluate((node) => node === document.activeElement), "delete dialog must focus safe cancellation", TIMEOUT);
    await page.keyboard.press("Escape"); await dialog.waitFor({ state: "hidden" });
    await waitFor(() => trigger.evaluate((node) => node === document.activeElement), "delete cancellation must restore focus", TIMEOUT);
    assert.equal((await pendingCopies(page, userId, draftId)).length, before.length, "Escape deleted a local copy");
    await page.keyboard.press("Enter"); await dialog.waitFor();
    await dialog.getByRole("button", { name: "Удалить копию", exact: true }).focus(); await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "hidden" });
    assert.equal((await pendingCopies(page, userId, draftId)).length, before.length - 1, "explicit delete affected another copy");
    assert.equal(await readEditableText(page.locator("#composer-text")), expectedText, "deleting recovery copy changed current editor text");
    assert.equal((await dbDraft(draftId)).text, expectedText, "deleting local copy changed server draft");
    if (captureScreenshot) await screenshot(page, { path: join(artifactDir, "editor-recovery-narrow.png"), fullPage: true });
    interfaceReview.push({ ...geometry, keyboardDialog: { initialFocus: "Отмена", escapePreservesCopies: true, focusRestored: true,
      explicitDeleteOnlyOne: true, currentEditorPreserved: true, serverPreserved: true } });
    await page.setViewportSize(previousViewport);
  };
  const inspectConcurrentCopyDeletion = async (draftId, expectedServerText) => {
    // The deleting tab reviews a snapshot while its independent writer keeps
    // editing. An explicit confirmation never authorizes that later revision.
    const dateInput = a.getByLabel("Дата публикации", { exact: true });
    const dateSection = dateInput.locator("xpath=ancestor::details[1]");
    if (await dateSection.count() && !await dateSection.evaluate((node) => node.open)) await dateSection.locator("summary").click();
    await dateInput.fill("");
    const reviewed = `QA reviewed deletion ${randomUUID()}`;
    const newer = `QA updated after deletion selection ${randomUUID()}`;
    await a.locator("#composer-text").fill(reviewed);
    const panel = b.getByRole("region", { name: "Локальные копии черновика", exact: true });
    const reviewedRow = panel.getByRole("listitem").filter({ hasText: reviewed });
    await reviewedRow.waitFor({ state: "visible", timeout: TIMEOUT });
    const selected = (await pendingCopies(a, userId, draftId)).find((copy) => copy.payload.text === reviewed);
    assert(selected?.copyId, "writer recovery copy was not durable before selection");
    await reviewedRow.getByRole("button", { name: /Удалить локальную копию/u }).click();
    const dialog = b.getByRole("dialog", { name: "Удалить локальную копию?", exact: true });
    await dialog.waitFor();
    await a.locator("#composer-text").fill(newer);
    await waitFor(async () => (await pendingCopies(b, userId, draftId)).some((copy) => copy.copyId === selected.copyId
      && copy.revision > selected.revision && copy.payload.text === newer), "writer update was not durable after selection", TIMEOUT);
    await dialog.getByRole("button", { name: "Удалить копию", exact: true }).click();
    await dialog.getByRole("alert").filter({ hasText: "Копия обновилась в другой вкладке" }).waitFor({ state: "visible", timeout: TIMEOUT });
    assert((await pendingCopies(b, userId, draftId)).some((copy) => copy.copyId === selected.copyId && copy.payload.text === newer),
      "confirmation of the selected old copy removed its newer writer revision");
    assert.equal(await readEditableText(a.locator("#composer-text")), newer);
    assert.deepEqual(await dbDraft(draftId), { text: expectedServerText, version: 3 });
    if (captureScreenshot) await screenshot(b, { path: join(artifactDir, "editor-concurrent-copy-delete.png"), fullPage: true });
    await dialog.getByRole("button", { name: "Отмена", exact: true }).click();
    const currentRow = panel.getByRole("listitem").filter({ hasText: newer });
    await currentRow.getByRole("button", { name: /Удалить локальную копию/u }).click();
    await dialog.getByRole("button", { name: "Удалить копию", exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
    assert(!(await pendingCopies(b, userId, draftId)).some((copy) => copy.copyId === selected.copyId), "fresh explicit deletion did not remove the selected modern version");
    assert.equal(await readEditableText(a.locator("#composer-text")), newer);
    assert.deepEqual(await dbDraft(draftId), { text: expectedServerText, version: 3 });
    interfaceReview.push({ concurrentDeletion: { oldSelectionPreservesNewerRevision: true, warningVisible: true,
      freshSelectionDeletesOnlyReviewedVersion: true, writerAndServerPreserved: true } });
  };
    await login(ownerEmail, ownerPassword);
    await selectProject(a);
    const initial = `QA editor initial ${randomUUID()}`;
    const fixture = await createFixture(initial); conflictDraftId = Number(fixture.id);
    const firstEditor = await openDraft(a, conflictDraftId); const secondEditor = await openDraft(b, conflictDraftId);
    await waitFor(async () => await readEditableText(firstEditor) === initial && await readEditableText(secondEditor) === initial,
      "both tabs must read the same original database version", TIMEOUT);
    const firstText = `QA winning edit ${randomUUID()}`; const secondText = `QA unsaved competing edit ${randomUUID()}`;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const secondGate = new Promise((resolve) => { releaseSecond = resolve; });
    const attempted = [];
    const intercept = (which, gate) => async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      const body = route.request().postDataJSON(); attempted.push({ which, version: body.version, text: body.text });
      await gate; await route.continue();
    };
    const path = `**/api/drafts/${conflictDraftId}`;
    await a.route(path, intercept("first", firstGate)); await b.route(path, intercept("second", secondGate));
    phase = "conflict";
    const firstReply = a.waitForResponse((r) => new URL(r.url()).pathname === `/api/drafts/${conflictDraftId}` && r.request().method() === "PATCH");
    const secondReply = b.waitForResponse((r) => new URL(r.url()).pathname === `/api/drafts/${conflictDraftId}` && r.request().method() === "PATCH");
    await firstEditor.fill(firstText); await secondEditor.fill(secondText);
    await waitFor(() => attempted.length === 2, "both actual autosaves did not reach held transport", TIMEOUT);
    assert.deepEqual(attempted.map((item) => item.version), [1, 1]);
    releaseFirst(); assert.equal((await firstReply).status(), 200);
    await waitFor(async () => (await dbDraft(conflictDraftId)).text === firstText, "first autosave did not commit", TIMEOUT);
    releaseSecond(); const rejected = await secondReply;
    assert.equal(rejected.status(), 409); assert.equal((await rejected.json()).error, "version_conflict");
    await conflictVisible();
    assert.equal(await readEditableText(secondEditor), secondText, "conflict replaced visible local text");
    assert.deepEqual(await dbDraft(conflictDraftId), { text: firstText, version: 2 });
    assert((await pendingCopies(b, userId, conflictDraftId)).some((copy) => copy.payload.text === secondText),
      "first tab ACK removed the second tab durable recovery copy");
    assert.equal(attempted.length, 2, "conflict must not trigger another automatic save");
    await a.unroute(path); await b.unroute(path);
    if (stopAfterConflict) return result = { conflict: true, firstVersion: 2, rejectedVersion: 1 };

    phase = "recovery";
    await transition(b, "conflict reload", () => b.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT }));
    await waitFor(async () => await readEditableText(b.locator("#composer-text")) === secondText, "reload lost conflicting local copy", TIMEOUT);
    await conflictVisible();
    await transition(b, "choose server copy", () => b.getByRole("link", { name: "Открыть серверную версию", exact: true }).click());
    await waitFor(async () => await readEditableText(b.locator("#composer-text")) === firstText, "explicit server recovery did not read winning version", TIMEOUT);
    const localPanel = b.getByRole("region", { name: "Локальные копии черновика", exact: true });
    const copyRow = localPanel.getByRole("listitem").filter({ hasText: secondText }).first();
    await transition(b, "choose local copy", () => copyRow.getByRole("link", { name: /Открыть локальную копию/u }).click());
    await waitFor(async () => await readEditableText(b.locator("#composer-text")) === secondText, "explicit local recovery unavailable", TIMEOUT);
    await conflictVisible();
    assert.deepEqual(await dbDraft(conflictDraftId), { text: firstText, version: 2 }, "viewing a stale local copy must not rebase its write authority");
    await transition(b, "choose server copy", () => b.getByRole("link", { name: "Открыть серверную версию", exact: true }).click());
    await waitFor(async () => await readEditableText(b.locator("#composer-text")) === firstText, "server copy not ready for explicit recovered edit", TIMEOUT);
    const recoveredText = `${secondText} · явно восстановлено после сравнения`;
    await b.locator("#composer-text").fill(recoveredText);
    await waitFor(async () => (await dbDraft(conflictDraftId)).text === recoveredText, "explicit recovered edit did not save", TIMEOUT);
    assert.equal(Number((await dbDraft(conflictDraftId)).version), 3);
    await inspectRecoveryInterface(b, conflictDraftId, recoveredText);
    await inspectConcurrentCopyDeletion(conflictDraftId, recoveredText);
    if (captureScreenshot) await screenshot(b, { path: join(artifactDir, "editor-conflict-recovery.png"), fullPage: true });
    await contentIdle(b, "finished second editor");
    await b.close();

    const expiryFixture = await createFixture(`QA expiry server ${randomUUID()}`); expiryDraftId = Number(expiryFixture.id);
    await openDraft(a, expiryDraftId);
    // An incomplete calendar form deliberately cannot autosave, while write-through
    // must preserve it. No fake success/offline response is injected into the application.
    const dateInput = a.getByLabel("Дата публикации", { exact: true });
    const dateSection = dateInput.locator("xpath=ancestor::details[1]");
    if (await dateSection.count() && !await dateSection.evaluate((node) => node.open)) await dateSection.locator("summary").click();
    await dateInput.fill("");
    const privateText = `QA owner-only unsaved recovery ${randomUUID()}`;
    await a.locator("#composer-text").fill(privateText);
    await waitFor(async () => (await pendingCopies(a, userId, expiryDraftId)).some((copy) => copy.payload.text === privateText), "unsaved expiry text was not durable", TIMEOUT);
    assert.equal((await dbDraft(expiryDraftId)).text, expiryFixture.text);
    const sid = (await context.cookies()).find((cookie) => cookie.name === "sid")?.value;
    assert(sid, "dedicated editor context session missing");
    const verifier = createHash("sha256").update(sid).digest("hex");
    await contentIdle(a, "unsaved editor before expiry");
    phase = "expiry";
    const expired = await pool.query("update sessions set expires_at=now()-interval '1 second' where user_id=$1 and token_hash=$2 and expires_at>now()", [userId, verifier]);
    assert.equal(expired.rowCount, 1, "expire only the exact editor session");
    await transition(a, "expired session redirect", async () => {
      await a.reload({ waitUntil: "domcontentloaded", timeout: TIMEOUT }).catch(async (error) => {
        if (!/interrupted by another navigation/iu.test(error.message) || new URL(a.url()).pathname !== "/login") throw error;
      });
      await a.waitForURL((url) => url.pathname === "/login", { timeout: TIMEOUT });
    });
    phase = "same_account_recovery";
    await login(ownerEmail, ownerPassword); await openDraft(a, expiryDraftId);
    await waitFor(async () => await readEditableText(a.locator("#composer-text")) === privateText, "same-account login lost unsaved Composer text", TIMEOUT);
    assert.equal((await dbDraft(expiryDraftId)).text, expiryFixture.text, "incomplete unsaved form silently changed server text");
    if (captureScreenshot) await screenshot(a, { path: join(artifactDir, "editor-expiry-recovery.png"), fullPage: true });

    phase = "logout";
    await transition(a, "explicit account logout", async () => {
      const logout = a.waitForResponse((r) => new URL(r.url()).pathname === "/api/auth/logout");
      await a.getByRole("button", { name: "Выйти из аккаунта", exact: true }).click();
      assert.equal((await logout).status(), 200); await a.waitForURL((url) => url.pathname === "/");
    });
    phase = "other_account";
    await login(otherEmail, otherPassword); await openDraft(a, expiryDraftId);
    await waitFor(async () => await readEditableText(a.locator("#composer-text")) === expiryFixture.text, "other account did not read the lawful shared server draft", TIMEOUT);
    assert.equal(await a.getByText(privateText, { exact: false }).count(), 0, "other account disclosed owner's recovery text");
    assert((await pendingCopies(a, userId, expiryDraftId)).some((copy) => copy.payload.text === privateText), "account switch deleted owner's durable recovery copy");
    await contentIdle(a, "other account read complete");
    await assertDiagnostics();
    result = { ok: true, scope: "real UI/request/current auth/PostgreSQL/localStorage", conflict: {
      draftId: conflictDraftId, originalVersion: 1, winningVersion: 2, staleStatus: 409, durableLocalSurvived: true,
      reloadPreserved: true, explicitServerAndLocalRecovery: true, recoveredVersion: 3,
    }, expiry: { draftId: expiryDraftId, expiredSessions: 1, loginDestination: "/login", sameAccountTextRestored: true,
      otherAccountCanReadSharedServerOnly: true, privateCopyPreserved: true }, expectedHttp, expectedCancellations, browserObservations, interfaceReview, issues, transitions, network, realProviderCalls: 0 };
    return result;
  } catch (error) {
    failure = error;
    if (a) await a.screenshot({ path: join(artifactDir, "editor-safety-failure.png"), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await finalizeE2eBrowserLifecycle({ context, transport, boundary, error: failure,
      beforeClose: [() => releaseFirst(), () => releaseSecond(), () => { readDiagnostics.beforeClose = snapshotReads(); }, async () => {
        if (tracingStarted) await context.tracing.stop({ path: join(artifactDir, "editor-safety-trace.zip") });
      }],
      cleanup: [() => browserErrors.stop()],
      assertDiagnostics,
      writeEvidence: async ({ error, externalAttempts, transportAttempts }) => {
        readDiagnostics.afterClose = snapshotReads();
        if (error) result = { ok: false, phase, message: error.message,
          conflictDraftId, expiryDraftId, issues, expectedHttp, expectedCancellations, consoleErrors, transitions, network };
        Object.assign(result, { externalAttempts, transportAttempts, browserErrors: browserErrors.snapshot(), readDiagnostics });
        await writeFile(join(artifactDir, "editor-safety-result.json"), JSON.stringify(result, null, 2));
      } });
  }
}
