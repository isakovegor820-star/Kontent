import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { chromium } from "playwright-core";

import { MEDIA_PROMPT_POLICY } from "../src/lib/media-generation.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "../src/lib/site-analysis/questions.data.mjs";
import { migrate } from "./migrate.mjs";

const databaseUrl = String(process.env.E2E_DATABASE_URL || "").trim();
const redisUrl = String(process.env.E2E_REDIS_URL || "").trim();
if (!databaseUrl || !redisUrl) throw new Error("E2E_DATABASE_URL and E2E_REDIS_URL are required");
const dbTarget = new URL(databaseUrl);
const redisTarget = new URL(redisUrl);
if (!['127.0.0.1', 'localhost'].includes(dbTarget.hostname) || dbTarget.pathname.slice(1) !== "aurora_e2e_real") {
  throw new Error("real E2E requires disposable local database aurora_e2e_real");
}
if (!['127.0.0.1', 'localhost'].includes(redisTarget.hostname) || redisTarget.pathname !== "/15") {
  throw new Error("real E2E requires disposable local Redis database 15");
}

const webPort = Number(process.env.E2E_WEB_PORT || 43190);
const fakePort = Number(process.env.E2E_FAKE_PORT || 43191);
const baseUrl = `http://127.0.0.1:${webPort}`;
const fakeBase = `http://127.0.0.1:${fakePort}`;
const artifactDir = resolve("test-results/e2e-real");
await mkdir(artifactDir, { recursive: true });

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const children = [];
const logs = [];
let fakeServer;
let browser;
let page;
let mediaQueue;
let publishQueue;

function assert(value, message) {
  if (!value) throw new Error(message);
}

function child(label, command, args, env) {
  const subprocess = spawn(command, args, {
    cwd: globalThis.process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const [stream, name] of [[subprocess.stdout, "stdout"], [subprocess.stderr, "stderr"]]) {
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      const safe = String(chunk)
        .replace(/postgres(?:ql)?:\/\/[^\s]+/giu, "[database-url]")
        .replace(/redis:\/\/[^\s]+/giu, "[redis-url]")
        .replace(/bot\d+:[A-Za-z0-9_-]+/gu, "bot[redacted]")
        .replace(/(authorization\s*[:=]\s*)bearer\s+[^\s,}\]]+/giu, "$1Bearer [redacted]")
        .replace(/("(?:password|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token)"\s*:\s*)"[^"]*"/giu, '$1"[redacted]"');
      logs.push(`[${label}:${name}] ${safe}`);
    });
  }
  children.push(subprocess);
  return subprocess;
}

async function waitFor(check, message, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`${message}${last ? `: ${last.message}` : ""}`);
}

async function browserExecutable() {
  const requested = String(process.env.E2E_BROWSER_EXECUTABLE || "").trim();
  const candidates = [
    requested,
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
  throw new Error("Chromium executable is unavailable; run playwright-core install chromium");
}

const fakeState = {
  telegram: { photoCalls: 0, textCalls: 0 },
  ai: {
    calls: 0,
    truncatedCalls: 0,
    successfulCalls: 0,
    providerIdentityOk: true,
    identities: [],
  },
  media: {
    createCalls: 0,
    pollCalls: 0,
    jobs: new Map(),
    requestKeys: new Set(),
    promptPolicyOk: true,
  },
};

const fakePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4kAAAAAASUVORK5CYII=";

function fakeProvider() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url === "/v1/models") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [
        { id: "nano-banana-2", endpoint: "/v1/images/generations", premium: false },
        { id: "gpt-4o-mini" },
      ] }));
      return;
    }
    if (req.url === "/v1/usage") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ plan: "Ultra" }));
      return;
    }
    if (req.url === "/v1/chat/completions") {
      fakeState.ai.calls += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const text = JSON.stringify(body?.messages || []);
      const truncate = text.includes("E2E_TRUNCATE");
      const successful = text.includes("Короткая редакционная заметка без новых фактических утверждений");
      const libraryComposer = text.includes("E2E_LIBRARY_REFERENCE");
      if (successful) fakeState.ai.successfulCalls += 1;
      if (truncate || successful) {
        const providerKey = String(req.headers["idempotency-key"] || "");
        const providerRequestId = String(req.headers["x-request-id"] || "");
        fakeState.ai.providerIdentityOk = fakeState.ai.providerIdentityOk
          && /^[a-f0-9]{64}(?::reasoning-(?:minimal|none))?$/u.test(providerKey)
          && /^[0-9a-f]{8}-[0-9a-f-]{27,}$/iu.test(providerRequestId);
        fakeState.ai.identities.push({
          kind: truncate ? "truncated" : "successful",
          providerKey,
          requestId: providerRequestId,
        });
      }
      res.statusCode = 200;
      res.setHeader("content-type", "text/event-stream");
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Безопасный тестовый текст." } }] })}\n\n`);
      if (libraryComposer) await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
      if (!truncate) res.write("data: [DONE]\n\n");
      else fakeState.ai.truncatedCalls += 1;
      res.end();
      return;
    }
    if (req.url === "/v1/images/generations" && req.method === "POST") {
      fakeState.media.createCalls += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const requestKey = String(req.headers["idempotency-key"] || "");
      const requestId = String(req.headers["x-request-id"] || "");
      const prompt = String(body?.prompt || "");
      fakeState.media.promptPolicyOk = fakeState.media.promptPolicyOk
        && /^aurora-media-[0-9a-f-]{36}$/iu.test(requestKey)
        && requestKey === `aurora-media-${requestId}`
        && prompt.includes(`[${MEDIA_PROMPT_POLICY.id} v${MEDIA_PROMPT_POLICY.version}]`)
        && prompt.includes("ТЕКСТ В КАДРЕ: не добавляй")
        && prompt.includes("не придумывай логотипы")
        && typeof body?.negative_prompt === "string"
        && body.negative_prompt.includes("invented logos");
      fakeState.media.requestKeys.add(requestKey);
      const providerJobId = fakeState.media.jobs.get(requestKey) || `navy-e2e-${fakeState.media.jobs.size + 1}`;
      fakeState.media.jobs.set(requestKey, providerJobId);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ id: providerJobId, status: "queued" }));
      return;
    }
    if (/^\/v1\/images\/generations\/navy-e2e-\d+$/u.test(req.url || "") && req.method === "GET") {
      fakeState.media.pollCalls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: String(req.url).split("/").at(-1),
        status: "completed",
        data: [{ url: `data:image/png;base64,${fakePng}` }],
      }));
      return;
    }
    if (/\/bot[^/]+\/sendPhoto$/u.test(req.url || "")) {
      fakeState.telegram.photoCalls += 1;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 701 } }));
      return;
    }
    if (/\/bot[^/]+\/sendMessage$/u.test(req.url || "")) {
      fakeState.telegram.textCalls += 1;
      res.setHeader("content-type", "application/json");
      if (fakeState.telegram.textCalls === 1) {
        res.end(JSON.stringify({
          ok: false,
          error_code: 429,
          description: "controlled rate limit",
          parameters: { retry_after: 1 },
        }));
      } else {
        res.end(JSON.stringify({ ok: true, result: { message_id: 702 } }));
      }
      return;
    }
    if (/\/bot[^/]+\/(?:setMyCommands|getUpdates)$/u.test(req.url || "")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
}

