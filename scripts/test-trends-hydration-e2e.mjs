import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import pg from "pg";
import IORedis from "ioredis";
import { chromium } from "playwright-core";

import { migrate } from "./migrate.mjs";

const databaseUrl = String(process.env.E2E_DATABASE_URL || "").trim();
const redisUrl = String(process.env.E2E_REDIS_URL || "").trim();
if (!databaseUrl || !redisUrl) throw new Error("E2E_DATABASE_URL and E2E_REDIS_URL are required");
const databaseTarget = new URL(databaseUrl);
const redisTarget = new URL(redisUrl);
if (!["localhost", "127.0.0.1"].includes(databaseTarget.hostname)
  || databaseTarget.pathname.slice(1) !== "aurora_e2e_real") {
  throw new Error("Trends hydration E2E requires disposable local database aurora_e2e_real");
}
if (!["localhost", "127.0.0.1"].includes(redisTarget.hostname) || redisTarget.pathname !== "/15") {
  throw new Error("Trends hydration E2E requires disposable local Redis database 15");
}

const port = Number(process.env.E2E_TRENDS_PORT || 43210);
const baseUrl = `http://127.0.0.1:${port}`;
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 4 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const runtimeEnv = {
  ...process.env,
  NODE_ENV: "production",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  APP_URL: baseUrl,
  NEXT_PUBLIC_APP_URL: baseUrl,
  HOSTNAME: "127.0.0.1",
  PORT: String(port),
  NEXT_PUBLIC_AURORA_EXPERIMENTAL_ROUTES: "1",
  AURORA_RUNTIME_ROLE: "web",
  AURORA_DB_POOL_MAX_WEB: "3",
  AURORA_SENTRY_DISABLED: "1",
  NEXT_PUBLIC_AURORA_SENTRY_DISABLED: "1",
  SENTRY_AUTH_TOKEN: "",
  TOKENS_MASTER_KEY: "trends-e2e-only-master-key-with-enough-entropy-2026",
  TOKENS_KEY_ID: "1",
};

function waitForExit(process) {
  return new Promise((resolve) => process.once("exit", resolve));
}

async function waitForHealth() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("production Next.js server did not become healthy");
}

async function browserExecutable() {
  const candidates = [
    String(process.env.E2E_BROWSER_EXECUTABLE || "").trim(),
    chromium.executablePath(),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {}
  }
  throw new Error("no Chromium/Chrome executable found");
}

let server;
let browser;
try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(new URL("../db/schema.sql", import.meta.url), "utf8"));
  await migrate({ env: runtimeEnv, logger: { log() {} } });
  await redis.flushdb();

  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
    cwd: process.cwd(), env: runtimeEnv, stdio: "inherit",
  });
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
    cwd: process.cwd(), env: runtimeEnv, stdio: ["ignore", "pipe", "pipe"],
  });
  await waitForHealth();

  browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() });
  const context = await browser.newContext({ baseURL: baseUrl });
  const hydrationIssues = [];
  await context.addInitScript(() => {
    globalThis.__auroraSelectedTrendScopes = [];
    const capture = () => {
      const selected = Array.from(document.querySelectorAll('[role="tab"][aria-selected="true"]'))
        .find((tab) => ["Моя ниша", "Интернет"].includes(tab.textContent?.trim() || ""));
      const label = selected?.textContent?.trim();
      if (label && globalThis.__auroraSelectedTrendScopes.at(-1) !== label) {
        globalThis.__auroraSelectedTrendScopes.push(label);
      }
    };
    new MutationObserver(capture).observe(document, { subtree: true, childList: true, attributes: true });
    document.addEventListener("DOMContentLoaded", capture);
  });
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error" && /hydrat|server rendered|client properties/iu.test(message.text())) {
      hydrationIssues.push(message.text());
    }
  });
  page.on("pageerror", (error) => hydrationIssues.push(error.message));

  // Production browser mutations intentionally reject an HTTP APP_URL. This harness is
  // scoped to hydration, so provision a hash-only session directly in the disposable DB
  // instead of weakening the HTTPS origin contract or pretending registration was tested.
  const rawSession = "trends-hydration-e2e-session";
  const sessionHash = createHash("sha256").update(rawSession, "utf8").digest("hex");
  const userId = Number((await pool.query(
    `insert into users (email, name, onboarding_completed_at)
     values ('trends-hydration@example.test', 'Trends QA', now()) returning id`,
  )).rows[0]?.id);
  const projectId = Number((await pool.query(
    `insert into projects (name, timezone, created_by_user_id, personal_owner_user_id)
     values ('Trends hydration', 'UTC', $1, $1) returning id`,
    [userId],
  )).rows[0]?.id);
  await pool.query(
    `insert into project_members (project_id, user_id, role, status)
     values ($1, $2, 'owner', 'active')`,
    [projectId, userId],
  );
  await pool.query(
    `insert into user_project_preferences (user_id, selected_project_id) values ($1, $2)`,
    [userId, projectId],
  );
  await pool.query(
    `insert into sessions (token_hash, user_id, expires_at, device, credential_epoch)
     select $1, id, now() + interval '1 hour', 'trends-hydration-e2e', credential_epoch
       from users where id = $2`,
    [sessionHash, userId],
  );
  await context.addCookies([{
    name: "sid", value: rawSession, url: baseUrl, httpOnly: true, sameSite: "Lax", secure: false,
  }]);
  await pool.query(
    `insert into channels (user_id, project_id, network, tg_chat_id, title, handle, is_active, status)
     values ($1, $2, 'tg', -100900000301, 'Trends hydration',
             'trends_hydration', true, 'active')`,
    [userId, projectId],
  );

  // Product telemetry uses a keepalive beacon, so global network-idle is not a
  // meaningful readiness boundary. Hydration is ready when the route has loaded
  // and the selected tab from the direct URL is visible and committed in the DOM.
  await page.goto("/app/trends?scope=internet", { waitUntil: "domcontentloaded", timeout: 60_000 });
  const internetTab = page.getByRole("tab", { name: "Интернет", exact: true });
  await internetTab.waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForFunction(() => Array.from(
    document.querySelectorAll('[role="tab"][aria-selected="true"]'),
  ).some((tab) => tab.textContent?.trim() === "Интернет"), undefined, { timeout: 60_000 });
  if (await internetTab.getAttribute("aria-selected") !== "true") {
    throw new Error("Internet tab was not selected after direct navigation");
  }
  const scopes = await page.evaluate(() => globalThis.__auroraSelectedTrendScopes);
  if (scopes.includes("Моя ниша")) throw new Error(`scope changed niche → internet: ${JSON.stringify(scopes)}`);
  if (!scopes.includes("Интернет")) throw new Error(`Internet scope was never rendered: ${JSON.stringify(scopes)}`);
  if (new URL(page.url()).searchParams.get("scope") !== "internet") {
    throw new Error(`scope query was not preserved: ${page.url()}`);
  }
  if (hydrationIssues.length > 0) throw new Error(`hydration errors: ${JSON.stringify(hydrationIssues)}`);
  console.log(`[trends:hydration] production direct-open passed; selected scopes=${JSON.stringify(scopes)}`);
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode == null) {
    server.kill("SIGTERM");
    await Promise.race([waitForExit(server), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    if (server.exitCode == null) server.kill("SIGKILL");
  }
  await redis.quit();
  await pool.end();
}
