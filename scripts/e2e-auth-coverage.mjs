import assert from "node:assert/strict";
import { createHash } from "node:crypto";

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

export async function runAuthCoverage({ browser, baseUrl, pool, userId, waitFor, artifactDir, captureScreenshot }) {
  // A separate untraced browser context keeps the synthetic bearer reset token out of
  // trace archives. UI outcomes and database effects, never token values, are recorded.
  const context = await browser.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true });
  const page = await context.newPage();
  const failures = [];
  page.on("pageerror", (error) => failures.push(error.name));
  page.on("crash", () => failures.push("crash"));
  await page.addInitScript(() => {
    window.addEventListener("unhandledrejection", () => { document.documentElement.dataset.authUnhandled = "true"; });
    window.addEventListener("securitypolicyviolation", () => { document.documentElement.dataset.authCsp = "true"; });
  });
  const signIn = async (password, expectedStatus) => {
    await page.goto("/login");
    await page.locator("#email").fill("qa-e2e@aurora.test");
    await page.locator("#password").fill(password);
    const response = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/login" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Войти в платформу", exact: true }).click();
    assert.equal((await response).status(), expectedStatus);
  };
  try {
    await signIn("wrong-fixture-password", 401);
    await page.getByRole("alert").filter({ hasText: "Почта или пароль не подошли" }).waitFor();
    await signIn("qa-password-2026", 200);
    await page.waitForURL((url) => url.pathname.startsWith("/app/"));
    const oldCookies = await context.cookies();
    const oldSid = oldCookies.find((cookie) => cookie.name === "sid")?.value;
    assert(oldSid, "successful login must issue a session");
    const oldVerifier = createHash("sha256").update(oldSid, "utf8").digest("hex");
    const currentSessionRows = async () => Number((await pool.query(
      "select count(*) as n from sessions where user_id=$1 and token_hash=$2", [userId, oldVerifier],
    )).rows[0].n);
    assert.equal(await currentSessionRows(), 1, "login session must exist before logout");
    const logout = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/logout" && r.request().method() === "POST");
    await page.getByRole("button", { name: "Выйти из аккаунта", exact: true }).click();
    assert.equal((await logout).status(), 200);
    assert.equal(await currentSessionRows(), 0, "successful logout must delete its exact PostgreSQL session");
    // Shell's explicit successful logout destination is the public landing page.
    // Session expiry redirects to /login; logout is a separate navigation contract.
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { name: "Юридический контент с проверкой рисков и доказательств", exact: true }).waitFor();
    const staleContext = await browser.newContext({ baseURL: baseUrl, ignoreHTTPSErrors: true });
    try {
      await staleContext.addCookies(oldCookies);
      assert.equal((await staleContext.request.get("/api/auth/me")).status(), 401, "logout retained a usable session");
    } finally { await staleContext.close(); }

    const initialMailCount = fakeMailState.messages.length;
    await page.goto("/forgot-password");
    await page.locator("#reset-email").fill("qa-e2e@aurora.test");
    const forgot = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/password/forgot");
    await page.getByRole("button", { name: "Отправить инструкцию", exact: true }).click();
    assert.equal((await forgot).status(), 202);
    await page.getByRole("status").filter({ hasText: "Если аккаунт существует" }).waitFor();
    await waitFor(() => fakeMailState.messages.length > initialMailCount, "password recovery worker did not deliver synthetic mail", 45_000);
    const resetUrl = fakeMailState.messages.at(-1).resetUrl;
    await page.goto(resetUrl);
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
    await captureScreenshot(page, { path: `${artifactDir}/interface-password-reset.png`, fullPage: true });
    // Open the already-used link again from another screen, as from the mailbox.
    // A hash-only navigation on the terminal reset screen does not mount a new form.
    await page.goto("/login");
    await page.goto(resetUrl);
    await page.locator("#new-password").fill("another-password-2026");
    await page.locator("#confirm-password").fill("another-password-2026");
    const reuse = page.waitForResponse((r) => r.url() === baseUrl + "/api/auth/password/reset");
    await page.getByRole("button", { name: "Сменить пароль", exact: true }).click();
    const reused = await reuse;
    assert.equal(reused.status(), 422);
    assert.equal((await reused.json()).error, "used");
    await page.getByRole("status").filter({ hasText: "уже использована" }).waitFor();
    await signIn("qa-password-2026", 401);
    await signIn("qa-new-password-2026", 200);
    await page.waitForURL((url) => url.pathname.startsWith("/app/"));
    assert.deepEqual(failures, []);
    assert.equal(await page.evaluate(() => Boolean(document.documentElement.dataset.authUnhandled || document.documentElement.dataset.authCsp)), false);
    return { loginForm: true, badCredentials: 401, logoutRevokesSession: true, logoutDatabaseRows: { before: 1, after: 0 }, recoveryForm: true, workerMail: "local-fake", passwordMismatchFocus: true, resetRevokesSessions: true, resetReuse: 422, newPasswordLogin: true, realMail: false };
  } finally { await context.close(); }
}