const runtimeEnv = {
  ...process.env,
  NODE_ENV: "development",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  APP_URL: baseUrl,
  NEXT_PUBLIC_APP_URL: baseUrl,
  HOSTNAME: "127.0.0.1",
  PORT: String(webPort),
  TG_BOT_TOKEN: "9000000000:e2e-fake-token-not-live",
  TG_BOT_USERNAME: "aurora_e2e_bot",
  TG_API_URL: fakeBase,
  OPENAI_API_KEY: "e2e-fake-openai-key",
  OPENAI_API_URL: `${fakeBase}/v1`,
  AI_API_KEY: "",
  AI_API_URL: `${fakeBase}/v1`,
  AI_SERVICE_ENGINE: "openai",
  AI_SEMANTIC_ENGINE: "",
  AI_FALLBACK_ENGINES: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  OLLAMA_URL: fakeBase,
  NAVYAI_API_KEY: "e2e-fake-navy-key",
  NAVYAI_API_URL: `${fakeBase}/v1`,
  TOKENS_MASTER_KEY: "e2e-only-master-key-with-enough-entropy-2026",
  TOKENS_KEY_ID: "1",
  AURORA_WORKER_MODE: "full",
  AURORA_NEXT_DIST_DIR: ".next-e2e-real",
  TG_WEBHOOK_URL: `${baseUrl}/api/e2e-disabled-webhook`,
  RETRY_DELAYS_MS: "500,500,500",
  PUBLICATION_OVERDUE_GRACE_MS: "300000",
};

async function assertTouch(locator, label) {
  const box = await locator.boundingBox();
  assert(box && box.width >= 44 && box.height >= 44, `${label} touch target is below 44x44`);
}

