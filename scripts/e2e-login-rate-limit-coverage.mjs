import { createAuthCoverageDiagnostics, waitForAuthWorkspaceReady } from "./e2e-auth-coverage.mjs";
import { finalizeE2eBrowserLifecycle } from "./e2e-browser-lifecycle.mjs";
import { createE2eBrowserContext } from "./e2e-browser-context.mjs";
import assert from "node:assert/strict";
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import ts from "typescript";

export const LOGIN_RATE_LIMIT_FIXTURE_HEADER = "x-aurora-e2e-login-fixture";

// The disposable TLS ingress alone uses this registry. A random browser header is
// not an IP claim: only an active fixture can resolve to its reserved test IP.
export function createLoginRateLimitFixtureIngress() {
  const entries = new Map();
  return {
    register(token, ip) {
      assert.match(token, /^[a-f0-9]{48}$/u);
      assert.match(ip, /^192\.0\.2\.(?:[1-9]|[1-9]\d|1\d\d|2[0-4]\d|25[0-4])$/u);
      assert(!entries.has(token) && ![...entries.values()].includes(ip), "fixture identity already reserved");
      entries.set(token, ip);
    },
    resolve(headers) {
      const token = headers[LOGIN_RATE_LIMIT_FIXTURE_HEADER];
      return typeof token === "string" ? entries.get(token) ?? null : null;
    },
    release(token) { entries.delete(token); },
  };
}
export const loginRateLimitFixtureIngress = createLoginRateLimitFixtureIngress();