try {
  await pool.query("drop schema public cascade");
  await pool.query("create schema public");
  await pool.query(await readFile(resolve("db/schema.sql"), "utf8"));
  await migrate({ env: { ...runtimeEnv, DATABASE_URL: databaseUrl }, logger: { log() {} } });
  await redis.flushdb();

  fakeServer = fakeProvider();
  await new Promise((resolve, reject) => {
    fakeServer.once("error", reject);
    fakeServer.listen(fakePort, "127.0.0.1", resolve);
  });
  // The supported local runtime is one command and always includes every BullMQ worker.
  // This deliberately exercises scripts/dev.mjs instead of a web-only or hand-built pair.
  child(
    "runtime",
    process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "-H", "127.0.0.1", "-p", String(webPort)],
    runtimeEnv,
  );

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/readiness`);
    const body = await response.json();
    return response.status === 200
      && body.schemaReady
      && body.publicationReady
      && body.checks?.redis === "up"
      && body.checks?.publicationWorker === "up";
  }, "full development readiness did not become ready", 60_000);

  mediaQueue = new Queue("media-generation", { connection: redis });
  await waitFor(
    async () => (await mediaQueue.getWorkersCount()) > 0,
    "full runtime did not expose a media worker",
    20_000,
  );

  browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() });
  const context = await browser.newContext({ baseURL: baseUrl, viewport: { width: 390, height: 844 } });
  page = await context.newPage();

  const authenticatedRequest = (path, { method = "GET", headers = {}, data } = {}) => page.evaluate(
    async ({ path, method, headers, data }) => {
      const response = await fetch(path, {
        method,
        headers: { ...headers, ...(data === undefined ? {} : { "content-type": "application/json" }) },
        body: data === undefined ? undefined : JSON.stringify(data),
        cache: "no-store",
      });
      let text = "";
      try { text = await response.text(); } catch {}
      return {
        status: response.status,
        ok: response.ok,
        text,
        headers: {
          contentType: response.headers.get("content-type"),
          requestId: response.headers.get("x-ai-request-id") || response.headers.get("x-request-id"),
          replayed: response.headers.get("x-ai-replayed"),
          acknowledged: response.headers.get("x-ai-acknowledged"),
        },
      };
    },
    { path, method, headers, data },
  );

  await page.goto("/register");
  await page.waitForLoadState("domcontentloaded");
  await assertTouch(page.locator('input[type="email"]').first(), "auth email");
  await assertTouch(page.locator('input[type="password"]').first(), "auth password");
  await assertTouch(page.locator('button[type="submit"]').first(), "auth submit");
  await assertTouch(page.getByRole("tab", { name: "Регистрация", exact: true }), "auth registration tab");
  await assertTouch(page.getByRole("tab", { name: "Вход", exact: true }), "auth login tab");
  await assertTouch(page.getByRole("button", { name: "Войти", exact: true }), "auth secondary login");

  const registration = await context.request.post("/api/auth/register", {
    headers: { origin: baseUrl },
    data: { email: "qa-e2e@aurora.test", password: "qa-password-2026", name: "QA E2E" },
  });
  assert(registration.ok(), `QA registration failed with ${registration.status()}`);
  const userId = Number((await pool.query(
    "select id from users where email = 'qa-e2e@aurora.test'",
  )).rows[0].id);
  await pool.query("update users set onboarding_completed_at = now(), ai_engine = 'openai' where id = $1", [userId]);
  const channels = (await pool.query(
    `insert into channels (user_id, network, tg_chat_id, title, handle, is_active)
     values ($1, 'tg', -100900000001, 'Технологии и право QA', 'aurora_legal_qa', true),
            ($1, 'tg', -100900000002, 'Изолированный канал B', 'aurora_isolated_b', true)
     returning id`,
    [userId],
  )).rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  await pool.query(
    `insert into content_brief
       (user_id, channel_id, niche, audience, rubrics, formats, author_role, goal, taboo, ready, source)
     values ($1, $2, 'Правовые технологии и ИИ', 'юристы и legal operations', array['право','ИИ'],
             array['Текст','Фото'], 'Редактор legal-tech продукта',
             'объяснять проверяемые изменения', 'никаких обещаний результата', true, 'manual')`,
    [userId, channels[0]],
  );
  const draftId = Number((await pool.query(
    `insert into drafts (user_id, text, scheduled_at, origin, client_key)
     values ($1, 'Серверная версия', now() + interval '2 hour', 'manual', 'draft_e2e-durable-1234567890') returning id`,
    [userId],
  )).rows[0].id);
  await pool.query("insert into draft_destinations (draft_id, channel_id) values ($1, $2)", [draftId, channels[0]]);

  await page.route(`**/api/drafts/${draftId}`, async (route) => {
    if (route.request().method() === "PATCH") await route.abort("internetdisconnected");
    else await route.continue();
  });
  await page.goto(`/app/composer?draft=${draftId}`);
  const composerText = page.locator("#composer-text");
  await composerText.waitFor();
  await composerText.fill("Локальная несинхронизированная версия E2E");
  await page.getByText("Нет сети: изменения сохранены в браузере").waitFor({ timeout: 8_000 });
  await page.reload();
  await composerText.waitFor();
  assert(await composerText.inputValue() === "Локальная несинхронизированная версия E2E", "hard reload lost pending draft text");
  await page.unroute(`**/api/drafts/${draftId}`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(async () => (await pool.query("select text from drafts where id = $1", [draftId])).rows[0]?.text === "Локальная несинхронизированная версия E2E", "pending draft did not synchronize", 12_000);
  assert(Number((await pool.query("select count(*)::int as n from drafts where id = $1", [draftId])).rows[0].n) === 1, "draft sync created a duplicate");
  await assertTouch(page.getByRole("button", { name: /Сохран/ }).first(), "composer save");
  // 1280px desktop at browser zoom 200% exposes a 640 CSS-pixel layout viewport.
  // Changing the viewport (unlike CSS zoom) also re-evaluates the responsive breakpoints.
  await page.setViewportSize({ width: 640, height: 450 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), "Composer overflows at desktop 200% zoom equivalent");
  await page.setViewportSize({ width: 390, height: 844 });

  for (const route of ["/app/calendar", `/app/composer?draft=${draftId}`, "/app/studio", "/app/autopilot"]) {
    await page.goto(route);
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(350);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), `${route} has mobile horizontal overflow`);
  }

  const mediaRequestKey = "e2e_media_terminal_1";
  const mediaCountBefore = Number((await pool.query(
    "select count(*)::int as n from media_generations where user_id = $1",
    [userId],
  )).rows[0].n);
  const unauthenticatedMedia = await fetch(`${baseUrl}/api/media/generations`, {
    method: "POST",
    headers: {
      origin: baseUrl,
      "content-type": "application/json",
      "idempotency-key": "e2e_media_unauthenticated_1",
    },
    body: JSON.stringify({
      kind: "image",
      prompt: "Этот запрос не должен дойти до провайдера",
      model: "nano-banana-2",
      aspectRatio: "1:1",
      quality: "medium",
      style: "editorial",
    }),
  });
  assert(unauthenticatedMedia.status === 401, "unauthenticated media request did not fail closed");
  assert(fakeState.media.createCalls === 0, "unauthenticated media request reached NavyAI");

  let mediaResponse;
  await waitFor(async () => {
    mediaResponse = await authenticatedRequest("/api/media/generations", {
      method: "POST",
      headers: { "idempotency-key": mediaRequestKey },
      data: {
        kind: "image",
        prompt: "Редакционная иллюстрация о правовой технологии",
        sourceText: "Проверяемое изменение в праве и его практическое значение для бизнеса.",
        exactText: "",
        negativePrompt: "без водяных знаков",
        model: "nano-banana-2",
        aspectRatio: "1:1",
        quality: "medium",
        style: "editorial",
        channelId: channels[0],
        niche: "кофе и обжарка",
        tone: "кофейный блог",
      },
    });
    if (mediaResponse.status === 202) return true;
    const body = JSON.parse(mediaResponse.text || "{}");
    if (mediaResponse.status === 503 && body.error === "worker_unavailable") return false;
    throw new Error(`unexpected media response ${mediaResponse.status}:${body.error || "unknown"}`);
  }, "media worker did not accept an idempotent terminal request", 20_000);
  assert(mediaResponse.status === 202, `media terminal request failed with ${mediaResponse.status}`);
  const mediaAccepted = JSON.parse(mediaResponse.text);
  const mediaGenerationId = Number(mediaAccepted.generation?.id);
  assert(Number.isSafeInteger(mediaGenerationId) && mediaGenerationId > 0, "media API omitted generation id");
  assert(
    mediaAccepted.requestId && mediaAccepted.requestId === mediaAccepted.generation?.requestId,
    "media API correlation id diverged from the durable generation",
  );
  const observedMediaStatuses = new Set([mediaAccepted.generation?.status]);

  // The first status read is deliberately immediate; later checks use the bounded poll loop.
  const firstMediaPoll = await authenticatedRequest(`/api/media/generations/${mediaGenerationId}`);
  assert(firstMediaPoll.ok, `first media poll failed with ${firstMediaPoll.status}`);
  observedMediaStatuses.add(JSON.parse(firstMediaPoll.text).generation?.status);
  let mediaTerminal;
  try {
    mediaTerminal = await waitFor(async () => {
      const polled = await authenticatedRequest(`/api/media/generations/${mediaGenerationId}`);
      if (!polled.ok) return null;
      const body = JSON.parse(polled.text);
      observedMediaStatuses.add(body.generation?.status);
      if (body.generation?.status === "failed") {
        throw new Error(`media generation failed closed with ${body.generation.errorCode || "unknown"}`);
      }
      return body.generation?.status === "ready" ? body : null;
    }, "media generation did not reach ready", 20_000);
  } catch (error) {
    const diagnostic = (await pool.query(
      `select g.status, g.queue_confirmed_at is not null as queue_confirmed,
              u.status as usage_status
         from media_generations g
         left join ai_usage u on u.id = g.ai_usage_reservation_id
        where g.id = $1 and g.user_id = $2`,
      [mediaGenerationId, userId],
    )).rows[0] || null;
    const isolatedJob = await mediaQueue.getJob(`media-${mediaGenerationId}`);
    const isolatedJobState = isolatedJob ? await isolatedJob.getState() : "missing";
    throw new Error(`${error.message}; diagnostic=${JSON.stringify({
      ...diagnostic,
      isolatedWorkerCount: await mediaQueue.getWorkersCount(),
      isolatedJobState,
      providerCreateCalls: fakeState.media.createCalls,
    })}`);
  }
  assert(mediaTerminal.requestId === mediaAccepted.requestId, "media poll returned a different correlation id");
  assert(mediaTerminal.generation?.assetId, "ready media generation has no durable asset");

  const mediaRow = (await pool.query(
    `select g.status, g.niche, g.tone, g.request_id, g.request_key,
            g.provider_request_key, g.output_asset_id, g.ai_usage_reservation_id,
            u.status as usage_status
       from media_generations g
       join ai_usage u on u.id = g.ai_usage_reservation_id
      where g.id = $1 and g.user_id = $2`,
    [mediaGenerationId, userId],
  )).rows[0];
  assert(mediaRow?.status === "ready" && mediaRow.usage_status === "committed", "ready media did not atomically commit quota");
  assert(String(mediaRow.request_id) === mediaAccepted.requestId, "persisted media request id changed");
  assert(mediaRow.request_key === mediaRequestKey, "persisted media idempotency key changed");
  assert(mediaRow.provider_request_key === `aurora-media-${mediaAccepted.requestId}`, "provider idempotency key is not correlation-bound");
  const mediaContext = mediaRow;
  assert(mediaContext.niche === "Правовые технологии и ИИ", "client coffee niche reached real media generation");
  assert(!JSON.stringify(mediaContext).toLocaleLowerCase("ru").includes("коф"), "coffee context leaked into persisted provider input");
  assert(fakeState.media.createCalls === 1, "one logical media request did not make exactly one provider create call");
  assert(fakeState.media.pollCalls >= 1, "asynchronous NavyAI job was never polled");
  assert(fakeState.media.jobs.size === 1 && fakeState.media.requestKeys.size === 1, "provider idempotency did not collapse one logical job");
  assert(fakeState.media.promptPolicyOk, "provider payload missed the safe versioned media prompt policy");

  const storedAsset = await context.request.get(mediaTerminal.generation.assetUrl);
  assert(storedAsset.status() === 200, `stored media asset failed with ${storedAsset.status()}`);
  assert(storedAsset.headers()["content-type"] === "image/png", "stored media asset has an unexpected type");
  assert((await storedAsset.body()).byteLength > 32, "stored media asset is empty");

  const mediaJobBeforeReplay = await mediaQueue.getJob(`media-${mediaGenerationId}`);
  assert(mediaJobBeforeReplay, "durable media queue job is missing after completion");
  const queueIdentityBeforeReplay = JSON.stringify({
    timestamp: mediaJobBeforeReplay.timestamp,
    processedOn: mediaJobBeforeReplay.processedOn,
    finishedOn: mediaJobBeforeReplay.finishedOn,
    attemptsMade: mediaJobBeforeReplay.attemptsMade,
  });
  const mediaReplay = await authenticatedRequest("/api/media/generations", {
    method: "POST",
    headers: { "idempotency-key": mediaRequestKey },
    data: {
      kind: "image",
      prompt: "Изменённый клиентский текст не должен создать второй платный запрос",
      model: "nano-banana-2",
      aspectRatio: "16:9",
      quality: "low",
      style: "minimal",
      channelId: channels[1],
    },
  });
  assert(mediaReplay.status === 200, `terminal media replay failed with ${mediaReplay.status}`);
  const mediaReplayBody = JSON.parse(mediaReplay.text);
  assert(mediaReplayBody.replayed === true, "terminal media replay was not marked as replayed");
  assert(Number(mediaReplayBody.generation?.id) === mediaGenerationId, "media replay returned another generation");
  assert(mediaReplayBody.requestId === mediaAccepted.requestId, "media replay lost the original correlation id");
  const mediaJobAfterReplay = await mediaQueue.getJob(`media-${mediaGenerationId}`);
  const queueIdentityAfterReplay = JSON.stringify({
    timestamp: mediaJobAfterReplay?.timestamp,
    processedOn: mediaJobAfterReplay?.processedOn,
    finishedOn: mediaJobAfterReplay?.finishedOn,
    attemptsMade: mediaJobAfterReplay?.attemptsMade,
  });
  assert(queueIdentityAfterReplay === queueIdentityBeforeReplay, "media replay enqueued or reprocessed the BullMQ job");
  assert(fakeState.media.createCalls === 1, "media replay called the provider twice");
  assert(Number((await pool.query(
    "select count(*)::int as n from media_generations where user_id = $1",
    [userId],
  )).rows[0].n) === mediaCountBefore + 1, "media replay created a duplicate generation row");
  assert(Number((await pool.query(
    "select count(*)::int as n from ai_usage where user_id = $1 and reservation_key = $2 and status = 'committed'",
    [userId, `media:${mediaRequestKey}`],
  )).rows[0].n) === 1, "media replay duplicated or released the committed quota row");

  const competitorIds = (await pool.query(
    `insert into competitors (user_id, channel_id, network, handle, title, status, collected_at)
     values ($1, $2, 'tg', 'qa_competitor_a', 'QA A', 'ready', now()),
            ($1, $3, 'tg', 'qa_competitor_b', 'QA B', 'ready', now()) returning id`,
    [userId, channels[0], channels[1]],
  )).rows.map((row) => Number(row.id)).sort((a, b) => a - b);
  const [refreshA, refreshB] = await page.evaluate(async ({ channelId }) => Promise.all(
    [0, 1].map(async () => {
      const response = await fetch(`/api/trends?scope=niche&channel=${channelId}`, {
        method: "POST",
        headers: { "idempotency-key": "e2e_trend_refresh_1" },
      });
      return response.status;
    }),
  ), { channelId: channels[0] });
  assert([200, 202].includes(refreshA) && [200, 202].includes(refreshB), "parallel Trends refresh returned an unexpected status");
  assert(Number((await pool.query("select count(*)::int as n from trend_refresh_operations where user_id = $1", [userId])).rows[0].n) === 1, "double Trends refresh created multiple operations");
  assert((await pool.query("select status from competitors where id = $1", [competitorIds[1]])).rows[0].status === "ready", "channel A refresh mutated channel B");

  const libraryReferenceText =
    `E2E_LIBRARY_REFERENCE: договор и проверяемые условия. ${"Полный абзац нужен для независимого раскрытия карточки. ".repeat(18)}`;
  const libraryReferenceId = Number((await pool.query(
    `insert into competitor_posts
       (competitor_id, tg_msg_id, text, views, reactions, posted_at, media, is_hit, hit_ratio)
     values ($1, 91001, $2, 8000, 120, now() - interval '2 hour', 'photo', true, 6.25)
     returning id`,
    [competitorIds[0], libraryReferenceText],
  )).rows[0].id);

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/app/library?channel=${channels[0]}`);
  await page.getByRole("heading", { name: "Идеи и примеры", exact: true }).waitFor();
  const desktopSidebar = page.locator('aside:visible nav[aria-label="Разделы платформы"]');
  const desktopLibraryActive = desktopSidebar.locator('a[aria-current="page"]');
  await waitFor(
    async () => (await desktopLibraryActive.count()) === 1,
    "desktop sidebar did not settle on one active item",
    5_000,
  );
  assert((await desktopLibraryActive.textContent())?.includes("Идеи и примеры"), "desktop Library item is not active");
  assert(new URL(page.url()).searchParams.get("channel") === String(channels[0]), "Library lost selected channel in URL");

  const libraryContentId = `library-registry-text-reference-${libraryReferenceId}`;
  const libraryText = page.locator(`#${libraryContentId}`);
  await libraryText.waitFor({ timeout: 10_000 });
  const expand = page.locator(`button[aria-controls="${libraryContentId}"]`);
  const libraryUrlBeforeExpand = page.url();
  assert(await expand.getAttribute("aria-expanded") === "false", "closed Library card has wrong aria-expanded");
  assert((await libraryText.getAttribute("class"))?.includes("line-clamp-4"), "closed Library card is not clamped");
  await expand.click();
  assert(page.url() === libraryUrlBeforeExpand, "Library expansion navigated away from the card");
  assert(await expand.getAttribute("aria-expanded") === "true", "expanded Library card has wrong aria-expanded");
  assert(!(await libraryText.getAttribute("class"))?.includes("line-clamp-4"), "expanded Library card stayed clamped");
  await expand.click();
  assert(await expand.getAttribute("aria-expanded") === "false", "Library card did not collapse independently");

  const registrySearch = page.getByPlaceholder("Поиск по тексту, источнику или каналу…");
  await registrySearch.fill("E2E_LIBRARY_REFERENCE");
  await page.waitForTimeout(450);
  await libraryText.waitFor();
  await page.locator("summary").filter({ hasText: "Все фильтры" }).click();
  await page.getByRole("button", { name: "Экспорт текущего среза", exact: true }).click();
  await page.getByText(/Один срез данных · 1 запис/u).waitFor({ timeout: 10_000 });
  const exportLinks = page.locator('a[download][href^="/api/library/exports/"]');
  assert(await exportLinks.count() === 6, "filtered Library export did not expose six formats");
  const exportHrefs = await exportLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")));
  const parsedExports = exportHrefs.map((href) => new URL(href, baseUrl));
  const exportIds = new Set(parsedExports.map((url) => url.pathname.split("/").at(-1)));
  const exportFormats = new Set(parsedExports.map((url) => url.searchParams.get("format")));
  assert(exportIds.size === 1, "six export links do not share one immutable snapshot id");
  assert(
    JSON.stringify([...exportFormats].sort()) === JSON.stringify(["csv", "html", "json", "markdown", "pdf", "xlsx"]),
    "Library export format set is incomplete",
  );
  for (const exportUrl of parsedExports) {
    const downloaded = await context.request.get(`${exportUrl.pathname}${exportUrl.search}`);
    assert(downloaded.status() === 200, `Library ${exportUrl.searchParams.get("format")} export failed`);
    assert(downloaded.headers()["cache-control"] === "private, no-store", "Library export is cacheable");
    assert(downloaded.headers()["x-content-type-options"] === "nosniff", "Library export can be MIME-sniffed");
    const bytes = await downloaded.body();
    const format = exportUrl.searchParams.get("format");
    if (format === "csv") assert(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), "CSV has no UTF-8 BOM");
    if (format === "xlsx") assert(bytes.subarray(0, 2).toString() === "PK", "XLSX is not a ZIP workbook");
    if (format === "pdf") assert(bytes.subarray(0, 4).toString() === "%PDF", "PDF export is invalid");
    if (format === "json") assert(JSON.parse(bytes.toString("utf8")).items?.length === 1, "JSON export diverged from filtered snapshot");
  }
  const exportSnapshotId = Number([...exportIds][0]);
  const exportSnapshot = (await pool.query(
    "select snapshot from library_export_snapshots where id = $1 and user_id = $2",
    [exportSnapshotId, userId],
  )).rows[0]?.snapshot;
  assert(exportSnapshot?.activeFilters?.q === "E2E_LIBRARY_REFERENCE", "snapshot lost the active search filter");
  assert(exportSnapshot?.items?.length === 1, "snapshot was rebuilt with a different registry");
  assert(exportSnapshot.items[0].id === `reference:${libraryReferenceId}`, "snapshot exported another Library item");

  const originalLink = page.getByRole("link", { name: "Открыть оригинал", exact: true });
  assert((await originalLink.getAttribute("href")) === "https://t.me/qa_competitor_a/91001", "original action lost source URL");
  assert(await originalLink.getAttribute("target") === "_blank", "original action does not stay external");

  await page.getByRole("button", { name: "Создать публикацию", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/app/studio"
    && /^\d+$/u.test(url.searchParams.get("draft") || "")
    && url.searchParams.get("intent") === "create");
  const createStudioUrl = new URL(page.url());
  assert([...createStudioUrl.searchParams.keys()].join(",") === "draft,intent", "Library leaked text or channel through Studio URL");
  const libraryReferenceDraftId = Number(createStudioUrl.searchParams.get("draft"));
  const referenceDraft = (await pool.query(
    `select d.text, d.origin, d.source_ref, destination.channel_id
       from drafts d
       join draft_destinations destination on destination.draft_id = d.id
      where d.id = $1 and d.user_id = $2`,
    [libraryReferenceDraftId, userId],
  )).rows[0];
  assert(referenceDraft?.text === libraryReferenceText, "Studio reference draft lost the full Library text");
  assert(referenceDraft?.origin === "competitor", "Studio reference draft lost provenance");
  assert(Number(referenceDraft?.channel_id) === channels[0], "Studio reference draft lost selected channel id");
  assert(String(referenceDraft?.source_ref?.id) === String(competitorIds[0]), "Studio reference draft lost source id");
  // A reload while the provider is running must replay the same paid operation. The
  // create intent remains until the terminal result has been persisted as a server draft.
  await page.reload();
  await page.waitForURL((url) => url.pathname === "/app/composer" && /^\d+$/u.test(url.searchParams.get("draft") || ""));
  const composerDraftUrl = new URL(page.url());
  assert([...composerDraftUrl.searchParams.keys()].join(",") === "draft", "Studio leaked reference content through Composer URL");
  const libraryComposerDraftId = Number(composerDraftUrl.searchParams.get("draft"));
  const libraryComposerText = page.locator("#composer-text");
  await libraryComposerText.waitFor();
  assert(await libraryComposerText.inputValue() === "Безопасный тестовый текст.", "Composer did not hydrate the terminal Studio result");
  const generatedDraft = (await pool.query(
    "select text, origin, source_ref from drafts where id = $1 and user_id = $2",
    [libraryComposerDraftId, userId],
  )).rows[0];
  assert(generatedDraft?.text === "Безопасный тестовый текст." && generatedDraft?.origin === "ai", "Studio result was not persisted as an AI draft");
  assert(String(generatedDraft?.source_ref?.id) === String(competitorIds[0]), "generated post lost reference provenance");
  const composerActive = desktopSidebar.locator('a[aria-current="page"]');
  assert((await composerActive.textContent())?.includes("Календарь"), "Composer alias did not activate desktop Calendar");

  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/studio" && url.searchParams.get("draft") === String(libraryReferenceDraftId));
  assert(!new URL(page.url()).searchParams.has("intent"), "browser Back restarted the completed paid generation");
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Студия"), "browser Back lost active Studio item");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("channel") === String(channels[0]));
  await page.getByRole("button", { name: "Обсудить с Авророй", exact: true }).waitFor();
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Идеи и примеры"), "browser Back lost active Library item");
  await page.getByRole("button", { name: "Обсудить с Авророй", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/app/studio" && /^\d+$/u.test(url.searchParams.get("draft") || ""));
  const studioDraftUrl = new URL(page.url());
  assert([...studioDraftUrl.searchParams.keys()].join(",") === "draft,intent", "Library leaked content through Studio URL");
  assert(studioDraftUrl.searchParams.get("intent") === "discuss", "Discuss action lost its Studio intent");
  const studioDraftId = Number(studioDraftUrl.searchParams.get("draft"));
  const studioDestination = (await pool.query(
    `select destination.channel_id
       from drafts d join draft_destinations destination on destination.draft_id = d.id
      where d.id = $1 and d.user_id = $2`,
    [studioDraftId, userId],
  )).rows[0];
  assert(Number(studioDestination?.channel_id) === channels[0], "Studio draft lost selected channel id");
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Студия"), "Studio action did not activate desktop Studio");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("channel") === String(channels[0]));

  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), "Library has mobile horizontal overflow");
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  const mobileDrawer = page.getByRole("dialog", { name: "Меню платформы" });
  const mobileDrawerActive = mobileDrawer.locator('a[aria-current="page"]');
  assert((await mobileDrawerActive.textContent())?.includes("Идеи и примеры"), "mobile drawer lost active Library item");
  await mobileDrawer.getByRole("button", { name: "Закрыть меню", exact: true }).click();
  await page.locator('nav[aria-label="Основные разделы"]').getByRole("link", { name: "Студия", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/app/studio");
  assert((await page.locator('nav[aria-label="Основные разделы"] a[aria-current="page"]').textContent())?.includes("Студия"), "mobile Studio item is not active");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("channel") === String(channels[0]));
  await page.goto(`/app/trends?channel=${channels[0]}`);
  assert((await page.locator('nav[aria-label="Основные разделы"] a[aria-current="page"]').textContent())?.includes("Разведка"), "mobile Trends alias did not activate Recon");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("channel") === String(channels[0]));

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/settings?section=general");
  await page.getByRole("heading", { name: "Профиль и исходный бриф", exact: true }).waitFor({ timeout: 10_000 });
  await page.getByRole("textbox", { name: /^Имя/u }).fill("Анна E2E");
  await page.getByRole("textbox", { name: /^Ниша/u }).fill("Юридическая безопасность бизнеса");
  await page.getByRole("textbox", { name: /^Аудитория/u }).fill("Владельцы компаний и legal operations");
  await page.getByLabel("Цель", { exact: true }).fill("Объяснять проверяемые изменения без обещаний");
  await page.getByLabel("Роль автора", { exact: true }).fill("Управляющий партнёр и автор");
  await page.getByLabel("Рубрики", { exact: true }).fill("Практика, Разборы");
  await page.getByLabel("Форматы", { exact: true }).fill("Текст, Видео");
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Сохранить профиль", exact: true }).click();
  await page.getByText("Профиль и исходный бриф сохранены.", { exact: true }).waitFor({ timeout: 10_000 });
  const persistedProfile = (await pool.query(
    `select u.name, brief.niche, brief.audience, brief.goal, brief.rubrics,
            brief.formats, brief.author_role, brief.source
       from users u join content_brief brief on brief.user_id = u.id
      where u.id = $1 and brief.channel_id = $2`,
    [userId, channels[0]],
  )).rows[0];
  assert(persistedProfile?.name === "Анна E2E", "profile name was not persisted");
  assert(persistedProfile?.niche === "Юридическая безопасность бизнеса", "profile niche was not persisted in content_brief");
  assert(JSON.stringify(persistedProfile?.formats) === JSON.stringify(["Текст", "Видео"]), "profile formats were not persisted");
  assert(persistedProfile?.author_role === "Управляющий партнёр и автор", "profile author role was not persisted");
  assert(persistedProfile?.source === "manual", "profile edit did not update the existing brief authority");
  await page.reload();
  await page.getByRole("heading", { name: "Профиль и исходный бриф", exact: true }).waitFor({ timeout: 10_000 });
  assert(await page.getByRole("textbox", { name: /^Имя/u }).inputValue() === "Анна E2E", "profile name did not survive reload");
  assert(await page.getByRole("textbox", { name: /^Ниша/u }).inputValue() === "Юридическая безопасность бизнеса", "profile brief did not survive reload");
  assert(await page.getByLabel("Форматы", { exact: true }).inputValue() === "Текст, Видео", "profile formats did not survive reload");
  const savedGoal = await page.getByLabel("Цель", { exact: true }).inputValue();
  await page.getByLabel("Цель", { exact: true }).fill(`${savedGoal} — черновик`);
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor();
  await page.getByLabel("Цель", { exact: true }).fill(savedGoal);
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor({ state: "detached" });
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Настройка Авроры"), "desktop Settings item is not active");

  const siteEvidenceId = "evidence:e2e-owned-about";
  const siteSourceId = "source:e2e-owned-about";
  const siteAnswers = SITE_INTERVIEW_QUESTIONS.map((question, index) => {
    if (index === 0) {
      return {
        questionId: question.id,
        status: "answered",
        shortAnswer: "Организация публично называет себя Aurora QA.",
        explanation: "Название подтверждено собственной страницей организации.",
        facts: [{ statement: "Публичное название — Aurora QA.", evidenceIds: [siteEvidenceId] }],
        evidenceIds: [siteEvidenceId],
        confidence: "high",
        contradictions: [],
        gaps: [],
        requiredIntegrations: [],
        recommendationHooks: [{
          kind: "organization-profile",
          rationale: "Использовать подтверждённое название в профилях социальных каналов.",
          entityIds: ["entity:e2e-organization"],
          evidenceIds: [siteEvidenceId],
        }],
      };
    }
    if (index === 1) {
      return {
        questionId: question.id,
        status: "hypothesis",
        shortAnswer: "Есть косвенный сигнал о фокусе на правовых технологиях.",
        explanation: "Сигнал требует подтверждения дополнительными страницами.",
        facts: [],
        evidenceIds: [siteEvidenceId],
        confidence: "low",
        contradictions: [],
        gaps: ["Нужна отдельная страница позиционирования."],
        requiredIntegrations: [],
        recommendationHooks: [],
      };
    }
    if (index === 2) {
      return {
        questionId: question.id,
        status: "conflicting",
        shortAnswer: "Описание направлений расходится между разделами.",
        explanation: "Сохранены обе версии без выбора удобной трактовки.",
        facts: [],
        evidenceIds: [siteEvidenceId],
        confidence: "low",
        contradictions: [{ description: "Главная и раздел «О нас» задают разные акценты.", evidenceIds: [siteEvidenceId] }],
        gaps: ["Нужна актуальная редакционная позиция организации."],
        requiredIntegrations: [],
        recommendationHooks: [],
      };
    }
    return {
      questionId: question.id,
      status: "insufficient_data",
      shortAnswer: "Недостаточно проверяемых публичных данных.",
      explanation: "Отсутствие данных не трактуется как отсутствие факта.",
      facts: [],
      evidenceIds: [],
      confidence: "none",
      contradictions: [],
      gaps: ["Нужен дополнительный публичный источник."],
      requiredIntegrations: index % 7 === 0 ? ["Google Search Console"] : [],
      recommendationHooks: [],
    };
  });
  const siteSnapshotHash = `sha256:${"b".repeat(64)}`;
  const siteReport = {
    policyVersion: "site-crawler-v1",
    inventory: [{ url: "https://example.com/about", status: 200, title: "О компании", words: 120, schemaTypes: ["Organization"] }],
    limitations: ["Проверены только публичные страницы подтверждённого домена."],
    marketingPlan: { measurement: [{ kpi: "Органические переходы", sourceNeeded: "Google Search Console", confidence: "none" }] },
    snapshot: {
      version: "site-osint-snapshot-v1",
      snapshotHash: siteSnapshotHash,
      coverage: { mode: "site_only", limitations: ["external_osint_not_enabled"] },
      sources: [{
        id: siteSourceId,
        kind: "owned_page",
        url: "https://example.com/about",
        title: "О компании",
        pageType: "about",
        checkedAt: "2026-08-05T12:00:00.000Z",
        publishedAt: "2026-07-01T00:00:00.000Z",
        quality: "high",
      }],
      evidence: [{
        id: siteEvidenceId,
        sourceId: siteSourceId,
        type: "text_excerpt",
        value: "Aurora QA развивает решения для правовых технологий.",
        factType: "organization",
        quality: "high",
        currentness: "current",
        checkedAt: "2026-08-05T12:00:00.000Z",
        publishedAt: "2026-07-01T00:00:00.000Z",
      }],
      entities: [{ id: "entity:e2e-organization", type: "organization", name: "Aurora QA", confidence: "high" }],
      relations: [],
    },
    osint: {
      reportStatus: "complete",
      promptVersion: "site-osint-interview-v1",
      questionCatalogVersion: "site-osint-questions-v1",
      snapshotHash: siteSnapshotHash,
      coverage: { mode: "site_only", limitations: ["external_osint_not_enabled"] },
      answers: siteAnswers,
      summary: {
        answered: 1,
        hypothesis: 1,
        conflicting: 1,
        insufficientData: SITE_INTERVIEW_QUESTIONS.length - 3,
        total: SITE_INTERVIEW_QUESTIONS.length,
      },
      recommendations: [{
        key: "recommendation:e2e-organization-profile",
        questionId: SITE_INTERVIEW_QUESTIONS[0].id,
        kind: "organization-profile",
        rationale: "Использовать подтверждённое название в социальных каналах.",
        confidence: "high",
        entityIds: ["entity:e2e-organization"],
        evidenceIds: [siteEvidenceId],
      }],
      marketingPlan: {
        publicationBacklog: [{
          key: "backlog:e2e-organization-profile",
          questionId: SITE_INTERVIEW_QUESTIONS[0].id,
          kind: "organization-profile",
          rationale: "Синхронизировать подтверждённое название и описание.",
          confidence: "high",
          evidenceIds: [siteEvidenceId],
          priority: "P0",
          order: 1,
        }],
        measurement: [{ kpi: "Органические переходы", requiredIntegration: "Google Search Console", confidence: "none" }],
      },
    },
  };
  const siteAnalysisId = Number((await pool.query(
    `insert into site_analysis_jobs
       (user_id, request_id, idempotency_key, request_fingerprint, target_url,
        confirmed_domain, consented_at, status, stage, progress, progress_detail,
        result, run_revision, queue_confirmed_at, completed_at, prompt_version,
        question_catalog_version, snapshot_hash, coverage_mode, answered_count, question_count)
     values ($1, '11111111-1111-4111-8111-111111111111', 'e2e-site-analysis-ready', $2,
             'https://example.com/', 'example.com', now(), 'ready', 'ready', 100,
             'OSINT-интервью и маркетинговый план готовы', $3::jsonb, 1, now(), now(),
             'site-osint-interview-v1', 'site-osint-questions-v1', $4, 'site_only', $5, $5)
     returning id`,
    [userId, "c".repeat(64), JSON.stringify(siteReport), siteSnapshotHash, SITE_INTERVIEW_QUESTIONS.length],
  )).rows[0].id);

  await page.goto("/app/site-analysis");
  await page.getByText(`${SITE_INTERVIEW_QUESTIONS.length} вопросов`, { exact: true }).waitFor({ timeout: 10_000 });
  await page.getByText(`Показано ответов: ${SITE_INTERVIEW_QUESTIONS.length} из ${SITE_INTERVIEW_QUESTIONS.length}`, { exact: true }).waitFor();
  const firstEvidenceDisclosure = page.getByRole("button", { name: /доказательства/u }).first();
  assert(await firstEvidenceDisclosure.getAttribute("aria-expanded") === "false", "site answer starts expanded without user action");
  await firstEvidenceDisclosure.click();
  await waitFor(
    async () => await firstEvidenceDisclosure.getAttribute("aria-expanded") === "true",
    "site evidence disclosure did not expand independently",
    5_000,
  );
  const siteEvidenceLink = page.getByRole("link", { name: /Открыть источник/u }).first();
  assert((await siteEvidenceLink.getAttribute("href")) === "https://example.com/about", "site evidence lost its source URL");
  assert(await siteEvidenceLink.getAttribute("target") === "_blank", "site evidence link is not safely external");
  await page.getByRole("button", { name: "Противоречия", exact: true }).click();
  await page.getByText(`Показано ответов: 1 из ${SITE_INTERVIEW_QUESTIONS.length}`, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Противоречия", exact: true }).click();
  const siteExportLinks = page.locator(`a[download][href^="/api/site-analysis/${siteAnalysisId}/export"]`);
  assert(await siteExportLinks.count() === 6, "site analysis did not expose six immutable export formats");
  for (const href of await siteExportLinks.evaluateAll((links) => links.map((link) => link.getAttribute("href")))) {
    const downloaded = await context.request.get(href);
    assert(downloaded.status() === 200, `site analysis export failed: ${href}`);
  }
  await page.reload();
  await page.getByText(`${SITE_INTERVIEW_QUESTIONS.length} вопросов`, { exact: true }).waitFor({ timeout: 10_000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 2), "site analysis has mobile horizontal overflow");
  await page.setViewportSize({ width: 1280, height: 900 });

  const nowPostId = Number((await pool.query(
    `insert into posts (user_id, channel_id, text, status, scheduled_at, published_at,
                        external_message_id, tg_message_id, verification_state, publication_origin)
     values ($1, $2, 'Новый недельный пост', 'published', now(), now(), '801', 801, 'verified', 'manual') returning id`,
    [userId, channels[0]],
  )).rows[0].id);
  const oldPostId = Number((await pool.query(
    `insert into posts (user_id, channel_id, text, status, scheduled_at, published_at,
                        external_message_id, tg_message_id, verification_state, publication_origin)
     values ($1, $2, 'Старый рекорд', 'published', now() - interval '30 days', now() - interval '30 days',
             '802', 802, 'verified', 'manual') returning id`,
    [userId, channels[0]],
  )).rows[0].id);
  await pool.query(
    `insert into post_stats (post_id, snapshot_date, views, reactions)
     values ($1, current_date, 10, 1), ($2, current_date - 30, 10000, 100)`,
    [nowPostId, oldPostId],
  );
  const analytics = await authenticatedRequest(`/api/stats?channel=${channels[0]}`);
  assert(analytics.ok, `analytics failed with ${analytics.status}`);
  const analyticsBody = JSON.parse(analytics.text);
  assert(analyticsBody.period?.days === 7 && analyticsBody.totals?.totalViews === 10, "old high-performing post polluted weekly analytics");
  assert(analyticsBody.cohort?.confidence === "insufficient", "single-post weekly sample overclaimed confidence");

  const truncated = await authenticatedRequest("/api/ai/generate", {
    method: "POST",
    headers: { "idempotency-key": "e2e_truncated_ai_1" },
    data: { command: "write", input: "E2E_TRUNCATE: короткий пост без новых фактов", surface: "composer", channelId: channels[0] },
  });
  const truncatedEvents = truncated.text
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const truncatedError = truncatedEvents.find((event) => event.type === "error");
  assert(truncated.status === 200, `truncated AI request failed before streaming (${truncated.status})`);
  assert(truncated.headers.contentType?.startsWith("application/x-ndjson"), "chat did not use the confirmed NDJSON contract");
  assert(!truncatedEvents.some((event) => event.type === "done"), "truncated provider stream became done/postable");
  assert(truncatedError?.requestId === truncated.headers.requestId, "truncated chat error omitted its request ID");
  assert(
    fakeState.ai.providerIdentityOk
      && fakeState.ai.identities.find((identity) => identity.kind === "truncated")?.requestId === truncated.headers.requestId,
    "truncated chat provider call omitted its idempotency or correlation identity",
  );
  await waitFor(async () => {
    const row = (await pool.query("select status from ai_usage where reservation_key = 'web:e2e_truncated_ai_1'")).rows[0];
    return row?.status === "released";
  }, "truncated AI reservation was not refunded", 8_000);
  const truncatedAck = await authenticatedRequest("/api/ai/generate/ack", {
    method: "POST",
    headers: { "idempotency-key": "e2e_truncated_ai_1" },
  });
  const truncatedAckBody = JSON.parse(truncatedAck.text);
  assert(
    truncatedAck.status === 409 && truncatedAckBody.error === "terminal_ack_unavailable",
    "a truncated chat could be acknowledged and charged",
  );
  assert(
    (await pool.query("select status from ai_usage where reservation_key = 'web:e2e_truncated_ai_1'")).rows[0]?.status === "released",
    "failed terminal acknowledgement changed a released chat reservation",
  );

  const successfulChatPayload = {
    command: "write",
    input: "Короткая редакционная заметка без новых фактических утверждений",
    surface: "composer",
    role: "critic",
    channelId: channels[0],
    postSettings: { qualityMode: "fast" },
  };
  const successfulChat = await authenticatedRequest("/api/ai/generate", {
    method: "POST",
    headers: { "idempotency-key": "e2e_success_ai_1" },
    data: successfulChatPayload,
  });
  const successfulEvents = successfulChat.text
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const successfulDone = successfulEvents.find((event) => event.type === "done");
  assert(successfulChat.status === 200, `authenticated chat failed with ${successfulChat.status}`);
  assert(successfulEvents.some((event) => event.type === "validation"), "successful chat omitted validation event");
  assert(
    successfulDone?.requestId === successfulChat.headers.requestId,
    `successful chat done omitted its request ID (events: ${successfulEvents.map((event) => event.type).join(",")})`,
  );
  assert(successfulDone?.ackRequired === true, "successful chat done did not require explicit quota acknowledgement");
  assert(!successfulEvents.some((event) => event.type === "error"), "successful chat emitted an error terminal event");
  assert(fakeState.ai.successfulCalls === 1, "one logical fast chat generation called the provider more than once");
  assert(
    fakeState.ai.providerIdentityOk
      && fakeState.ai.identities.find((identity) => identity.kind === "successful")?.requestId === successfulChat.headers.requestId,
    "successful chat provider call omitted its idempotency or correlation identity",
  );
  const stagedChatUsage = (await pool.query(
    `select status, result_payload, expires_at > now() as fresh from ai_usage
      where user_id = $1 and reservation_key = 'web:e2e_success_ai_1'`,
    [userId],
  )).rows[0];
  assert(
    stagedChatUsage?.status === "reserved" && stagedChatUsage?.fresh === true,
    "chat quota was charged before the client acknowledged done",
  );
  assert(stagedChatUsage?.result_payload?.protocol === "ndjson", "chat terminal result was not durably staged");

  const successfulAck = await authenticatedRequest("/api/ai/generate/ack", {
    method: "POST",
    headers: { "idempotency-key": "e2e_success_ai_1" },
  });
  const successfulAckBody = JSON.parse(successfulAck.text);
  assert(
    successfulAck.status === 200
      && successfulAck.headers.acknowledged === "true"
      && successfulAckBody.ok === true
      && successfulAckBody.status === "committed"
      && successfulAckBody.replayed === false,
    "client done acknowledgement did not commit the staged chat quota",
  );
  assert(
    successfulAckBody.requestId === successfulAck.headers.requestId,
    "chat acknowledgement omitted its correlation request ID",
  );
  const committedChatUsage = (await pool.query(
    `select status, result_payload from ai_usage
      where user_id = $1 and reservation_key = 'web:e2e_success_ai_1'`,
    [userId],
  )).rows[0];
  assert(committedChatUsage?.status === "committed", "chat quota was not committed after client acknowledgement");
  assert(committedChatUsage?.result_payload?.protocol === "ndjson", "acknowledged chat result was not durably replayable");

  const successfulAckReplay = await authenticatedRequest("/api/ai/generate/ack", {
    method: "POST",
    headers: { "idempotency-key": "e2e_success_ai_1" },
  });
  const successfulAckReplayBody = JSON.parse(successfulAckReplay.text);
  assert(
    successfulAckReplay.status === 200
      && successfulAckReplay.headers.acknowledged === "true"
      && successfulAckReplayBody.replayed === true,
    "repeated chat acknowledgement was not idempotent",
  );

  const successfulChatReplay = await authenticatedRequest("/api/ai/generate", {
    method: "POST",
    headers: { "idempotency-key": "e2e_success_ai_1" },
    data: successfulChatPayload,
  });
  const replayEvents = successfulChatReplay.text
    .split("\n")
    .filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);
  const originalReplace = successfulEvents.findLast((event) => event.type === "replace");
  const replayReplace = replayEvents.findLast((event) => event.type === "replace");
  const replayDone = replayEvents.find((event) => event.type === "done");
  assert(successfulChatReplay.status === 200 && successfulChatReplay.headers.replayed === "true", "chat replay was not explicit");
  assert(replayReplace?.text === originalReplace?.text, "chat replay diverged from the committed terminal result");
  assert(replayEvents.some((event) => event.type === "validation") && replayDone?.ackRequired === true, "chat replay omitted its acknowledged terminal contract");
  assert(fakeState.ai.successfulCalls === 1, "chat replay called the paid provider twice");
  assert(Number((await pool.query(
    "select count(*)::int as n from ai_usage where user_id = $1 and reservation_key = 'web:e2e_success_ai_1'",
    [userId],
  )).rows[0].n) === 1, "chat replay created a second quota row");

  const assetId = Number((await pool.query(
    `insert into media_assets (user_id, kind, file_name, mime_type, bytes, data, sha256)
     values ($1, 'image', 'qa.png', 'image/png', 4, decode('89504e47','hex'), 'e2e-image') returning id`,
    [userId],
  )).rows[0].id);
  const publicationPostId = Number((await pool.query(
    `insert into posts (user_id, channel_id, text, media, scheduled_at, status,
                        idempotency_key, request_fingerprint, publication_origin)
     values ($1, $2, $3, $4::jsonb, now() + interval '1 second', 'scheduled',
             'e2e-multipart-post', 'e2e-multipart-fingerprint', 'manual') returning id`,
    [userId, channels[0], `Длинный текст E2E. ${"Проверяем продолжение без дубля медиа. ".repeat(40)}`, JSON.stringify({ assetId })],
  )).rows[0].id);
  publishQueue = new Queue("publish", { connection: redis });
  await publishQueue.add("publish", { postId: publicationPostId, scheduleRevision: 1 }, {
    delay: 1_000,
    jobId: `post-${publicationPostId}-r1-e2e`,
    removeOnComplete: true,
    removeOnFail: false,
  });
  await waitFor(async () => (await pool.query("select status from posts where id = $1", [publicationPostId])).rows[0]?.status === "published", "multipart publication did not recover", 15_000);
  const parts = (await pool.query(
    "select part_index, part_type, external_message_id, send_status from publication_parts where post_id = $1 order by part_index",
    [publicationPostId],
  )).rows;
  assert(parts.length === 2 && parts.every((part) => part.send_status === "sent"), "multipart external IDs were not both persisted");
  assert(fakeState.telegram.photoCalls === 1 && fakeState.telegram.textCalls === 2, "multipart retry duplicated media or skipped text retry");
  await publishQueue.close();
  publishQueue = undefined;

  console.log(JSON.stringify({
    ok: true,
    runtimeMode: "full",
    browserRoutes: 4,
    draftRecovered: true,
    media: {
      terminalStatus: mediaTerminal.generation.status,
      observedStatuses: [...observedMediaStatuses].filter(Boolean),
      providerCreateCalls: fakeState.media.createCalls,
      providerPollCalls: fakeState.media.pollCalls,
      replayed: mediaReplayBody.replayed,
      quotaStatus: mediaRow.usage_status,
    },
    library: {
      desktopAndMobileNavigation: true,
      snapshotId: exportSnapshotId,
      exportFormats: [...exportFormats].sort(),
    },
    profileReloaded: true,
    siteAnalysis: {
      analysisId: siteAnalysisId,
      questions: SITE_INTERVIEW_QUESTIONS.length,
      evidenceExpanded: true,
      desktopAndMobile: true,
      exportFormats: ["csv", "html", "json", "markdown", "pdf", "xlsx"],
    },
    chat: {
      truncatedReleased: true,
      terminalDone: true,
      quotaReservedUntilAck: true,
      ackCommitted: true,
      ackReplayIdempotent: true,
      replayedWithoutProviderCall: true,
      providerIdentityOk: fakeState.ai.providerIdentityOk,
    },
    trendsOperations: 1,
    weeklyViews: analyticsBody.totals.totalViews,
    telegramParts: parts.map((part) => part.external_message_id),
    telegramCalls: fakeState.telegram,
    ai: {
      calls: fakeState.ai.calls,
      truncatedCalls: fakeState.ai.truncatedCalls,
      successfulCalls: fakeState.ai.successfulCalls,
      providerIdentityOk: fakeState.ai.providerIdentityOk,
    },
  }));
} catch (error) {
  if (page) await page.screenshot({ path: resolve(artifactDir, "failure.png"), fullPage: true }).catch(() => {});
  await writeFile(resolve(artifactDir, "process.log"), logs.join("\n").slice(-200_000), "utf8").catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (publishQueue) await publishQueue.close().catch(() => {});
  if (mediaQueue) await mediaQueue.close().catch(() => {});
  for (const process of children) process.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 500));
  for (const process of children) if (process.exitCode == null) process.kill("SIGKILL");
  if (fakeServer) await new Promise((resolve) => fakeServer.close(resolve)).catch(() => {});
  await redis.flushdb().catch(() => {});
  await redis.quit().catch(() => {});
  await pool.query("drop schema public cascade").catch(() => {});
  await pool.query("create schema public").catch(() => {});
  await pool.end().catch(() => {});
}