async function passwordHash(password) {
  // Same standalone loading used by the existing editor fixture: execute the
  // current product hash function, removing only an unrelated TS re-export.
  const source = await readFile(new URL("../src/lib/password.ts", import.meta.url), "utf8");
  const ast = ts.createSourceFile("password.ts", source, ts.ScriptTarget.Latest, true);
  const standalone = ast.statements.filter((node) => !ts.isExportDeclaration(node)).map((node) => node.getFullText(ast)).join("\n");
  const code = ts.transpileModule(standalone, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  const { hashPassword } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
  return hashPassword(password);
}

/** Actual login UI → Next guards → Redis Lua counts → response/UI/session effects.
 * No HTTP response is mocked. The caller must install the test ingress registry
 * in its existing loopback TLS proxy and strip the fixture header upstream. */
export async function runLoginRateLimitCoverage({ browser, baseUrl, pool, redis, waitFor, artifactDir }) {
  const origin = new URL(baseUrl);
  const database = new URL(String(pool.options.connectionString || ""));
  assert(["127.0.0.1", "localhost"].includes(origin.hostname));
  assert(["127.0.0.1", "localhost"].includes(database.hostname) && database.pathname === "/aurora_e2e_real");
  assert(["127.0.0.1", "localhost"].includes(redis.options.host), "isolated Redis required");
  const token = randomBytes(24).toString("hex");
  const email = `qa-login-limit-${randomBytes(12).toString("hex")}@aurora.test`;
  const password = `qa-login-limit-${randomBytes(12).toString("hex")}`;
  let ip;
  for (let attempt = 0; attempt < 254; attempt++) {
    const candidate = `192.0.2.${randomInt(1, 255)}`;
    if (!(await redis.exists(`rl:login:ip:${candidate}`))) { ip = candidate; break; }
  }
  assert(ip, "no unused synthetic limiter IP available");
  const ipKey = `rl:login:ip:${ip}`;
  const accountKey = `rl:login:acct:${email}`;
  assert.equal(await redis.exists(ipKey, accountKey), 0, "fixture keys must start unused");
  const userId = Number((await pool.query(
    "insert into users(email,password_hash,name,onboarding_completed_at) values($1,$2,'QA login limits',now()) returning id",
    [email, await passwordHash(password)],
  )).rows[0].id);
  let context; let transport; let failure;
  const externalAttempts = []; const issues = [];
  let diagnostics; let browserErrors;
  const evidence = { scenario: "actual Redis login throttling", userId, fixtureIp: ip, attempts: [], noMockResponses: true, externalAttempts };
  const counters = async () => ({ ip: Number(await redis.get(ipKey)), account: Number(await redis.get(accountKey)),
    ipTtl: await redis.ttl(ipKey), accountTtl: await redis.ttl(accountKey) });
  const boundary = { snapshot: () => [...externalAttempts],
    assertClean: () => assert.deepEqual(externalAttempts, [], "login fixture attempted an external request") };
  try {
  loginRateLimitFixtureIngress.register(token, ip);
  ({ context, transport } = await createE2eBrowserContext(browser, { baseUrl, ignoreHTTPSErrors: true,
    extraHTTPHeaders: { [LOGIN_RATE_LIMIT_FIXTURE_HEADER]: token, "x-forwarded-for": "203.0.113.19" },
  }));
  diagnostics = createAuthCoverageDiagnostics({ context, baseUrl, engine: browser.browserType().name() });
  browserErrors = diagnostics.browserErrors;
  await diagnostics.install();
  await context.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === origin.origin || url.protocol === "data:") return route.continue();
    externalAttempts.push({ origin: url.origin, method: request.method(), resourceType: request.resourceType() });
    await route.abort("blockedbyclient");
  });
  // Authentication and random ingress credentials are deliberately untraced.
  const page = await context.newPage();
  browserErrors.attach(page);
  page.on("pageerror", (error) => issues.push(error.name));
  page.on("crash", () => issues.push("crash"));
  const goto = async url => { await diagnostics.readEvidence.settleReads(page, { timeoutMs: 30_000 }); return page.goto(url); };
  const attemptLogin = async (attempt, enteredPassword, expectedStatus, expectedLimit = null) => {
    diagnostics.setPhase(`login-${attempt}`);
    await page.locator("#email").fill(email);
    await page.locator("#password").fill(enteredPassword);
    const button = page.getByRole("button", { name: "Войти в платформу", exact: true });
    await waitFor(async () => !await button.isDisabled(), "login form remained busy");
    const responsePromise = page.waitForResponse((response) => response.url() === baseUrl + "/api/auth/login" && response.request().method() === "POST");
    void responsePromise.catch(() => undefined);
    await button.click();
    const response = await responsePromise;
    assert.equal(response.status(), expectedStatus, `unexpected actual login outcome on attempt ${attempt}`);
    const body = await response.json();
    const state = await counters();
    assert.equal(state.ip, attempt, "ingress did not isolate this fixture's actual limiter IP");
    assert.equal(state.account, Math.min(attempt, 10), "wrong actual account limiter counter");
    assert(state.ipTtl > 0 && state.ipTtl <= 900 && state.accountTtl > 0 && state.accountTtl <= 900);
    if (expectedStatus === 401) {
      assert.equal(body.error, "invalid");
      await browserErrors.expectHttpError(response, { method: "POST", path: "/api/auth/login", status: 401, error: "invalid" });
      await page.getByRole("alert").filter({ hasText: "Почта или пароль не подошли" }).waitFor();
    } else if (expectedStatus === 429) {
      assert.equal(body.error, "rate_limited");
      await browserErrors.expectHttpError(response, { method: "POST", path: "/api/auth/login", status: 429, error: "rate_limited" });
      assert.equal(Number(response.headers()["x-ratelimit-limit"]), expectedLimit);
      assert.equal(Number(response.headers()["x-ratelimit-remaining"]), 0);
      assert.equal(Number(response.headers()["retry-after"]), body.retryAfter);
      assert(Number.isInteger(body.retryAfter) && body.retryAfter > 0 && body.retryAfter <= 900);
      await page.getByRole("alert").filter({ hasText: "Слишком много попыток. Попробуйте снова через" }).waitFor();
      assert.equal(new URL(page.url()).pathname, "/login");
      assert(!(response.headers()["set-cookie"] || "").includes("sid="), "throttled login issued a session cookie");
      assert.equal(Number((await pool.query("select count(*)::int as n from sessions where user_id=$1", [userId])).rows[0].n), 0);
    }
    evidence.attempts.push({ attempt, status: response.status(), limit: expectedLimit, retryAfter: body.retryAfter ?? null, counters: state });
  };
    await goto("/login");
    await attemptLogin(1, password, 200);
    await waitForAuthWorkspaceReady({ page, waitFor, readEvidence: diagnostics.readEvidence });
    assert.equal(Number((await pool.query("select count(*)::int as n from sessions where user_id=$1", [userId])).rows[0].n), 1);
    const sid = (await context.cookies()).find(cookie => cookie.name === "sid")?.value;
    assert(sid, "successful control login must issue a session");
    const verifier = createHash("sha256").update(sid).digest("hex");
    const sessionRows = async () => Number((await pool.query("select count(*)::int as n from sessions where user_id=$1 and token_hash=$2", [userId, verifier])).rows[0].n);
    const logoutScope = diagnostics.beginLogout(page, { sessionRowsBefore: await sessionRows() });
    const logoutPromise = page.waitForResponse((response) => response.url() === baseUrl + "/api/auth/logout" && response.request().method() === "POST");
    void logoutPromise.catch(() => undefined);
    await page.getByRole("button", { name: "Выйти из аккаунта", exact: true }).click();
    await diagnostics.confirmLogout(logoutScope, await logoutPromise, { sessionRowsAfter: await sessionRows() });
    await page.waitForURL((url) => url.pathname === "/");
    await page.getByRole("heading", { name: "Юридический контент с проверкой рисков и доказательств", exact: true }).waitFor();
    await diagnostics.readEvidence.settleReads(page, { timeoutMs: 30_000 });
    diagnostics.endLogout(logoutScope);
    await goto("/login");
    for (let attempt = 2; attempt <= 5; attempt++) await attemptLogin(attempt, "wrong-fixture-password", 401);
    await attemptLogin(6, password, 429, 5); // A known-correct password is still throttled.
    for (let attempt = 7; attempt <= 10; attempt++) await attemptLogin(attempt, password, 429, 5);
    await attemptLogin(11, password, 429, 10); // IP guard stops before another account increment.
    const unauthenticated = await context.request.get("/api/auth/me");
    assert.equal(unauthenticated.status(), 200);
    assert.equal((await unauthenticated.json()).user, null);
    assert(!(await context.cookies()).some((cookie) => cookie.name === "sid"));
    assert.deepEqual(issues, []);
    assert.deepEqual(externalAttempts, [], "login fixture attempted an external request");
    evidence.correctPasswordControl = true;
    evidence.accountLimit = 5; evidence.ipLimit = 10; evidence.noSessionAfterThrottle = true;
    evidence.result = "PASS";
    return evidence;
  } catch (error) { failure = error; throw error; }
  finally {
    await finalizeE2eBrowserLifecycle({ context, transport, boundary, error: failure,
      beforeClose: [() => diagnostics?.flush()],
      cleanup: [
        () => diagnostics?.flush(),
        () => loginRateLimitFixtureIngress.release(token),
        async () => { evidence.beforeCleanup = await counters(); },
        // These exact two keys were absent before this synthetic fixture. Never
        // flush Redis or remove another journey's limiter state.
        () => redis.del(ipKey, accountKey),
        async () => { evidence.ownedKeysRemaining = await redis.exists(ipKey, accountKey); assert.equal(evidence.ownedKeysRemaining, 0); },
        () => diagnostics?.stop(),
      ],
      assertDiagnostics: () => { diagnostics?.assertClean(); assert.deepEqual(issues, [], "login throttling has unexpected browser errors after cleanup"); },
      writeEvidence: async ({ error, transportAttempts }) => {
        evidence.transportAttempts = transportAttempts; evidence.issues = [...issues]; evidence.browserErrors = browserErrors?.snapshot() ?? null; evidence.authDiagnostics = diagnostics?.snapshot() ?? { phase: "setup" };
        if (error) { evidence.result = "FAIL"; evidence.error = String(error?.message ?? error); }
        if (artifactDir) await writeFile(join(artifactDir, "login-rate-limit-coverage.json"), JSON.stringify(evidence, null, 2) + "\n");
      } });
  }
}
