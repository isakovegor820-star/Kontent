import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Queue } from "bullmq";
import IORedis from "ioredis";
import pg from "pg";
import { chromium } from "playwright-core";

import { findAutopilotNearDuplicate } from "../src/lib/autopilot-config.mjs";
import { MEDIA_PROMPT_POLICY } from "../src/lib/media-generation.mjs";
import { enqueuePublicationExtraJob } from "../src/lib/publication-extra-queue.mjs";
import { SITE_INTERVIEW_QUESTIONS } from "../src/lib/site-analysis/questions.data.mjs";
import { encryptToken } from "../src/lib/token-crypto.mjs";
import { reconcilePublicationExtraRuntime } from "../worker/publication-extra-runtime.mjs";
import {
  enqueuePublicationReviewReminderJob,
  processDuePublicationReviews,
  PUBLICATION_REVIEW_REMINDER_QUEUE,
} from "../worker/publication-review-reminder.mjs";
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
const UI_WAIT_TIMEOUT_MS = 30_000;
const RUNTIME_WAIT_TIMEOUT_MS = 120_000;
const API_REQUEST_TIMEOUT_MS = RUNTIME_WAIT_TIMEOUT_MS;
const baseUrl = `http://127.0.0.1:${webPort}`;
const fakeBase = `http://127.0.0.1:${fakePort}`;
const trackedDestination = "https://example.com/consultation";
const artifactDir = resolve("test-results/e2e-real");
await mkdir(artifactDir, { recursive: true });
const brandLogoPath = resolve(artifactDir, "critical-brand-logo.png");
const invalidBrandLogoPath = resolve(artifactDir, "invalid-brand-logo.png");
const vkFetchShimPath = resolve(artifactDir, "vk-fetch-redirect.mjs");

const pool = new pg.Pool({ connectionString: databaseUrl, ssl: false, max: 12 });
const redis = new IORedis(redisUrl, { maxRetriesPerRequest: null });
const children = [];
const logs = [];
let fakeServer;
let browser;
let page;
let runtimeProcess;
let publishQueue;
let mediaQueue;
let statsQueue;
let legalVisualQueue;
let projectExportQueue;
let publicationExtraQueue;
let publicationReviewReminderQueue;
const browserIssues = [];
const expectedBrowserConsoleScopes = new Set();
const interfaceEvidence = {
  reducedMotion: { main: false, reviewer: false },
  viewportWidths: [],
  keyboardOnly: false,
  runtimeRestart: null,
  analyticsUi: null,
  todayUi: null,
};

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function readEditableText(locator) {
  return locator.evaluate((element) => {
    if (
      element instanceof HTMLInputElement
      || element instanceof HTMLTextAreaElement
      || element instanceof HTMLSelectElement
    ) {
      return element.value;
    }

    let text = "";
    const appendBreak = () => {
      if (text && !text.endsWith("\n")) text += "\n";
    };
    const walk = (node, isLast) => {
      if (node.nodeType === Node.TEXT_NODE) {
        text += String(node.nodeValue || "").replace(/\u00a0/gu, " ");
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.tagName === "BR") {
        text += "\n";
        return;
      }
      const block = ["DIV", "P", "LI"].includes(node.tagName);
      if (block) appendBreak();
      const children = [...node.childNodes];
      children.forEach((child, index) => walk(child, index === children.length - 1));
      if (block && !isLast) appendBreak();
    };
    const children = [...element.childNodes];
    children.forEach((child, index) => walk(child, index === children.length - 1));
    return text.replace(/\n+$/u, "");
  });
}

function child(label, command, args, env) {
  const subprocess = spawn(command, args, {
    cwd: globalThis.process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
    detached: globalThis.process.platform !== "win32",
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

function signalChild(subprocess, signal) {
  if (!subprocess || subprocess.exitCode != null || subprocess.signalCode != null) return;
  if (globalThis.process.platform !== "win32" && subprocess.pid) {
    try {
      globalThis.process.kill(-subprocess.pid, signal);
      return;
    } catch {}
  }
  subprocess.kill(signal);
}

async function stopChild(subprocess, label, timeoutMs = 12_000) {
  if (!subprocess || subprocess.exitCode != null || subprocess.signalCode != null) return;
  const exited = new Promise((resolveExit) => {
    if (subprocess.exitCode != null || subprocess.signalCode != null) resolveExit();
    else subprocess.once("exit", resolveExit);
  });
  signalChild(subprocess, "SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (graceful) return;
  signalChild(subprocess, "SIGKILL");
  const killed = await Promise.race([
    exited.then(() => true),
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
  ]);
  assert(killed, `${label} did not terminate after SIGKILL`);
}

async function installBrowserDiagnostics(context, label) {
  await context.addInitScript(() => {
    globalThis.addEventListener("unhandledrejection", (event) => {
      const reason = event.reason instanceof Error
        ? `${event.reason.name}: ${event.reason.message}`
        : String(event.reason ?? "unknown rejection");
      console.error(`__AURORA_E2E_UNHANDLED_REJECTION__${reason}`);
    });
  });
  context.on("page", (targetPage) => {
    targetPage.on("crash", () => {
      browserIssues.push({
        context: label,
        kind: "page.crash",
        message: "browser page crashed",
        url: targetPage.url(),
        line: 0,
      });
    });
    targetPage.on("close", () => {
      if (browser?.isConnected()) {
        browserIssues.push({
          context: label,
          kind: "page.close",
          message: "browser page closed before test teardown",
          url: targetPage.url(),
          line: 0,
        });
      }
    });
    targetPage.on("console", (message) => {
      if (message.type() !== "error") return;
      const rawText = message.text();
      const unhandled = rawText.startsWith("__AURORA_E2E_UNHANDLED_REJECTION__");
      if (!unhandled && expectedBrowserConsoleScopes.has(label)) return;
      const location = message.location();
      browserIssues.push({
        context: label,
        kind: unhandled ? "unhandledrejection" : "console.error",
        message: unhandled
          ? rawText.slice("__AURORA_E2E_UNHANDLED_REJECTION__".length)
          : rawText,
        url: location?.url || targetPage.url(),
        line: Number(location?.lineNumber || 0),
      });
    });
    targetPage.on("pageerror", (error) => {
      browserIssues.push({
        context: label,
        kind: "pageerror",
        message: String(error?.message || error),
        url: targetPage.url(),
        line: 0,
      });
    });
  });
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

async function reloadAfterRuntimeRestart(targetPage, label) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await targetPage.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error);
      if (!message.includes("ERR_ABORTED")) throw error;
      const recovered = await waitFor(
        async () => targetPage.evaluate(() => document.readyState === "interactive" || document.readyState === "complete"),
        `${label} did not settle after an aborted reload`,
        10_000,
      ).then(() => true).catch(() => false);
      if (recovered) return;
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, attempt * 250));
    }
  }
  throw new Error(`${label} did not reload after runtime restart: ${String(lastError?.message || lastError)}`);
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
  telegram: {
    photoCalls: 0,
    textCalls: 0,
    plainTextCalls: 0,
    commentCalls: 0,
    mediaGroupCalls: 0,
    pinCalls: 0,
    unpinCalls: 0,
    getUpdatesCalls: 0,
    plainTextRateLimited: false,
    albumMessageIds: [],
    commentMessageId: null,
    pinnedMessageId: null,
    unpinnedMessageId: null,
    discussionUpdateDelivered: false,
    webhookUrl: "",
    requests: [],
  },
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
  vk: {
    wallPostCalls: 0,
    closeCommentsCalls: 0,
    requests: [],
  },
  trackerVerificationChallenge: null,
};

const libraryComposerResult = [
  "Полный абзац нужен для независимого раскрытия карточки.",
  "Перед согласованием разберите договор на смысловые блоки: предмет, обязанности сторон, сроки, порядок оплаты и условия прекращения. Для каждого блока сформулируйте простой вопрос: что именно должна сделать сторона, когда это происходит и как подтверждается выполнение?",
  "Отдельно отметьте слова, которые допускают несколько толкований. Вместо расплывчатого «своевременно» укажите понятное событие или срок, а вместо общего «надлежащим образом» — конкретный ожидаемый результат.",
  "Проверяемые условия удобнее обсуждать по одному, не смешивая юридическую формулировку с деловыми ожиданиями. Сначала зафиксируйте смысл пункта простыми словами, затем сопоставьте его с текстом договора и отметьте расхождения для редакционной проверки.",
  "После правок перечитайте документ глазами каждой стороны. Убедитесь, что порядок действий, подтверждающие документы и последствия каждого решения описаны последовательно и не противоречат соседним пунктам.",
  "Такой подход не заменяет профессиональную проверку, но даёт команде понятную основу для содержательного согласования. Сохраните вопросы и спорные формулировки рядом с рабочей версией, чтобы следующая редакция договора отвечала на них прямо.",
].join("\n\n");

function extractJsonObject(textValue) {
  const textValueString = String(textValue || "");
  for (let start = textValueString.indexOf("{"); start >= 0; start = textValueString.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = start; index < textValueString.length; index += 1) {
      const character = textValueString[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') quoted = false;
        continue;
      }
      if (character === '"') quoted = true;
      else if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) return textValueString.slice(start, index + 1);
      }
    }
  }
  return "{}";
}

const fakePng =
  "iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWMwDL/6HxkzkC4AAOzAJcGGDGiBAAAAAElFTkSuQmCC";
await writeFile(brandLogoPath, Buffer.from(fakePng, "base64"));
await writeFile(invalidBrandLogoPath, Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4kAAAAAASUVORK5CYII=",
  "base64",
));
await writeFile(
  vkFetchShimPath,
  `const upstreamFetch = globalThis.fetch.bind(globalThis);
const fakeBase = ${JSON.stringify(fakeBase)};
globalThis.fetch = (input, init) => {
  const source = input instanceof Request ? input.url : String(input);
  const url = new URL(source);
  if (url.origin === "https://api.vk.com" && url.pathname.startsWith("/method/")) {
    const rewritten = new URL(\`/vk\${url.pathname}\${url.search}\`, fakeBase);
    if (input instanceof Request) return upstreamFetch(new Request(rewritten, input), init);
    return upstreamFetch(rewritten, init);
  }
  return upstreamFetch(input, init);
};
`,
  "utf8",
);

function fakeAutopilotPost(messageText) {
  const topic = messageText.match(/на тему:\s*([^\n.]{8,120})/iu)?.[1]?.trim() || "Рабочая тема";
  const safeTopic = topic.replace(/[«»"']/gu, "").slice(0, 46).replace(/[,:;—-]+$/u, "");
  const presentation = messageText.match(/— форма:\s*([^;\n]+)/iu)?.[1]?.trim() || "объяснение";
  const presentationSeed = `${safeTopic}\0${presentation}`;
  const variant = [...presentationSeed]
    .reduce((sum, character) => sum + character.codePointAt(0), 0) % 3;
  const bodies = [
    [
      "Начните не с готового ответа, а с рамки: для кого вы готовите материал, какой вопрос хотите прояснить и какое действие читатель сможет выбрать самостоятельно.",
      "Отделите наблюдение от предположения, уберите неподтверждённые детали и оставьте только те формулировки, которые можно спокойно обсудить с командой.",
      "Затем перечитайте текст вслух: так заметнее тяжёлые обороты, повторяющиеся мысли и места, где автор торопит читателя вместо ясного объяснения.",
      "Хорошая редакционная работа начинается с точного вопроса и заканчивается понятным следующим шагом без давления и громких обещаний.",
    ],
    [
      "Полезно посмотреть на тему глазами читателя, который видит её впервые и пока не знает внутреннего контекста команды.",
      "Сначала обозначьте границы разговора, затем соберите вопросы, которые действительно требуют ответа, и только после этого выбирайте структуру публикации.",
      "Проверьте каждую фразу на ясность: профессиональный язык уместен там, где он помогает смыслу, а не создаёт дистанцию.",
      "Финальный текст должен оставлять пространство для решения читателя и приглашать к содержательному диалогу, а не подменять его рекламным обещанием.",
    ],
    [
      "Сильный материал можно собрать как спокойный маршрут: сначала контекст, потом развилка вариантов и в конце вопрос для самостоятельной проверки.",
      "Не пытайтесь вместить всё сразу; одна публикация выигрывает, когда держится вокруг одной мысли и последовательно раскрывает её без лишних отступлений.",
      "Уберите слова, которые ничего не добавляют, сравните заголовок с основной частью и убедитесь, что финал продолжает начатый разговор.",
      "Такой подход помогает сохранить человеческую интонацию, показать уважение к аудитории и подготовить материал, который удобно читать и обсуждать.",
    ],
  ];
  return [
    `${presentation}: ${safeTopic}?`,
    ...bodies[variant],
    "Перед публикацией проверьте, что каждый абзац помогает основной мысли, а вывод можно применить без скрытого контекста и дополнительных обещаний.",
    `Какой следующий шаг вы выберете после формата «${presentation}»?`,
  ].join("\n\n");
}

const fakeAutopilotBase = fakeAutopilotPost([
  "— форма: объяснение;",
  "Напиши пост на тему: Проверка договора перед подписанием.",
].join("\n"));
const fakeAutopilotRewrite = fakeAutopilotPost([
  "— форма: разбор ошибки;",
  "Напиши пост на тему: Проверка договора перед подписанием.",
  "Перепиши с другим хуком, логикой блоков и финалом.",
].join("\n"));
assert(
  !findAutopilotNearDuplicate(
    { topic: "", draft: fakeAutopilotRewrite },
    [{ topic: "", draft: fakeAutopilotBase }],
  ),
  "fake Autopilot provider must honor presentation rewrites with a distinct draft",
);
assert(
  [fakeAutopilotBase, fakeAutopilotRewrite].every((draft) => draft.length >= 700 && draft.length <= 1_150),
  "fake Autopilot provider must satisfy the default detail length contract",
);

function fakeProvider() {
  return http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    if (req.url?.startsWith("/vk/method/") && req.method === "POST") {
      const method = decodeURIComponent(req.url.slice("/vk/method/".length).split("?", 1)[0] || "");
      const form = new URLSearchParams(raw);
      const safeParams = Object.fromEntries(
        [...form.entries()].filter(([key]) => key !== "access_token"),
      );
      fakeState.vk.requests.push({ method, params: safeParams });
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (method === "wall.post") {
        fakeState.vk.wallPostCalls += 1;
        res.end(JSON.stringify({ response: { post_id: 8801 } }));
        return;
      }
      if (method === "wall.closeComments") {
        fakeState.vk.closeCommentsCalls += 1;
        res.end(JSON.stringify({ response: 1 }));
        return;
      }
      if (method === "groups.getById") {
        res.end(JSON.stringify({ response: { groups: [{ id: 77001, members_count: 42 }] } }));
        return;
      }
      if (method === "wall.get" || method === "wall.getById") {
        res.end(JSON.stringify({ response: { count: 0, items: [] } }));
        return;
      }
      res.statusCode = 400;
      res.end(JSON.stringify({ error: { error_code: 3, error_msg: "unsupported E2E VK method" } }));
      return;
    }
    if (req.url === "/.well-known/aurora-tracker-verification.txt" && req.method === "GET") {
      if (typeof fakeState.trackerVerificationChallenge !== "string") {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end(fakeState.trackerVerificationChallenge);
      return;
    }
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
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      const text = JSON.stringify(messages);
      const truncate = text.includes("E2E_TRUNCATE");
      const successful = text.includes("Короткая редакционная заметка без новых фактических утверждений");
      const libraryComposer = text.includes("E2E_LIBRARY_REFERENCE");
      const semantic = text.includes("conservative textual-entailment classifier");
      const autopilot = text.includes("строгий выпускающий редактор Telegram-канала");
      const monthlyRegeneration = text.includes("выпускающий редактор месячного контент-плана");
      let completionText = "Безопасный тестовый текст.";
      if (semantic) {
        let payload = {};
        try {
          payload = JSON.parse(String(messages.findLast((message) => message?.role === "user")?.content || "{}"));
        } catch {}
        completionText = JSON.stringify({
          verdicts: (Array.isArray(payload?.claims) ? payload.claims : []).map((claim) => ({
            claimId: claim.id,
            verdict: "non_factual",
            evidenceIds: [],
            reasonCode: "e2e_editorial_expression",
          })),
        });
      } else if (autopilot) {
        completionText = fakeAutopilotPost(text);
      } else if (libraryComposer) {
        completionText = libraryComposerResult;
      } else if (monthlyRegeneration) {
        const rawUser = String(messages.findLast((message) => message?.role === "user")?.content || "{}");
        let payload = {};
        try { payload = JSON.parse(extractJsonObject(rawUser)); } catch {}
        const targets = Array.isArray(payload?.targets) ? payload.targets : [];
        completionText = JSON.stringify(targets.map((target, index) => ({
          itemId: Number(target.itemId),
          title: `Редакционная карта для руководителя: новый ракурс ${index + 1}`,
          rubric: String(target.previousRubric || "Практика"),
          practice: String(target.previousPractice || "правовые технологии"),
          funnelStage: String(target.previousFunnelStage || "awareness"),
          state: "topic",
        })));
      }
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
      if (body?.stream === true) {
        res.setHeader("content-type", "text/event-stream");
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: completionText } }] })}\n\n`);
        if (libraryComposer) await new Promise((resolveDelay) => setTimeout(resolveDelay, 220));
        if (!truncate) res.write("data: [DONE]\n\n");
        else fakeState.ai.truncatedCalls += 1;
        res.end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({
          choices: [{ message: { role: "assistant", content: completionText }, finish_reason: "stop" }],
        }));
      }
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
      fakeState.telegram.requests.push({ method: "sendPhoto", raw: raw.slice(0, 2_000) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: { message_id: 701 } }));
      return;
    }
    if (/\/bot[^/]+\/sendMediaGroup$/u.test(req.url || "")) {
      fakeState.telegram.mediaGroupCalls += 1;
      const albumSize = Math.max(0, (raw.match(/"type":"photo"/gu) || []).length);
      fakeState.telegram.albumMessageIds = Array.from({ length: albumSize }, (_, index) => 801 + index);
      fakeState.telegram.requests.push({ method: "sendMediaGroup", raw: raw.slice(0, 2_000) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        result: fakeState.telegram.albumMessageIds.map((messageId) => ({ message_id: messageId })),
      }));
      return;
    }
    if (/\/bot[^/]+\/sendMessage$/u.test(req.url || "")) {
      fakeState.telegram.textCalls += 1;
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      const comment = Boolean(body?.reply_parameters?.message_id);
      if (comment) fakeState.telegram.commentCalls += 1;
      else fakeState.telegram.plainTextCalls += 1;
      fakeState.telegram.requests.push({ method: "sendMessage", body });
      res.setHeader("content-type", "application/json");
      if (!comment && !fakeState.telegram.plainTextRateLimited) {
        fakeState.telegram.plainTextRateLimited = true;
        res.end(JSON.stringify({
          ok: false,
          error_code: 429,
          description: "controlled rate limit",
          parameters: { retry_after: 1 },
        }));
      } else {
        const messageId = comment ? 901 : 702;
        if (comment) fakeState.telegram.commentMessageId = messageId;
        res.end(JSON.stringify({ ok: true, result: { message_id: messageId } }));
      }
      return;
    }
    if (/\/bot[^/]+\/pinChatMessage$/u.test(req.url || "")) {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      fakeState.telegram.pinCalls += 1;
      fakeState.telegram.pinnedMessageId = Number(body?.message_id) || null;
      fakeState.telegram.requests.push({ method: "pinChatMessage", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (/\/bot[^/]+\/unpinChatMessage$/u.test(req.url || "")) {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      fakeState.telegram.unpinCalls += 1;
      fakeState.telegram.unpinnedMessageId = Number(body?.message_id) || null;
      fakeState.telegram.requests.push({ method: "unpinChatMessage", body });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (/\/bot[^/]+\/setMyCommands$/u.test(req.url || "")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: [] }));
      return;
    }
    if (/\/bot[^/]+\/setWebhook$/u.test(req.url || "")) {
      let body = {};
      try { body = JSON.parse(raw); } catch {}
      fakeState.telegram.webhookUrl = String(body?.url || "");
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (/\/bot[^/]+\/deleteWebhook$/u.test(req.url || "")) {
      fakeState.telegram.webhookUrl = "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result: true }));
      return;
    }
    if (/\/bot[^/]+\/getWebhookInfo$/u.test(req.url || "")) {
      const hasPendingDiscussionUpdate = fakeState.telegram.albumMessageIds.length > 0
        && !fakeState.telegram.discussionUpdateDelivered;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        ok: true,
        result: {
          url: fakeState.telegram.webhookUrl,
          pending_update_count: hasPendingDiscussionUpdate ? 1 : 0,
        },
      }));
      return;
    }
    if (/\/bot[^/]+\/getUpdates$/u.test(req.url || "")) {
      fakeState.telegram.getUpdatesCalls += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
      const canDeliver = fakeState.telegram.albumMessageIds.length > 0
        && !fakeState.telegram.discussionUpdateDelivered;
      const result = canDeliver ? [{
        update_id: 99001,
        message: {
          message_id: 9901,
          chat: { id: -100900000199, type: "supergroup" },
          is_automatic_forward: true,
          forward_origin: {
            type: "channel",
            chat: { id: -100900000099, type: "channel" },
            message_id: fakeState.telegram.albumMessageIds[0],
          },
        },
      }] : [];
      if (canDeliver) fakeState.telegram.discussionUpdateDelivered = true;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true, result }));
      return;
    }
    res.statusCode = 404;
    res.end("not found");
  });
}

const runtimeEnv = {
  ...process.env,
  NODE_OPTIONS: [
    String(process.env.NODE_OPTIONS || "").trim(),
    `--import=${pathToFileURL(vkFetchShimPath).href}`,
  ].filter(Boolean).join(" "),
  NODE_ENV: "development",
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  APP_URL: baseUrl,
  NEXT_PUBLIC_APP_URL: baseUrl,
  AURORA_READINESS_TOKEN: "e2e-readiness-token-with-32-characters-minimum",
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
  AI_SEMANTIC_ENGINE: "openai",
  AI_FALLBACK_ENGINES: "",
  ANTHROPIC_API_KEY: "",
  GEMINI_API_KEY: "",
  OLLAMA_URL: fakeBase,
  NAVYAI_API_KEY: "e2e-fake-navy-key",
  NAVYAI_API_URL: `${fakeBase}/v1`,
  TOKENS_MASTER_KEY: "e2e-only-master-key-with-enough-entropy-2026",
  TOKENS_KEY_ID: "1",
  TRACKING_ATTRIBUTION_SECRET: "e2e-attribution-secret-isolated-2026-08-12",
  TRACKING_FINGERPRINT_SECRET: "e2e-fingerprint-secret-distinct-2026-08-12",
  AURORA_TRACKER_ALLOW_LOCAL_VERIFICATION: "true",
  AURORA_TRACKER_LOCAL_VERIFICATION_ORIGINS: fakeBase,
  AURORA_E2E_VK_API_URL: fakeBase,
  AURORA_AVATAR_BODY_LIMIT_BYTES: String(5 * 1024 * 1024 + 512 * 1024),
  AURORA_WORKER_MODE: "full",
  AURORA_NEXT_DIST_DIR: ".next-e2e-real",
  TG_WEBHOOK_URL: "",
  RETRY_DELAYS_MS: "500,500,500",
  PUBLICATION_OVERDUE_GRACE_MS: "300000",
};

function encryptE2eVkToken(userId) {
  const previousMasterKey = process.env.TOKENS_MASTER_KEY;
  const previousKeyId = process.env.TOKENS_KEY_ID;
  process.env.TOKENS_MASTER_KEY = runtimeEnv.TOKENS_MASTER_KEY;
  process.env.TOKENS_KEY_ID = runtimeEnv.TOKENS_KEY_ID;
  try {
    return encryptToken("e2e-vk-community-token-not-live", { userId, provider: "vk" });
  } finally {
    if (previousMasterKey == null) delete process.env.TOKENS_MASTER_KEY;
    else process.env.TOKENS_MASTER_KEY = previousMasterKey;
    if (previousKeyId == null) delete process.env.TOKENS_KEY_ID;
    else process.env.TOKENS_KEY_ID = previousKeyId;
  }
}

function startFullRuntime(label) {
  // A stopped Turbopack process can leave an internally consistent cache whose route
  // manifest serves every application path as 404. A real release restart also uses a
  // clean release directory, so remove only this test-owned dist tree before each lifecycle.
  rmSync(resolve(runtimeEnv.AURORA_NEXT_DIST_DIR), { recursive: true, force: true });
  runtimeProcess = child(
    label,
    globalThis.process.platform === "win32" ? "npm.cmd" : "npm",
    ["run", "dev", "--", "-H", "127.0.0.1", "-p", String(webPort)],
    runtimeEnv,
  );
  return runtimeProcess;
}

async function waitForFullRuntime(message = "full development readiness did not become ready") {
  return waitFor(async () => {
    const response = await fetch(`${baseUrl}/api/readiness`, {
      cache: "no-store",
      headers: { authorization: `Bearer ${runtimeEnv.AURORA_READINESS_TOKEN}` },
    });
    const body = await response.json();
    return response.status === 200
      && body.schemaReady
      && body.publicationReady
      && body.checks?.redis === "up"
      && body.checks?.publicationWorker === "up";
  }, message, RUNTIME_WAIT_TIMEOUT_MS);
}

async function waitForRuntimeUnavailable() {
  return waitFor(async () => {
    try {
      await fetch(`${baseUrl}/api/readiness`, {
        cache: "no-store",
        signal: AbortSignal.timeout(750),
      });
      return false;
    } catch {
      return true;
    }
  }, "full development runtime stayed reachable after shutdown", 20_000);
}

async function waitForFullWorkerSet() {
  for (const [label, queue] of [
    ["publish", publishQueue],
    ["media", mediaQueue],
    ["stats", statsQueue],
    ["legal visual render", legalVisualQueue],
    ["project export", projectExportQueue],
    ["publication extra", publicationExtraQueue],
    ["publication review reminder", publicationReviewReminderQueue],
  ]) {
    await waitFor(
      async () => queue && (await queue.getWorkers()).some(
        (client) => Number(client.db) === Number(redisTarget.pathname.slice(1)),
      ),
      `full runtime did not expose a ${label} worker`,
      30_000,
    );
  }
}

async function waitForNoRuntimeWorkers() {
  for (const [label, queue] of [
    ["publish", publishQueue],
    ["media", mediaQueue],
    ["stats", statsQueue],
    ["legal visual render", legalVisualQueue],
    ["project export", projectExportQueue],
    ["publication extra", publicationExtraQueue],
    ["publication review reminder", publicationReviewReminderQueue],
  ]) {
    await waitFor(
      // Redis CLIENT LIST is server-wide, while BullMQ queues are scoped by the
      // selected logical database. A developer's localhost may legitimately run
      // the same queue name in DB 0; only DB 15 belongs to this disposable E2E.
      async () => !queue || !(await queue.getWorkers()).some(
        (client) => Number(client.db) === Number(redisTarget.pathname.slice(1)),
      ),
      `${label} worker remained connected after full-runtime shutdown`,
      30_000,
    );
  }
}

async function publishJobsForPost(postId) {
  const jobs = await publishQueue.getJobs(
    ["wait", "active", "delayed", "paused", "prioritized", "failed"],
    0,
    -1,
    true,
  );
  return jobs.filter((job) => Number(job.data?.postId) === Number(postId));
}

async function tabTo(targetPage, target, label, { reverse = false, limit = 100 } = {}) {
  await target.waitFor({ state: "visible", timeout: UI_WAIT_TIMEOUT_MS });
  for (let index = 0; index <= limit; index += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return index;
    await targetPage.keyboard.press(reverse ? "Shift+Tab" : "Tab");
  }
  throw new Error(`${label} was not reachable with ${reverse ? "Shift+Tab" : "Tab"}`);
}

async function captureViewportEvidence(targetPage) {
  const viewports = [
    { width: 1440, height: 900, label: "desktop-1440" },
    { width: 1024, height: 768, label: "desktop-1024" },
    { width: 390, height: 844, label: "mobile-390" },
    { width: 320, height: 780, label: "mobile-320" },
    { width: 640, height: 800, label: "desktop-200-percent-zoom-equivalent" },
  ];
  const evidence = [];
  await targetPage.goto("/app/calendar");
  await targetPage.getByRole("heading", { name: "Календарь", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await targetPage.locator('main article[id^="calendar-"]').first().waitFor({
    state: "visible",
    timeout: UI_WAIT_TIMEOUT_MS,
  });
  for (const viewport of viewports) {
    await targetPage.setViewportSize({ width: viewport.width, height: viewport.height });
    await assertNoHorizontalOverflow(targetPage, `release Calendar at ${viewport.width}px`);
    const measuredWidth = await targetPage.evaluate(() => globalThis.innerWidth);
    assert(measuredWidth === viewport.width, `${viewport.label} rendered at ${measuredWidth}px`);
    const file = resolve(artifactDir, `interface-${viewport.label}.png`);
    await targetPage.screenshot({ path: file, fullPage: true });
    evidence.push({ ...viewport, measuredWidth, file });
  }
  return evidence;
}

async function runKeyboardOnlyCriticalPass(targetPage) {
  await targetPage.setViewportSize({ width: 390, height: 844 });
  await targetPage.goto("/app/calendar");
  await targetPage.getByRole("heading", { name: "Календарь", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await targetPage.evaluate(() => {
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });

  const menuTrigger = targetPage.getByRole("button", { name: "Открыть меню", exact: true });
  const menuTabs = await tabTo(targetPage, menuTrigger, "mobile menu trigger");
  assert(await menuTrigger.evaluate((element) => element === document.activeElement), "Tab did not focus the mobile menu trigger");
  await targetPage.keyboard.press("Enter");
  const menuDialog = targetPage.getByRole("dialog", { name: "Меню платформы", exact: true });
  await menuDialog.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(
    async () => menuDialog.evaluate((element) => element.contains(document.activeElement)),
    "Enter did not move focus into the mobile menu",
    5_000,
  );
  await targetPage.keyboard.press("Shift+Tab");
  assert(
    await menuDialog.evaluate((element) => element.contains(document.activeElement)),
    "Shift+Tab escaped the mobile menu focus scope",
  );
  await targetPage.keyboard.press("Escape");
  await menuDialog.waitFor({ state: "hidden", timeout: UI_WAIT_TIMEOUT_MS });
  assert(await menuTrigger.evaluate((element) => element === document.activeElement), "mobile menu did not restore trigger focus");

  const exportTrigger = targetPage.getByRole("button", { name: "Экспортировать", exact: true });
  const exportTabs = await tabTo(targetPage, exportTrigger, "calendar export trigger");
  assert(await exportTrigger.evaluate((element) => element === document.activeElement), "Tab did not focus the export trigger");
  await targetPage.keyboard.press("Space");
  const exportDialog = targetPage.getByRole("dialog", { name: "Экспортировать данные", exact: true });
  await exportDialog.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(
    async () => exportDialog.evaluate((element) => element.contains(document.activeElement)),
    "Space did not move focus into the export dialog",
    5_000,
  );
  await targetPage.keyboard.press("Tab");
  assert(
    await exportDialog.evaluate((element) => element.contains(document.activeElement)),
    "Tab escaped the export dialog focus scope",
  );
  await targetPage.keyboard.press("Escape");
  await exportDialog.waitFor({ state: "hidden", timeout: UI_WAIT_TIMEOUT_MS });
  assert(await exportTrigger.evaluate((element) => element === document.activeElement), "export dialog did not restore trigger focus");
  return { menuTabs, exportTabs, keys: ["Tab", "Shift+Tab", "Enter", "Space"] };
}

async function runTodayWorkspacePass(targetPage, channels, draftId) {
  await pool.query("update drafts set purpose = 'needs_review', updated_at = now() where id = $1", [draftId]);
  const secondDraftId = Number((await pool.query(
    `insert into drafts (user_id, project_id, text, origin, purpose, client_key)
       select user_id, project_id, 'Второй материал для быстрого разбора', 'manual', 'needs_review',
              'e2e-today-quick-' || id::text
         from drafts where id = $1
     on conflict (user_id, client_key) do update set purpose = 'needs_review', updated_at = now()
     returning id`,
    [draftId],
  )).rows[0].id);
  await pool.query(
    `insert into draft_destinations (draft_id, channel_id) values ($1, $2)
     on conflict (draft_id, channel_id) do nothing`,
    [secondDraftId, channels[0]],
  );
  await targetPage.setViewportSize({ width: 390, height: 844 });
  await targetPage.goto(`/app/today?channel=${channels[0]}`);
  await targetPage.getByRole("heading", { name: "Сегодня", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await targetPage.getByRole("heading", { name: "Пульс канала за 7 дней", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const reviewHeading = targetPage.getByRole("heading", { name: "Проверьте черновик", exact: true }).first();
  await reviewHeading.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await assertNoHorizontalOverflow(targetPage, "Today mobile");

  await targetPage.setViewportSize({ width: 1280, height: 900 });
  await targetPage.evaluate(() => {
    document.body.setAttribute("tabindex", "-1");
    document.body.focus();
    document.body.removeAttribute("tabindex");
  });
  const quick = targetPage.getByRole("button", { name: "Разобрать за 5 минут", exact: true });
  const quickTabs = await tabTo(targetPage, quick, "Today five-minute mode");
  await targetPage.keyboard.press("Enter");
  await targetPage.getByRole("heading", { name: "Разобрать за 5 минут", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const done = targetPage.getByRole("button", { name: "Готово", exact: true });
  const doneTabs = await tabTo(targetPage, done, "Today done action");
  await targetPage.keyboard.press("Enter");
  const summary = targetPage.getByRole("heading", { name: /решени.+ в фокусе/u });
  await waitFor(
    async () => targetPage.evaluate(() => document.activeElement?.tagName === "H3")
      || summary.evaluate((element) => element === document.activeElement),
    "Today completion did not move focus to the next decision or summary",
    5_000,
  );
  const undo = targetPage.getByRole("button", { name: "Вернуть", exact: true });
  await undo.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(async () => await undo.isEnabled(), "Today undo remained disabled", 5_000);
  await tabTo(targetPage, undo, "Today undo action");
  await targetPage.keyboard.press("Enter");
  await reviewHeading.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(
    async () => reviewHeading.evaluate((element) => element === document.activeElement),
    "Today undo did not restore focus to the card",
    5_000,
  );

  await targetPage.getByRole("button", { name: "Выйти из режима", exact: true }).click();

  const snooze = targetPage.getByRole("button", { name: "Напомнить завтра", exact: true }).first();
  await tabTo(targetPage, snooze, "Today snooze action");
  await targetPage.keyboard.press("Space");
  await targetPage.getByText("Напомним завтра в 09:00", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });

  const selector = targetPage.locator("#today-channel");
  await selector.selectOption(String(channels[1]));
  await targetPage.waitForURL((url) => url.pathname === "/app/today" && url.searchParams.get("channel") === String(channels[1]));
  await targetPage.getByRole("heading", { name: "Добавьте конкурентов", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });

  let refreshCalls = 0;
  await targetPage.route("**/api/today/refresh", async (route) => {
    refreshCalls += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ availability: "ready", sources: [], completedAt: new Date().toISOString() }),
    });
  });
  const refresh = targetPage.getByRole("button", { name: "Обновить решения", exact: true });
  await refresh.click();
  await waitFor(async () => refreshCalls === 1 && await refresh.isEnabled(), "Today refresh did not complete", 10_000);
  await targetPage.unroute("**/api/today/refresh");
  await assertNoHorizontalOverflow(targetPage, "Today desktop");
  return { doneTabs, quickTabs, refreshCalls, channelsSwitched: true, pulse: true, quickMode: true, done: true, undone: true, snoozed: true };
}

async function assertTouch(locator, label) {
  const box = await locator.boundingBox();
  assert(box && box.width >= 44 && box.height >= 44, `${label} touch target is below 44x44`);
}

async function openComposerSection(targetPage, id) {
  const section = targetPage.locator(`#${id}`);
  await section.waitFor();
  if ((await section.getAttribute("open")) == null) await section.locator("summary").click();
  return section;
}

async function waitForResponsiveLayout(targetPage) {
  await targetPage.evaluate(() => new Promise((resolveFrame) => {
    requestAnimationFrame(() => requestAnimationFrame(resolveFrame));
  }));
  await targetPage.waitForFunction(() => {
    const shell = [...document.querySelectorAll("div")]
      .find((element) => element.classList.contains("lg:pl-[260px]"));
    if (!shell) return true;
    const desktop = matchMedia("(min-width: 64rem)").matches;
    return getComputedStyle(shell).paddingLeft === (desktop ? "260px" : "0px");
  }, undefined, { timeout: UI_WAIT_TIMEOUT_MS });
}

async function assertNoHorizontalOverflow(targetPage, label) {
  await waitForResponsiveLayout(targetPage);
  const snapshot = await targetPage.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLocaleLowerCase(),
          id: element.id,
          classes: String(element.className || "").slice(0, 180),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: String(element.textContent || "").trim().replace(/\s+/gu, " ").slice(0, 100),
        };
      })
      .filter((item) => item.right > viewportWidth + 2 || item.left < -2)
      .sort((left, right) => (right.right - viewportWidth) - (left.right - viewportWidth))
      .slice(0, 12);
    return { viewportWidth, scrollWidth: document.documentElement.scrollWidth, offenders };
  });
  assert(
    snapshot.scrollWidth <= snapshot.viewportWidth + 2,
    `${label} has horizontal overflow: ${JSON.stringify(snapshot)}`,
  );
}

function parseCsv(buffer) {
  const text = buffer.toString("utf8").replace(/^\uFEFF/u, "");
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') quoted = false;
      else cell += character;
    } else if (character === '"') quoted = true;
    else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\r" && text[index + 1] === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      index += 1;
    } else cell += character;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function decodeXml(value) {
  return String(value)
    .replace(/&#(\d+);/gu, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&gt;/gu, ">")
    .replace(/&lt;/gu, "<")
    .replace(/&amp;/gu, "&");
}

function columnIndex(reference) {
  const letters = reference.match(/^[A-Z]+/u)?.[0] || "A";
  return [...letters].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

function parseSheetXml(xml) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gu)) {
    const row = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gu)) {
      const attributes = cellMatch[1];
      const body = cellMatch[2];
      const reference = attributes.match(/\br="([A-Z]+\d+)"/u)?.[1] || "A1";
      const inline = body.match(/<t\b[^>]*>([\s\S]*?)<\/t>/u)?.[1];
      const raw = inline == null ? body.match(/<v>([\s\S]*?)<\/v>/u)?.[1] ?? "" : inline;
      row[columnIndex(reference)] = { attributes, value: decodeXml(raw) };
    }
    rows.push(row);
  }
  return rows;
}

function inspectXlsx(buffer) {
  const directory = mkdtempSync(join(tmpdir(), "aurora-e2e-export-xlsx-"));
  const file = join(directory, "report.xlsx");
  try {
    writeFileSync(file, buffer);
    const validation = execFileSync("unzip", ["-t", file], { encoding: "utf8" });
    const sheet = execFileSync("unzip", ["-p", file, "xl/worksheets/sheet1.xml"], { encoding: "utf8" });
    return { validation, sheet, rows: parseSheetXml(sheet) };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function inspectPdf(buffer) {
  const directory = mkdtempSync(join(tmpdir(), "aurora-e2e-export-pdf-"));
  const file = join(directory, "report.pdf");
  try {
    writeFileSync(file, buffer);
    const text = execFileSync("pdftotext", ["-layout", file, "-"], { encoding: "utf8" });
    return { text };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
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
  startFullRuntime("runtime-initial");
  await waitForFullRuntime();

  publishQueue = new Queue("publish", { connection: redis });
  mediaQueue = new Queue("media-generation", { connection: redis });
  statsQueue = new Queue("stats", { connection: redis });
  legalVisualQueue = new Queue("legal-visual-render", { connection: redis });
  projectExportQueue = new Queue("project-export", { connection: redis });
  publicationExtraQueue = new Queue("publication-extra", { connection: redis });
  publicationReviewReminderQueue = new Queue(PUBLICATION_REVIEW_REMINDER_QUEUE, { connection: redis });
  await waitForFullWorkerSet();

  browser = await chromium.launch({ headless: true, executablePath: await browserExecutable() });
  browser.on("disconnected", () => {
    browserIssues.push({
      context: "browser",
      kind: "browser.disconnected",
      message: "browser disconnected before test teardown",
      url: "",
      line: 0,
    });
  });
  const context = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  await installBrowserDiagnostics(context, "main");
  page = await context.newPage();
  interfaceEvidence.reducedMotion.main = await page.evaluate(
    () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  assert(interfaceEvidence.reducedMotion.main, "main browser context did not emulate reduced motion");

  const authenticatedRequestFrom = (targetPage, path, { method = "GET", headers = {}, data } = {}) => targetPage.evaluate(
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
  const authenticatedRequest = (path, options) => authenticatedRequestFrom(page, path, options);
  const authenticatedRequestViaContext = async (requestContext, path, { method = "GET", headers = {}, data } = {}) => {
    const response = await requestContext.fetch(path, {
      method,
      headers,
      data,
      failOnStatusCode: false,
      timeout: API_REQUEST_TIMEOUT_MS,
    });
    return {
      status: response.status(),
      ok: response.ok(),
      text: await response.text(),
      headers: {
        contentType: response.headers()["content-type"] || null,
        requestId: response.headers()["x-ai-request-id"] || response.headers()["x-request-id"] || null,
        replayed: response.headers()["x-ai-replayed"] || null,
        acknowledged: response.headers()["x-ai-acknowledged"] || null,
      },
    };
  };
  const reviewTypographyForPublicationFixture = async ({ draftId, text, keyPrefix }) => {
    const dictionaryResponse = await authenticatedRequest("/api/brand-dictionary");
    assert(dictionaryResponse.status === 200, `${keyPrefix} could not load the active typography dictionary`);
    const dictionaryVersion = Number(JSON.parse(dictionaryResponse.text).dictionary?.version);
    const discoveryResponse = await authenticatedRequest("/api/typography/apply", {
      method: "POST",
      data: {
        requestKey: `${keyPrefix}-discover`,
        draftId,
        text,
        expectedDictionaryVersion: dictionaryVersion,
        acceptedSuggestionIds: [],
        rejectedSuggestionIds: [],
        formatQuotes: false,
      },
    });
    assert(
      [200, 201].includes(discoveryResponse.status),
      `${keyPrefix} typography discovery failed: ${discoveryResponse.status}:${discoveryResponse.text}`,
    );
    const discoveryBody = JSON.parse(discoveryResponse.text);
    if (discoveryBody.run?.reviewComplete) return discoveryBody.run;
    const suggestionIds = Array.isArray(discoveryBody.run?.suggestions)
      ? discoveryBody.run.suggestions.map((suggestion) => String(suggestion.id))
      : [];
    assert(suggestionIds.length > 0, `${keyPrefix} typography discovery omitted unresolved suggestions`);
    const reviewResponse = await authenticatedRequest("/api/typography/apply", {
      method: "POST",
      data: {
        requestKey: `${keyPrefix}-review`,
        draftId,
        text,
        expectedDictionaryVersion: dictionaryVersion,
        acceptedSuggestionIds: [],
        rejectedSuggestionIds: suggestionIds,
        formatQuotes: false,
      },
    });
    const reviewBody = JSON.parse(reviewResponse.text);
    assert(
      [200, 201].includes(reviewResponse.status) && reviewBody.run?.reviewComplete === true,
      `${keyPrefix} typography review failed: ${reviewResponse.status}:${reviewResponse.text}`,
    );
    return reviewBody.run;
  };

  // CI starts from a cold Next.js dev cache. Waiting for the full load event here gives
  // framework chunks the default 30-second navigation budget and flakes before the first
  // assertion on slower runners. DOMContentLoaded is the contract needed by the form checks;
  // keep a bounded but explicit cold-compilation budget instead of weakening assertions.
  await page.goto("/register", { waitUntil: "domcontentloaded", timeout: 90_000 });
  await assertTouch(page.locator('input[type="email"]').first(), "auth email");
  await assertTouch(page.locator('input[type="password"]').first(), "auth password");
  await assertTouch(page.locator('button[type="submit"]').first(), "auth submit");
  await assertTouch(page.getByRole("link", { name: "Войти", exact: true }), "auth login link");

  const registration = await context.request.post("/api/auth/register", {
    headers: { origin: baseUrl },
    data: { email: "qa-e2e@aurora.test", password: "qa-password-2026", name: "QA E2E" },
    timeout: API_REQUEST_TIMEOUT_MS,
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
  expectedBrowserConsoleScopes.add("main");
  await composerText.fill("Локальная несинхронизированная версия E2E");
  // Durable browser write-through is the reload invariant. Under a loaded full runtime the
  // debounced PATCH may not have reached the intercepted network route yet, so both pending
  // and explicit offline labels are valid before the hard reload below.
  // The compact Composer keeps the detailed save message inside a collapsed
  // disclosure. Its DOM state is still live; the hard reload below is the actual
  // durability proof and must recover the exact pending text.
  await page.getByText(/изменения сохранены в браузере/iu).waitFor({
    state: "attached",
    timeout: UI_WAIT_TIMEOUT_MS,
  });
  await page.reload();
  await composerText.waitFor();
  assert(await readEditableText(composerText) === "Локальная несинхронизированная версия E2E", "hard reload lost pending draft text");
  await page.unroute(`**/api/drafts/${draftId}`);
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await waitFor(async () => (await pool.query("select text from drafts where id = $1", [draftId])).rows[0]?.text === "Локальная несинхронизированная версия E2E", "pending draft did not synchronize", 12_000);
  expectedBrowserConsoleScopes.delete("main");
  assert(Number((await pool.query("select count(*)::int as n from drafts where id = $1", [draftId])).rows[0].n) === 1, "draft sync created a duplicate");
  const composerProtection = await openComposerSection(page, "composer-protection");
  const composerSaveButton = composerProtection.getByRole("button", { name: /^(Сохранено|Сохранить сейчас)$/u });
  await composerSaveButton.waitFor();
  await assertTouch(composerSaveButton, "composer save");
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

  interfaceEvidence.todayUi = await runTodayWorkspacePass(page, channels, draftId);

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
  if (!firstMediaPoll.ok) {
    const mediaReadDiagnostic = {
      generation: (await pool.query(
        "select id, user_id, project_id, status from media_generations where id = $1",
        [mediaGenerationId],
      )).rows[0] ?? null,
      selectedProjectId: (await pool.query(
        "select selected_project_id from user_project_preferences where user_id = $1",
        [userId],
      )).rows[0]?.selected_project_id ?? null,
      response: firstMediaPoll.text,
    };
    throw new Error(`first media poll failed with ${firstMediaPoll.status}: ${JSON.stringify(mediaReadDiagnostic)}`);
  }
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

  const storedAsset = await context.request.get(mediaTerminal.generation.assetUrl, {
    timeout: API_REQUEST_TIMEOUT_MS,
  });
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
  const libraryReferenceTopic = "Договор и проверяемые условия";
  const libraryReferenceId = Number((await pool.query(
    `insert into competitor_posts
       (competitor_id, tg_msg_id, text, views, reactions, posted_at, media, is_hit, hit_ratio)
     values ($1, 91001, $2, 8000, 120, now() - interval '2 hour', 'photo', true, 6.25)
     returning id`,
    [competitorIds[0], libraryReferenceText],
  )).rows[0].id);
  await pool.query(
    `insert into content_ideas
       (user_id, competitor_id, source_post_id, topic, ai_status)
     values ($1, $2, $3, $4, 'ready')`,
    [userId, competitorIds[0], libraryReferenceId, libraryReferenceTopic],
  );

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
  const libraryReferenceCard = libraryText.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' card-plain ')][1]",
  );
  await libraryText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
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
  const filtersSummary = page.locator("summary").filter({ hasText: "Все фильтры" });
  await filtersSummary.focus();
  await page.keyboard.press("Enter");
  assert(
    await filtersSummary.evaluate((summary) => summary.parentElement?.open === true),
    "keyboard activation did not open Library filters",
  );
  await page.getByRole("button", { name: "Экспорт текущего среза", exact: true }).click();
  await page.getByText(/Один срез данных · 1 запис/u).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
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
    const downloaded = await context.request.get(`${exportUrl.pathname}${exportUrl.search}`, {
      timeout: API_REQUEST_TIMEOUT_MS,
    });
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
  assert(String(referenceDraft?.source_ref?.id) === String(libraryReferenceId), "Studio reference draft lost source post id");
  assert(referenceDraft?.source_ref?.topic === libraryReferenceTopic, "Studio reference draft lost the server-owned topic");
  // A reload while the provider is running must replay the same paid operation. The
  // create intent remains until the terminal result has been persisted as a server draft.
  await page.reload();
  await page.waitForURL((url) => url.pathname === "/app/composer" && /^\d+$/u.test(url.searchParams.get("draft") || ""));
  const composerDraftUrl = new URL(page.url());
  assert(
    composerDraftUrl.searchParams.get("from") === "studio"
      && [...composerDraftUrl.searchParams.keys()].sort().join(",") === "draft,from",
    "Studio leaked reference content or lost its safe return target through Composer URL",
  );
  const libraryComposerDraftId = Number(composerDraftUrl.searchParams.get("draft"));
  const libraryComposerText = page.locator("#composer-text");
  await libraryComposerText.waitFor();
  assert(await readEditableText(libraryComposerText) === libraryComposerResult, "Composer did not hydrate the terminal Studio result");
  const generatedDraft = (await pool.query(
    "select text, origin, source_ref from drafts where id = $1 and user_id = $2",
    [libraryComposerDraftId, userId],
  )).rows[0];
  assert(generatedDraft?.text === libraryComposerResult && generatedDraft?.origin === "ai", "Studio result was not persisted as an AI draft");
  assert(String(generatedDraft?.source_ref?.id) === String(libraryReferenceId), "generated post lost reference provenance");
  const composerActive = desktopSidebar.locator('a[aria-current="page"]');
  assert((await composerActive.textContent())?.includes("Календарь"), "Composer alias did not activate desktop Calendar");

  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/studio" && url.searchParams.get("draft") === String(libraryReferenceDraftId));
  assert(!new URL(page.url()).searchParams.has("intent"), "browser Back restarted the completed paid generation");
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Студия"), "browser Back lost active Studio item");
  await page.goBack();
  await page.waitForURL((url) => url.pathname === "/app/library" && url.searchParams.get("channel") === String(channels[0]));
  const discussReference = libraryReferenceCard.getByRole("button", { name: "Обсудить с Авророй", exact: true });
  await discussReference.waitFor();
  assert((await desktopSidebar.locator('a[aria-current="page"]').textContent())?.includes("Идеи и примеры"), "browser Back lost active Library item");
  await discussReference.click();
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
  await waitForResponsiveLayout(page);
  const libraryOverflow = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const exportButton = [...document.querySelectorAll("button")]
      .find((element) => element.textContent?.includes("Экспорт текущего среза"));
    const chain = [];
    let current = exportButton;
    while (current && chain.length < 10) {
      const rect = current.getBoundingClientRect();
      const style = getComputedStyle(current);
      chain.push({
        tag: current.tagName.toLocaleLowerCase(),
        classes: String(current.className || "").slice(0, 220),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        width: Math.round(rect.width),
        display: style.display,
        minWidth: style.minWidth,
        widthStyle: style.width,
        gridTemplateColumns: style.gridTemplateColumns,
        transform: style.transform,
        overflowX: style.overflowX,
        paddingLeft: style.paddingLeft,
      });
      current = current.parentElement;
    }
    const offenders = [...document.querySelectorAll("body *")]
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLocaleLowerCase(),
          id: element.id,
          classes: String(element.className || "").slice(0, 180),
          left: Math.round(rect.left),
          right: Math.round(rect.right),
          width: Math.round(rect.width),
          text: String(element.textContent || "").trim().replace(/\s+/gu, " ").slice(0, 100),
        };
      })
      .filter((item) => item.right > viewportWidth + 2 || item.left < -2)
      .sort((left, right) => (right.right - viewportWidth) - (left.right - viewportWidth))
      .slice(0, 12);
    return {
      viewportWidth,
      innerWidth: window.innerWidth,
      visualViewportWidth: window.visualViewport?.width,
      rootFontSize: getComputedStyle(document.documentElement).fontSize,
      largeLayoutMatches: matchMedia("(min-width: 64rem)").matches,
      scrollX: window.scrollX,
      scrollWidth: document.documentElement.scrollWidth,
      chain,
      offenders,
    };
  });
  assert(
    libraryOverflow.scrollWidth <= libraryOverflow.viewportWidth + 2,
    `Library has mobile horizontal overflow: ${JSON.stringify(libraryOverflow)}`,
  );
  await page.getByRole("button", { name: "Открыть меню", exact: true }).click();
  const mobileDrawer = page.getByRole("dialog", { name: "Меню платформы" });
  const mobileDrawerActive = mobileDrawer.locator('a[aria-current="page"]');
  assert((await mobileDrawerActive.textContent())?.includes("Идеи и примеры"), "mobile drawer lost active Library item");
  await mobileDrawer.getByRole("button", { name: "Закрыть меню", exact: true }).click();
  await page.locator('nav[aria-label="Основные разделы"]').getByRole("link", { name: "Студия контента", exact: true }).click();
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
  await page.getByRole("heading", { name: "Профиль и исходный бриф", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await page.getByRole("textbox", { name: /^Имя/u }).fill("Анна E2E");
  await page.getByRole("textbox", { name: /^Ниша/u }).fill("Юридическая безопасность бизнеса");
  await page.getByRole("textbox", { name: /^Аудитория/u }).fill("Владельцы компаний и legal operations");
  await page.getByLabel("Цель", { exact: true }).fill("Объяснять проверяемые изменения без обещаний");
  await page.getByLabel("Роль автора", { exact: true }).fill("Управляющий партнёр и автор");
  await page.getByLabel("Рубрики", { exact: true }).fill("Практика, Разборы");
  await page.getByLabel("Форматы", { exact: true }).fill("Текст, Видео");
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Сохранить профиль", exact: true }).click();
  await page.getByText("Профиль и исходный бриф сохранены.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
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
  await page.getByRole("heading", { name: "Профиль и исходный бриф", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await page.getByRole("textbox", { name: /^Имя/u }).inputValue() === "Анна E2E", "profile name did not survive reload");
  assert(await page.getByRole("textbox", { name: /^Ниша/u }).inputValue() === "Юридическая безопасность бизнеса", "profile brief did not survive reload");
  assert(await page.getByLabel("Форматы", { exact: true }).inputValue() === "Текст, Видео", "profile formats did not survive reload");
  const savedGoal = await page.getByLabel("Цель", { exact: true }).inputValue();
  await page.getByLabel("Цель", { exact: true }).fill(`${savedGoal} — черновик`);
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor();
  await page.getByLabel("Цель", { exact: true }).fill(savedGoal);
  await page.getByText("Есть несохранённые изменения", { exact: true }).waitFor({ state: "detached" });
  assert(
    await desktopSidebar.getByRole("link", { name: "Настройки", exact: true }).getAttribute("aria-current") === "page",
    "desktop Settings item is not active",
  );

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
       (project_id, user_id, request_id, idempotency_key, request_fingerprint, target_url,
        confirmed_domain, consented_at, status, stage, progress, progress_detail,
        result, run_revision, queue_confirmed_at, completed_at, prompt_version,
        question_catalog_version, snapshot_hash, coverage_mode, answered_count, question_count)
     select preference.selected_project_id, $1,
            '11111111-1111-4111-8111-111111111111', 'e2e-site-analysis-ready', $2,
            'https://example.com/', 'example.com', now(), 'ready', 'ready', 100,
            'OSINT-интервью и маркетинговый план готовы', $3::jsonb, 1, now(), now(),
            'site-osint-interview-v1', 'site-osint-questions-v1', $4, 'site_only', $5, $5
       from user_project_preferences preference where preference.user_id = $1
     returning id`,
    [userId, "c".repeat(64), JSON.stringify(siteReport), siteSnapshotHash, SITE_INTERVIEW_QUESTIONS.length],
  )).rows[0].id);

  await page.goto("/app/site-analysis");
  await page.getByText(`${SITE_INTERVIEW_QUESTIONS.length} вопросов`, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
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
    const downloaded = await context.request.get(href, { timeout: API_REQUEST_TIMEOUT_MS });
    assert(downloaded.status() === 200, `site analysis export failed: ${href}`);
  }
  await page.reload();
  await page.getByText(`${SITE_INTERVIEW_QUESTIONS.length} вопросов`, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await page.setViewportSize({ width: 390, height: 844 });
  await assertNoHorizontalOverflow(page, "site analysis mobile");
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
  const truncatedDone = truncatedEvents.find((event) => event.type === "done");
  const truncatedValidation = truncatedEvents.find((event) => event.type === "validation");
  assert(truncated.status === 200, `truncated AI request failed before streaming (${truncated.status})`);
  assert(truncated.headers.contentType?.startsWith("application/x-ndjson"), "chat did not use the confirmed NDJSON contract");
  assert(
    truncatedValidation?.status === "blocked"
      && truncatedValidation?.requiresReview === true
      && truncatedValidation?.blockerCodes?.includes("provider:stream_truncated"),
    "truncated provider stream was not preserved as a blocked review draft",
  );
  assert(
    truncatedDone?.requestId === truncated.headers.requestId && truncatedDone?.ackRequired === true,
    "truncated review draft omitted its durable ACK-required terminal event",
  );
  assert(!truncatedEvents.some((event) => event.type === "error"), "truncated review draft emitted an error terminal event");
  assert(
    fakeState.ai.providerIdentityOk
      && fakeState.ai.identities.find((identity) => identity.kind === "truncated")?.requestId === truncated.headers.requestId,
    "truncated chat provider call omitted its idempotency or correlation identity",
  );
  const stagedTruncatedUsage = (await pool.query(
    "select status, result_payload from ai_usage where reservation_key = 'web:e2e_truncated_ai_1'",
  )).rows[0];
  assert(
    stagedTruncatedUsage?.status === "reserved"
      && stagedTruncatedUsage?.result_payload?.validation?.blockerCodes?.includes("provider:stream_truncated"),
    "truncated review draft was not durably staged with its technical blocker",
  );
  const truncatedAck = await authenticatedRequestViaContext(context.request, "/api/ai/generate/ack", {
    method: "POST",
    headers: {
      "idempotency-key": "e2e_truncated_ai_1",
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
    },
  });
  const truncatedAckBody = JSON.parse(truncatedAck.text);
  assert(
    truncatedAck.status === 200
      && truncatedAckBody.ok === true
      && truncatedAckBody.status === "committed",
    "truncated review draft could not be acknowledged after durable delivery",
  );
  assert(
    (await pool.query("select status from ai_usage where reservation_key = 'web:e2e_truncated_ai_1'")).rows[0]?.status === "committed",
    "acknowledged truncated review draft did not commit exactly one quota reservation",
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

  const publicationProjectId = Number((await pool.query(
    "select selected_project_id from user_project_preferences where user_id = $1",
    [userId],
  )).rows[0]?.selected_project_id);
  assert(Number.isSafeInteger(publicationProjectId) && publicationProjectId > 0, "publication fixture lost selected project");
  const assetId = Number((await pool.query(
    `insert into media_assets (project_id, user_id, kind, file_name, mime_type, bytes, data, sha256)
     values ($1, $2, 'image', 'qa.png', 'image/png', 4, decode('89504e47','hex'), 'e2e-image') returning id`,
    [publicationProjectId, userId],
  )).rows[0].id);
  const publicationInstant = new Date();
  publicationInstant.setUTCSeconds(0, 0);
  const publicationDraftResponse = await authenticatedRequest("/api/drafts", {
    method: "POST",
    data: {
      clientKey: "draft_e2e_publication_pipeline_1",
      text: `Длинный текст E2E. ${"Проверяем продолжение без дубля медиа. ".repeat(40)}`,
      media: {
        kind: "image",
        label: "Безопасное E2E-изображение",
        hue: 210,
        assetId: String(assetId),
        url: `/api/media/assets/${assetId}`,
        mimeType: "image/png",
      },
      scheduledAt: publicationInstant.toISOString(),
      schedule: {
        localDate: publicationInstant.toISOString().slice(0, 10),
        localTime: publicationInstant.toISOString().slice(11, 16),
        timezone: "UTC",
        offset: "+00:00",
        disambiguation: "reject",
      },
      origin: "manual",
      sourceRef: null,
      channelIds: [channels[0]],
      aiValidation: null,
    },
  });
  assert(
    publicationDraftResponse.status === 201,
    `publication draft API failed with ${publicationDraftResponse.status}:${publicationDraftResponse.text}`,
  );
  const publicationDraft = JSON.parse(publicationDraftResponse.text).draft;
  assert(publicationDraft?.version === 1, "publication draft API omitted immutable version 1");
  const publicationRevision = (await pool.query(
    `select revision.id, revision.content_hash, revision.draft_version
       from draft_revisions revision
      where revision.project_id = $1 and revision.draft_id = $2
      order by revision.draft_version desc limit 1`,
    [publicationProjectId, publicationDraft.id],
  )).rows[0];
  assert(
    Number(publicationRevision?.draft_version) === Number(publicationDraft.version)
      && /^[0-9a-f]{64}$/u.test(String(publicationRevision?.content_hash)),
    "publication fixture did not create an approvable exact draft revision",
  );
  const publicationApprovalSetup = await pool.query(
    `update draft_editorial_workflows
        set state = 'approved', approved_revision_id = $3,
            approved_content_hash = $4, version = version + 1, updated_at = now()
      where project_id = $1 and draft_id = $2 and current_revision_id = $3`,
    [publicationProjectId, publicationDraft.id, publicationRevision.id, publicationRevision.content_hash],
  );
  assert(publicationApprovalSetup.rowCount === 1, "publication fixture revision was not bound to exact editorial approval");
  await reviewTypographyForPublicationFixture({
    draftId: publicationDraft.id,
    text: publicationDraft.text,
    keyPrefix: "e2e-publication-typography",
  });

  const operationRequest = {
    method: "POST",
    headers: { "idempotency-key": "e2e_publication_pipeline_1" },
    data: {
      draftId: publicationDraft.id,
      draftVersion: publicationDraft.version,
      timezone: "UTC",
    },
  };
  const [operationLeft, operationRight] = await Promise.all([
    authenticatedRequest("/api/publication-operations", operationRequest),
    authenticatedRequest("/api/publication-operations", operationRequest),
  ]);
  assert(
    [operationLeft.status, operationRight.status].every((status) => status === 200 || status === 201),
    `parallel publication API failed: ${operationLeft.status}/${operationRight.status}: ${operationLeft.text} | ${operationRight.text}`,
  );
  const operationLeftBody = JSON.parse(operationLeft.text);
  const operationRightBody = JSON.parse(operationRight.text);
  assert(
    Number(operationLeftBody.operationId) === Number(operationRightBody.operationId),
    "double schedule created different publication operations",
  );
  const publicationOperationId = Number(operationLeftBody.operationId);
  const publicationPostId = Number(operationLeftBody.destinations?.[0]?.postId);
  const publicationRows = (await pool.query(
    `select operation.id, operation.draft_version, operation.schedule_revision,
            count(distinct post.id)::int as posts,
            count(distinct outbox.id)::int as outbox_rows
       from publication_operations operation
       join posts post on post.publication_operation_id = operation.id
       join publication_outbox outbox on outbox.operation_id = operation.id and outbox.post_id = post.id
      where operation.draft_id = $1 and operation.draft_version = $2
      group by operation.id, operation.draft_version, operation.schedule_revision`,
    [publicationDraft.id, publicationDraft.version],
  )).rows;
  assert(publicationRows.length === 1, "draft revision produced more than one immutable operation");
  assert(
    Number(publicationRows[0].id) === publicationOperationId
      && Number(publicationRows[0].draft_version) === 1
      && Number(publicationRows[0].schedule_revision) === 1
      && publicationRows[0].posts === 1
      && publicationRows[0].outbox_rows === 1,
    "publication operation did not create exactly one revision/post/outbox destination",
  );
  await waitFor(async () => (await pool.query("select status from posts where id = $1", [publicationPostId])).rows[0]?.status === "published", "multipart publication did not recover", 15_000);
  const parts = (await pool.query(
    "select part_index, part_type, external_message_id, send_status from publication_parts where post_id = $1 order by part_index",
    [publicationPostId],
  )).rows;
  assert(parts.length === 2 && parts.every((part) => part.send_status === "sent"), "multipart external IDs were not both persisted");
  assert(fakeState.telegram.photoCalls === 1 && fakeState.telegram.textCalls === 2, "multipart retry duplicated media or skipped text retry");

  // One multi-destination text publication proves capability routing rather than
  // pretending every network supports every follow-up: VK closes comments, while
  // Telegram performs the pin. The inverse unsupported operations stay terminal and
  // never reach either provider.
  const commentsProjectId = Number((await pool.query(
    "select selected_project_id from user_project_preferences where user_id = $1",
    [userId],
  )).rows[0]?.selected_project_id);
  const commentsVkGroupId = 77_001;
  const commentsVkChannelId = Number((await pool.query(
    `insert into channels
       (project_id, user_id, network, vk_group_id, vk_token, title, handle, is_active, status)
     values ($1, $2, 'vk', $3, $4, 'Поддержанный VK-канал QA', 'aurora_vk_supported_qa', true, 'active')
     returning id`,
    [commentsProjectId, userId, commentsVkGroupId, encryptE2eVkToken(userId)],
  )).rows[0].id);
  const commentsPublicationInstant = new Date();
  commentsPublicationInstant.setUTCSeconds(0, 0);
  const commentsDraftResponse = await authenticatedRequest("/api/drafts", {
    method: "POST",
    data: {
      clientKey: "draft_e2e_supported_comments_1",
      text: "Проверяем реальную публикацию и отдельные настройки комментариев на поддержанных площадках.",
      media: null,
      scheduledAt: commentsPublicationInstant.toISOString(),
      schedule: {
        localDate: commentsPublicationInstant.toISOString().slice(0, 10),
        localTime: commentsPublicationInstant.toISOString().slice(11, 16),
        timezone: "UTC",
        offset: "+00:00",
        disambiguation: "reject",
      },
      origin: "manual",
      sourceRef: null,
      channelIds: [channels[0], commentsVkChannelId],
      aiValidation: null,
    },
  });
  assert(
    commentsDraftResponse.status === 201,
    `supported comments draft API failed with ${commentsDraftResponse.status}:${commentsDraftResponse.text}`,
  );
  const commentsDraft = JSON.parse(commentsDraftResponse.text).draft;
  const commentsPreferencesResponse = await authenticatedRequest(
    `/api/drafts/${commentsDraft.id}/publication-preferences`,
    {
      method: "PUT",
      data: {
        expectedVersion: 0,
        selectedBlockIds: [],
        firstCommentFallback: "skip",
        commentsMode: "disabled",
        pinAfterPublish: true,
        reviewAt: null,
        reviewResponsibleUserId: null,
      },
    },
  );
  assert(
    commentsPreferencesResponse.status === 200,
    `commentsMode API failed with ${commentsPreferencesResponse.status}:${commentsPreferencesResponse.text}`,
  );
  const commentsPreferences = JSON.parse(commentsPreferencesResponse.text).preferences;
  assert(
    commentsPreferences?.commentsMode === "disabled"
      && commentsPreferences?.pinAfterPublish === true
      && Number(commentsPreferences?.draftVersion) === Number(commentsDraft.version) + 1,
    "commentsMode=disabled and pin were not persisted as a new immutable draft version",
  );
  const commentsRevision = (await pool.query(
    `select revision.id, revision.content_hash, revision.draft_version
       from draft_revisions revision
      where revision.project_id = $1 and revision.draft_id = $2
      order by revision.draft_version desc limit 1`,
    [commentsProjectId, commentsDraft.id],
  )).rows[0];
  assert(
    Number(commentsRevision?.draft_version) === Number(commentsPreferences.draftVersion)
      && /^[0-9a-f]{64}$/u.test(String(commentsRevision?.content_hash)),
    "comments settings did not create an approvable exact draft revision",
  );
  // Editorial approval is deterministic setup here; publication and every provider
  // side effect below still run through the real authenticated API, durable outboxes,
  // BullMQ workers and provider adapters.
  const commentsApprovalSetup = await pool.query(
    `update draft_editorial_workflows
        set state = 'approved', approved_revision_id = $3,
            approved_content_hash = $4, version = version + 1, updated_at = now()
      where project_id = $1 and draft_id = $2 and current_revision_id = $3`,
    [commentsProjectId, commentsDraft.id, commentsRevision.id, commentsRevision.content_hash],
  );
  assert(commentsApprovalSetup.rowCount === 1, "comments test revision was not bound to exact editorial approval");
  await reviewTypographyForPublicationFixture({
    draftId: commentsDraft.id,
    text: commentsDraft.text,
    keyPrefix: "e2e-comments-typography",
  });
  const telegramTextBeforeCommentsPublication = fakeState.telegram.textCalls;
  const telegramPinBeforeCommentsPublication = fakeState.telegram.pinCalls;
  // Resolve the immediate publication slot at mutation time. Reusing the draft's
  // minute after the approval/typography setup can cross the API's one-minute
  // clock-skew boundary and turn this fixture into a request for the past.
  const commentsOperationInstant = new Date();
  commentsOperationInstant.setUTCSeconds(0, 0);
  const commentsOperationResponse = await authenticatedRequest("/api/publication-operations", {
    method: "POST",
    headers: { "idempotency-key": "e2e_supported_comments_publication_1" },
    data: {
      draftId: commentsDraft.id,
      draftVersion: commentsPreferences.draftVersion,
      timezone: "UTC",
      schedule: {
        scheduledAt: commentsOperationInstant.toISOString(),
        localDate: commentsOperationInstant.toISOString().slice(0, 10),
        localTime: commentsOperationInstant.toISOString().slice(11, 16),
        timezone: "UTC",
        offset: "+00:00",
        disambiguation: "reject",
      },
    },
  });
  assert(
    [200, 201].includes(commentsOperationResponse.status),
    `supported comments publication failed with ${commentsOperationResponse.status}:${commentsOperationResponse.text}`,
  );
  const commentsOperation = JSON.parse(commentsOperationResponse.text);
  const commentsOperationId = Number(commentsOperation.operationId);
  const commentsDestinationIds = commentsOperation.destinations.map((destination) => Number(destination.postId));
  assert(
    Number.isSafeInteger(commentsOperationId)
      && commentsDestinationIds.length === 2
      && new Set(commentsDestinationIds).size === 2,
    "multi-provider comments publication did not create two distinct destinations",
  );
  const commentsDestinationRows = await waitFor(async () => {
    const rows = (await pool.query(
      `select post.id, post.status, post.external_message_id, post.vk_post_id, channel.network
         from posts post
         join channels channel on channel.id = post.channel_id and channel.project_id = post.project_id
        where post.publication_operation_id = $1
        order by channel.network`,
      [commentsOperationId],
    )).rows;
    return rows.length === 2 && rows.every((row) => row.status === "published") ? rows : null;
  }, "Telegram and VK destinations did not both reach published", 30_000);
  const commentsExtraRows = await waitFor(async () => {
    const rows = (await pool.query(
      `select channel.network, extra.kind, extra.status, extra.attempts, extra.request_snapshot,
              extra.last_error_code, extra.last_error_message
         from publication_extra_operations extra
         join channels channel on channel.id = extra.channel_id and channel.project_id = extra.project_id
        where extra.publication_operation_id = $1
        order by channel.network, extra.sequence_index`,
      [commentsOperationId],
    )).rows;
    const failed = rows.find((row) => row.status === "failed");
    if (failed) {
      throw new Error(
        `publication-extra failed: ${JSON.stringify({
          row: failed,
          vkRequests: fakeState.vk.requests,
        })}`,
      );
    }
    return rows.length === 4
      && rows.every((row) => ["succeeded", "unsupported"].includes(row.status))
      ? rows
      : null;
  }, "comments/pin capability operations did not reach terminal states", 30_000);
  const terminalExtra = (network, kind) => commentsExtraRows.find(
    (row) => row.network === network && row.kind === kind,
  );
  assert(
    terminalExtra("vk", "configure_comments")?.status === "succeeded"
      && Number(terminalExtra("vk", "configure_comments")?.attempts) === 1
      && terminalExtra("vk", "configure_comments")?.request_snapshot?.commentsEnabled === false
      && terminalExtra("vk", "pin")?.status === "unsupported"
      && Number(terminalExtra("vk", "pin")?.attempts) === 0
      && terminalExtra("tg", "configure_comments")?.status === "unsupported"
      && Number(terminalExtra("tg", "configure_comments")?.attempts) === 0
      && terminalExtra("tg", "pin")?.status === "succeeded"
      && Number(terminalExtra("tg", "pin")?.attempts) === 1,
    "provider capability routing invented support or lost a supported terminal operation",
  );
  const vkPostRequest = fakeState.vk.requests.find((request) => request.method === "wall.post");
  const vkCloseCommentsRequest = fakeState.vk.requests.find((request) => request.method === "wall.closeComments");
  assert(
    fakeState.vk.wallPostCalls === 1
      && fakeState.vk.closeCommentsCalls === 1
      && vkPostRequest?.params?.owner_id === `-${commentsVkGroupId}`
      && /^[0-9a-f]{32}$/u.test(String(vkPostRequest?.params?.guid))
      && vkCloseCommentsRequest?.params?.owner_id === `-${commentsVkGroupId}`
      && vkCloseCommentsRequest?.params?.post_id === "8801"
      && !("access_token" in (vkPostRequest?.params || {}))
      && !("access_token" in (vkCloseCommentsRequest?.params || {})),
    "fake VK evidence does not prove one credential-safe wall.post followed by wall.closeComments",
  );
  assert(
    fakeState.telegram.textCalls === telegramTextBeforeCommentsPublication + 1
      && fakeState.telegram.pinCalls === telegramPinBeforeCommentsPublication + 1
      && fakeState.telegram.pinnedMessageId === 702,
    "supported Telegram destination did not publish and pin exactly once",
  );
  await reconcilePublicationExtraRuntime({
    pool,
    enqueue: (data) => enqueuePublicationExtraJob(data, publicationExtraQueue, 10_000),
    limit: 10,
  });
  assert(
    fakeState.vk.closeCommentsCalls === 1
      && fakeState.telegram.pinCalls === telegramPinBeforeCommentsPublication + 1,
    "replaying publication-extra reconciliation duplicated a terminal provider action",
  );
  const pinCallsBeforeCriticalPublication = fakeState.telegram.pinCalls;

  // Critical release journey. UI is used wherever the product exposes an interface;
  // API calls below are limited to deterministic setup and workflows that have no UI.
  const criticalProjectName = "Критический проект QA";
  const reviewerEmail = "qa-approver@aurora.test";
  const reviewerName = "QA Approver";
  const legacyProjectId = Number((await pool.query(
    "select selected_project_id from user_project_preferences where user_id = $1",
    [userId],
  )).rows[0]?.selected_project_id);
  assert(Number.isSafeInteger(legacyProjectId) && legacyProjectId > 0, "legacy selected project is missing");

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/settings?section=general");
  await page.getByRole("heading", { name: "Настройки", exact: true }).waitFor();
  await assertNoHorizontalOverflow(page, "project settings desktop");
  const projectNameInput = page.locator("#project-team-name");
  await projectNameInput.waitFor();
  await projectNameInput.fill(criticalProjectName);
  await page.locator("#project-team-timezone").selectOption("UTC");
  await assertTouch(page.getByRole("button", { name: "Создать проект", exact: true }), "create project");
  await projectNameInput.focus();
  await page.keyboard.press("Enter");
  await page.getByText(`Проект «${criticalProjectName}» создан и выбран.`, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const sharedProjectId = Number((await pool.query(
    "select selected_project_id from user_project_preferences where user_id = $1",
    [userId],
  )).rows[0]?.selected_project_id);
  assert(Number.isSafeInteger(sharedProjectId) && sharedProjectId > 0 && sharedProjectId !== legacyProjectId, "UI project creation did not select a distinct project");
  await waitFor(async () => {
    const response = await authenticatedRequest("/api/projects/current");
    const current = response.status === 200 ? JSON.parse(response.text).project : null;
    return Number(current?.projectId) === sharedProjectId;
  }, "project creation toast appeared before the client adopted the selected project", 12_000);
  const sharedMembership = (await pool.query(
    "select role, status from project_members where project_id = $1 and user_id = $2",
    [sharedProjectId, userId],
  )).rows[0];
  assert(sharedMembership?.role === "owner" && sharedMembership?.status === "active", "project creator is not the active owner");

  const ownerLegacyDraft = await authenticatedRequestViaContext(context.request, `/api/drafts/${draftId}`);
  assert([403, 404].includes(ownerLegacyDraft.status), "selected-project isolation exposed a legacy draft to the owner");

  const sharedChannelId = Number((await pool.query(
    `insert into channels (project_id, user_id, network, tg_chat_id, title, handle, is_active)
     values ($1, $2, 'tg', -100900000099, 'Критический legal-tech канал', 'aurora_critical_qa', true)
     returning id`,
    [sharedProjectId, userId],
  )).rows[0].id);
  const criticalQuality = {
    preset: "expert",
    minChars: 500,
    maxChars: 950,
    address: "neutral",
    factsPolicy: "open",
    qualityThreshold: 85,
    emojiPolicy: "none",
    maxEmojis: 0,
    hashtagsPolicy: "none",
    maxHashtags: 0,
    disclaimerRequired: false,
  };
  await pool.query(
    `insert into content_brief
       (project_id, user_id, channel_id, niche, audience, rubrics, formats, author_role,
        goal, cta, taboo, quality, ready, source)
     values ($1, $2, $3, 'Правовые технологии', 'руководители юридических команд',
             array['Практика','Разбор','Инструменты'], array['Текст','Карусель'],
             'Редактор legal-tech команды', 'объяснять рабочие подходы',
             'Обсудить задачу с командой', 'без обещаний результата', $4::jsonb, true, 'manual')`,
    [sharedProjectId, userId, sharedChannelId, JSON.stringify(criticalQuality)],
  );
  const autopilotSettingsResponse = await authenticatedRequest("/api/autopilot/settings", {
    method: "POST",
    data: {
      channelId: sharedChannelId,
      post_frequency: 3,
      generation_engine: "navy-deepseek-pro",
      planning_weeks: 1,
      quick_settings: { newsPerWeek: 4, detail: 3, energy: 2, emoji: 1 },
    },
  });
  assert(autopilotSettingsResponse.status === 200, `autopilot settings failed: ${autopilotSettingsResponse.status}:${autopilotSettingsResponse.text}`);
  const storedAutopilotSettings = (await pool.query(
    `select post_frequency, generation_engine, planning_weeks, quick_settings
       from autopilot_settings where project_id = $1 and channel_id = $2`,
    [sharedProjectId, sharedChannelId],
  )).rows[0];
  assert(
    Number(storedAutopilotSettings?.post_frequency) === 3
      && storedAutopilotSettings?.generation_engine === "navy-deepseek-pro"
      && Number(storedAutopilotSettings?.planning_weeks) === 1
      && Number(storedAutopilotSettings?.quick_settings?.newsPerWeek) === 4
      && Number(storedAutopilotSettings?.quick_settings?.detail) === 3
      && Number(storedAutopilotSettings?.quick_settings?.energy) === 2
      && Number(storedAutopilotSettings?.quick_settings?.emoji) === 1,
    "autopilot generation settings were not persisted in the shared project",
  );

  const trackingOriginInput = page.getByRole("textbox", { name: "Адрес сайта", exact: true });
  await trackingOriginInput.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await trackingOriginInput.fill(fakeBase);
  const saveTrackingConnection = page.getByRole("button", { name: "Сохранить подключение", exact: true });
  await assertTouch(saveTrackingConnection, "save tracking connection");
  await saveTrackingConnection.click();
  await page.getByText("Настройки сохранены. Размести проверочный файл на сайте и подтверди домен.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const verificationFileInput = page.getByLabel("Содержимое проверочного файла", { exact: true });
  await verificationFileInput.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const trackingBeforeVerifyResponse = await authenticatedRequest("/api/tracking/settings");
  assert(trackingBeforeVerifyResponse.status === 200, "tracking settings are unavailable to the project owner");
  const trackingConfigured = JSON.parse(trackingBeforeVerifyResponse.text).tracking;
  assert(typeof trackingConfigured.publicKey === "string" && trackingConfigured.publicKey.length >= 20, "tracking setup omitted the public key");
  assert(
    await verificationFileInput.inputValue() === trackingConfigured.verificationFileContent,
    "tracking UI did not show the server-owned domain verification challenge",
  );
  const trackerPing = await fetch(`${baseUrl}/api/tracking/ping`, {
    method: "POST",
    headers: { origin: fakeBase, "content-type": "application/json" },
    body: JSON.stringify({ publicKey: trackingConfigured.publicKey }),
  });
  assert(trackerPing.status === 200, `first-party tracker ping failed with ${trackerPing.status}`);
  const pingOnlyTracking = (await pool.query(
    "select status, signal_received_at from project_tracking_settings where project_id = $1",
    [sharedProjectId],
  )).rows[0];
  assert(
    pingOnlyTracking?.status === "pending_verification" && pingOnlyTracking?.signal_received_at,
    "an unauthenticated tracker ping must record a signal without activating the project",
  );
  fakeState.trackerVerificationChallenge = trackingConfigured.verificationFileContent;
  const verifyTrackingDomain = page.getByRole("button", { name: "Подтвердить домен", exact: true });
  await assertTouch(verifyTrackingDomain, "verify tracking domain");
  await verifyTrackingDomain.click();
  await page.getByText("Домен подтверждён. События заявок можно учитывать в аналитике.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const trackingVerifiedResponse = await authenticatedRequest("/api/tracking/settings");
  const trackingVerified = JSON.parse(trackingVerifiedResponse.text).tracking;
  assert(
    trackingVerified?.status === "active" && trackingVerified?.verifiedAt,
    "authenticated well-known challenge verification did not activate tracking",
  );

  const inviteEmailInput = page.locator("#project-invite-email");
  await inviteEmailInput.fill(reviewerEmail);
  await page.locator("#project-invite-role").selectOption("approver");
  const createInviteButton = page.getByRole("button", { name: "Создать приглашение", exact: true });
  await assertTouch(createInviteButton, "create project invitation");
  await createInviteButton.click();
  const inviteLinkInput = page.getByLabel("Одноразовая ссылка приглашения", { exact: true });
  await inviteLinkInput.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const inviteUrl = await inviteLinkInput.inputValue();
  const inviteToken = new URL(inviteUrl).hash.replace(/^#token=/u, "");
  assert(inviteToken.length >= 32, "one-time invitation URL omitted its raw token");
  const persistedInvite = (await pool.query(
    `select token_hash, role from project_invitations
      where project_id = $1 and email = $2 order by id desc limit 1`,
    [sharedProjectId, reviewerEmail],
  )).rows[0];
  assert(
    persistedInvite?.role === "approver"
      && /^[0-9a-f]{64}$/u.test(String(persistedInvite.token_hash))
      && String(persistedInvite.token_hash) !== inviteToken,
    "invitation storage did not retain only the token hash",
  );

  const reviewerContext = await browser.newContext({
    baseURL: baseUrl,
    viewport: { width: 390, height: 844 },
    reducedMotion: "reduce",
  });
  await installBrowserDiagnostics(reviewerContext, "reviewer");
  const reviewerRegistration = await reviewerContext.request.post("/api/auth/register", {
    headers: { origin: baseUrl },
    data: { email: reviewerEmail, password: "qa-approver-password-2026", name: reviewerName },
    timeout: API_REQUEST_TIMEOUT_MS,
  });
  assert(reviewerRegistration.ok(), `reviewer registration failed with ${reviewerRegistration.status()}`);
  const reviewerUserId = Number((await pool.query(
    "select id from users where email = $1",
    [reviewerEmail],
  )).rows[0]?.id);
  assert(Number.isSafeInteger(reviewerUserId) && reviewerUserId > 0, "second project user was not persisted");
  await pool.query(
    "update users set onboarding_completed_at = now(), ai_engine = 'openai', tg_chat_id = $2 where id = $1",
    [reviewerUserId, 990_000_001],
  );
  const reviewerPage = await reviewerContext.newPage();
  interfaceEvidence.reducedMotion.reviewer = await reviewerPage.evaluate(
    () => globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  assert(interfaceEvidence.reducedMotion.reviewer, "reviewer browser context did not emulate reduced motion");
  await reviewerPage.goto(inviteUrl);
  const acceptInvitation = reviewerPage.getByRole("button", { name: "Принять приглашение", exact: true });
  await acceptInvitation.waitFor();
  await assertTouch(acceptInvitation, "accept project invitation");
  await acceptInvitation.focus();
  await reviewerPage.keyboard.press("Enter");
  await reviewerPage.getByText("Приглашение принято", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const openAcceptedProject = reviewerPage.getByRole("button", { name: "Открыть проект", exact: true });
  await assertTouch(openAcceptedProject, "open accepted project");
  await openAcceptedProject.click();
  await reviewerPage.waitForURL(/\/app\/calendar/u);
  const reviewerMembership = (await pool.query(
    "select role, status from project_members where project_id = $1 and user_id = $2",
    [sharedProjectId, reviewerUserId],
  )).rows[0];
  assert(reviewerMembership?.role === "approver" && reviewerMembership?.status === "active", "invitation did not grant the approver role");
  assert(Number((await pool.query(
    "select selected_project_id from user_project_preferences where user_id = $1",
    [reviewerUserId],
  )).rows[0]?.selected_project_id) === sharedProjectId, "accepted project was not selected for the reviewer");
  const reviewerLegacyDraft = await authenticatedRequestViaContext(reviewerContext.request, `/api/drafts/${draftId}`);
  assert([403, 404].includes(reviewerLegacyDraft.status), "selected-project isolation exposed the owner's legacy draft to the reviewer");

  await page.goto("/app/settings?section=posts");
  const publicationBlocksSection = page.locator("#publication-blocks");
  await publicationBlocksSection.waitFor();
  const createPublicationBlock = async (kind, name, content) => {
    await publicationBlocksSection.getByRole("button", { name: "Добавить блок", exact: true }).click();
    await publicationBlocksSection.getByRole("combobox", { name: "Тип блока", exact: true }).selectOption(kind);
    await publicationBlocksSection.getByLabel("Название", { exact: true }).fill(name);
    await publicationBlocksSection.getByLabel("Текст блока", { exact: true }).fill(content);
    const createButton = publicationBlocksSection.getByRole("button", { name: "Создать блок", exact: true });
    await assertTouch(createButton, `create ${kind} block`);
    await createButton.click();
    await publicationBlocksSection.getByText(name, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  };
  await createPublicationBlock("author_signature", "Подпись команды QA", "Команда «Аврора» — редакция legal-tech проекта.");
  await createPublicationBlock("first_comment", "Первый комментарий QA", "Материалы и запись на консультацию доступны по ссылке в публикации.");
  const publicationBlockRows = (await pool.query(
    `select id, kind, name from project_publication_blocks
      where project_id = $1 and name in ('Подпись команды QA','Первый комментарий QA')
      order by id`,
    [sharedProjectId],
  )).rows;
  assert(publicationBlockRows.length === 2, "publication block UI did not persist both reusable blocks");
  const signatureBlockId = Number(publicationBlockRows.find((row) => row.kind === "author_signature")?.id);
  const firstCommentBlockId = Number(publicationBlockRows.find((row) => row.kind === "first_comment")?.id);
  assert(signatureBlockId > 0 && firstCommentBlockId > 0, "publication block kinds were not preserved");

  const brandDictionary = page.locator("section").filter({ has: page.getByRole("heading", { name: "Словарь бренда", exact: true }) }).first();
  await brandDictionary.getByRole("form", { name: "Новое правило словаря", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await brandDictionary.locator("#brand-dictionary-kind").selectOption("prohibited");
  await brandDictionary.locator("#brand-dictionary-term").fill("легалтех");
  await brandDictionary.locator("#brand-dictionary-replacement").fill("LegalTech");
  const addBrandRule = brandDictionary.getByRole("button", { name: "Добавить правило", exact: true });
  await assertTouch(addBrandRule, "add prohibited brand dictionary rule");
  await addBrandRule.click();
  await brandDictionary.getByText("Правило добавлено в словарь проекта.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const brandRuleEvidence = (await pool.query(
    `select dictionary.version as dictionary_version, entry.kind, entry.term, entry.replacement, entry.is_active
       from project_brand_dictionaries dictionary
       join project_brand_dictionary_entries entry on entry.project_id = dictionary.project_id
      where dictionary.project_id = $1 and lower(entry.term) = 'легалтех'
      order by entry.id desc limit 1`,
    [sharedProjectId],
  )).rows[0];
  assert(
    Number(brandRuleEvidence?.dictionary_version) >= 2
      && brandRuleEvidence?.kind === "prohibited"
      && brandRuleEvidence?.term === "легалтех"
      && brandRuleEvidence?.replacement === "LegalTech"
      && brandRuleEvidence?.is_active === true,
    "brand dictionary UI did not persist the prohibited project rule",
  );

  await page.goto("/app/autopilot/month");
  await page.getByRole("heading", { name: "Сетка тем на месяц", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const monthDate = new Date();
  monthDate.setUTCMonth(monthDate.getUTCMonth() + 1, 1);
  const campaignMonth = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, "0")}`;
  await page.locator("#campaign-month").fill(campaignMonth);
  await page.locator("#campaign-goal").fill("Показать практические сценарии правовых технологий без рекламных обещаний");
  await page.locator("#campaign-audience").fill("руководители юридических команд");
  const advancedCampaign = page.getByRole("button", { name: "Рубрики, воронка и метрики", exact: true });
  await advancedCampaign.click();
  await page.locator("#campaign-frequency").selectOption("3");
  await page.locator("#campaign-practices").fill("автоматизация договоров, юридическая аналитика");
  const assembleMonth = page.getByRole("button", { name: "Собрать сетку месяца", exact: true });
  await assertTouch(assembleMonth, "assemble monthly campaign");
  await assembleMonth.click();
  await page.getByText("Сетка собрана. Проверь темы и отправь план на согласование.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const monthlyCampaign = (await pool.query(
    `select campaign.id, campaign.project_id, campaign.posts_per_week, plan.id as plan_id, plan.status
       from monthly_campaigns campaign
       join monthly_campaign_plans plan on plan.campaign_id = campaign.id and plan.project_id = campaign.project_id
      where campaign.project_id = $1 order by campaign.id desc, plan.revision desc limit 1`,
    [sharedProjectId],
  )).rows[0];
  assert(
    Number(monthlyCampaign?.project_id) === sharedProjectId
      && Number(monthlyCampaign?.posts_per_week) === 3
      && monthlyCampaign?.status === "draft",
    "monthly campaign did not preserve project, frequency, and draft plan",
  );
  const monthlyCampaignId = Number(monthlyCampaign.id);
  const monthlyPlanId = Number(monthlyCampaign.plan_id);
  assert(Number.isSafeInteger(monthlyCampaignId) && Number.isSafeInteger(monthlyPlanId), "monthly campaign lineage is missing");
  assert(Number((await pool.query(
    "select count(*)::int as n from monthly_campaign_items where project_id = $1 and plan_id = $2",
    [sharedProjectId, monthlyPlanId],
  )).rows[0].n) >= 28, "monthly plan did not create a full calendar-month grid");
  const [campaignYear, campaignMonthNumber] = campaignMonth.split("-").map(Number);
  const campaignLastDay = new Date(Date.UTC(campaignYear, campaignMonthNumber, 0)).getUTCDate();
  const expectedCampaignRange = {
    first: `${campaignMonth}-01`,
    last: `${campaignMonth}-${String(campaignLastDay).padStart(2, "0")}`,
  };
  const monthlyGridRange = (await pool.query(
    `select min(scheduled_for)::text as first, max(scheduled_for)::text as last
       from monthly_campaign_items
      where project_id = $1 and plan_id = $2`,
    [sharedProjectId, monthlyPlanId],
  )).rows[0];
  assert(
    monthlyGridRange?.first === expectedCampaignRange.first
      && monthlyGridRange?.last === expectedCampaignRange.last,
    `monthly plan dates escaped the selected calendar month: ${JSON.stringify({
      expected: expectedCampaignRange,
      actual: monthlyGridRange,
    })}`,
  );

  const monthlyBeforeMove = (await pool.query(
    `select id, scheduled_for::text as scheduled_for, position, title
       from monthly_campaign_items
      where project_id = $1 and plan_id = $2
      order by scheduled_for, position, id limit 2`,
    [sharedProjectId, monthlyPlanId],
  )).rows;
  assert(monthlyBeforeMove.length === 2, "monthly plan has no pair for keyboard movement");
  const movedItemId = Number(monthlyBeforeMove[0].id);
  await page.locator(`#monthly-item-${movedItemId} button[aria-expanded]`).click();
  const moveLater = page.getByRole("button", {
    name: `Перенести тему «${monthlyBeforeMove[0].title}» на день позже`,
    exact: true,
  });
  await assertTouch(moveLater, "move monthly item later");
  await moveLater.focus();
  const moveResponsePromise = page.waitForResponse((response) => (
    response.request().method() === "POST"
      && response.url().endsWith(`/api/monthly-campaigns/${monthlyCampaignId}/plans/${monthlyPlanId}/move`)
  ));
  await page.keyboard.press("Enter");
  const moveResponse = await moveResponsePromise;
  if (!moveResponse.ok()) {
    const moveBody = await moveResponse.json().catch(() => null);
    const moveContext = (await pool.query(
      `select preference.selected_project_id,
              exists(select 1 from monthly_campaigns where id = $2 and project_id = preference.selected_project_id) as campaign_visible,
              exists(select 1 from monthly_campaign_plans where id = $3 and campaign_id = $2
                       and project_id = preference.selected_project_id) as plan_visible
         from user_project_preferences preference where preference.user_id = $1`,
      [userId, monthlyCampaignId, monthlyPlanId],
    )).rows[0] ?? null;
    throw new Error(`monthly move failed: ${moveResponse.status()}:${JSON.stringify({ moveBody, moveContext })}`);
  }
  await page.getByText(/Материал перенесён на/u).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const monthlyAfterMove = (await pool.query(
    `select id, scheduled_for::text as scheduled_for, position
       from monthly_campaign_items
      where project_id = $1 and plan_id = $2 and id = any($3::bigint[])
      order by id`,
    [sharedProjectId, monthlyPlanId, monthlyBeforeMove.map((item) => Number(item.id))],
  )).rows;
  const movedRow = monthlyAfterMove.find((item) => Number(item.id) === movedItemId);
  const swappedRow = monthlyAfterMove.find((item) => Number(item.id) !== movedItemId);
  const monthlyMovementEvidence = {
    before: monthlyBeforeMove,
    after: monthlyAfterMove,
  };
  assert(
    movedRow?.scheduled_for.slice(0, 10) === monthlyBeforeMove[1].scheduled_for.slice(0, 10)
      && Number(movedRow?.position) === Number(monthlyBeforeMove[1].position)
      && swappedRow?.scheduled_for.slice(0, 10) === monthlyBeforeMove[0].scheduled_for.slice(0, 10),
    `keyboard monthly movement did not swap exact dates and positions: ${JSON.stringify(monthlyMovementEvidence)}`,
  );

  const monthlyBeforeRegeneration = (await pool.query(
    `select id, item_key, scheduled_for::text as scheduled_for, position, title, rubric, practice,
            funnel_stage, state, approval_status, content_version, approved_content_version,
            weekly_autopilot_plan_id, weekly_autopilot_item_index, draft_id, post_id,
            latest_post_stats_id, regeneration_version
       from monthly_campaign_items
      where project_id = $1 and plan_id = $2
      order by scheduled_for, position, id`,
    [sharedProjectId, monthlyPlanId],
  )).rows;
  const monthlySourceById = new Map(
    monthlyBeforeRegeneration.map((item) => [Number(item.id), item]),
  );

  const regenerateOnlyMoved = page.getByRole("button", {
    name: `Пересобрать только тему «${monthlyBeforeMove[0].title}»`,
    exact: true,
  });
  await assertTouch(regenerateOnlyMoved, "selective monthly regeneration");
  await regenerateOnlyMoved.click();
  await page.getByText("Пересобираю только выбранную тему.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const completedRegeneration = await waitFor(async () => {
    const result = await pool.query(
      `select operation.id, operation.status, operation.result_plan_id
         from monthly_campaign_regeneration_operations operation
        join monthly_campaign_regeneration_targets target
          on target.operation_id = operation.id and target.project_id = operation.project_id
        where operation.project_id = $1 and operation.plan_id = $2 and target.item_id = $3
        order by operation.id desc limit 1`,
      [sharedProjectId, monthlyPlanId, movedItemId],
    );
    return result.rows[0]?.status === "completed" ? result.rows[0] : null;
  }, "selective monthly regeneration did not complete", 90_000);
  const regeneratedPlanId = Number(completedRegeneration.result_plan_id);
  const regeneratedRows = (await pool.query(
    `select id, source_item_id, item_key, scheduled_for::text as scheduled_for, position,
            title, rubric, practice, funnel_stage, state, approval_status, content_version,
            approved_content_version, weekly_autopilot_plan_id, weekly_autopilot_item_index,
            draft_id, post_id, latest_post_stats_id, regeneration_version
       from monthly_campaign_items where project_id = $1 and plan_id = $2
      order by scheduled_for, position, id`,
    [sharedProjectId, regeneratedPlanId],
  )).rows;
  const scalar = (value) => (value == null ? null : String(value));
  const unchangedFields = [
    "item_key",
    "scheduled_for",
    "position",
    "title",
    "rubric",
    "practice",
    "funnel_stage",
    "state",
    "approval_status",
    "content_version",
    "approved_content_version",
    "weekly_autopilot_plan_id",
    "weekly_autopilot_item_index",
    "draft_id",
    "post_id",
    "latest_post_stats_id",
    "regeneration_version",
  ];
  const rebuiltRows = regeneratedRows.filter((item) => {
    const source = monthlySourceById.get(Number(item.source_item_id));
    return source && unchangedFields.some((field) => scalar(item[field]) !== scalar(source[field]));
  });
  const rebuiltTarget = rebuiltRows[0];
  assert(
    regeneratedRows.length === monthlyBeforeRegeneration.length
      && regeneratedRows.every((item) => monthlySourceById.has(Number(item.source_item_id)))
      && new Set(regeneratedRows.map((item) => Number(item.source_item_id))).size === monthlyBeforeRegeneration.length
      && rebuiltRows.length === 1
      && Number(rebuiltTarget?.source_item_id) === movedItemId
      && rebuiltTarget?.title !== monthlySourceById.get(movedItemId)?.title
      && Number(rebuiltTarget?.content_version) === Number(monthlySourceById.get(movedItemId)?.content_version) + 1
      && rebuiltTarget?.approval_status === "draft"
      && rebuiltTarget?.draft_id == null
      && rebuiltTarget?.post_id == null,
    "selective regeneration did not create a full revision with only the target rebuilt",
  );
  const activeMonthlyPlanId = regeneratedPlanId;

  await page.getByText(rebuiltTarget.title, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(async () => {
    const submit = page.getByRole("button", { name: "Отправить на согласование", exact: true });
    return await submit.isEnabled().catch(() => false);
  }, "regenerated monthly plan did not become the actionable UI revision", 15_000);

  const submitMonthlyPlan = page.getByRole("button", { name: "Отправить на согласование", exact: true });
  await submitMonthlyPlan.click();
  const approveMonthlyPlan = page.getByRole("button", { name: "Согласовать план", exact: true });
  await approveMonthlyPlan.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await approveMonthlyPlan.click();
  const prepareFirstWeek = page.getByRole("button", { name: "Подготовить первую неделю", exact: true });
  await prepareFirstWeek.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await assertTouch(prepareFirstWeek, "prepare first monthly week");
  await prepareFirstWeek.click();
  await page.getByText(/Готовлю тексты первой недели в фоне/u).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });

  const preparedMonthlyItems = await waitFor(async () => {
    const result = await pool.query(
      `select id, title, draft_id, weekly_autopilot_plan_id, weekly_autopilot_item_index
         from monthly_campaign_items
        where project_id = $1 and plan_id = $2 and draft_id is not null
        order by position, id limit 3`,
      [sharedProjectId, activeMonthlyPlanId],
    );
    return result.rows.length === 3 ? result.rows : null;
  }, "monthly Autopilot did not persist the first three detailed drafts", 90_000);
  assert(
    preparedMonthlyItems.every((item) => Number(item.weekly_autopilot_plan_id) > 0 && Number(item.weekly_autopilot_item_index) >= 0),
    "monthly drafts lost their weekly Autopilot lineage",
  );
  const monthlyDraftId = Number(preparedMonthlyItems[0].draft_id);
  const monthlyItemId = Number(preparedMonthlyItems[0].id);
  const monthlyItemTitle = String(preparedMonthlyItems[0].title);
  const monthlyDraft = (await pool.query(
    "select project_id, origin, text from drafts where id = $1",
    [monthlyDraftId],
  )).rows[0];
  assert(
    Number(monthlyDraft?.project_id) === sharedProjectId
      && monthlyDraft?.origin === "autopilot"
      && String(monthlyDraft?.text || "").length >= criticalQuality.minChars,
    "first monthly material is not a durable quality-sized Autopilot draft",
  );

  await page.reload();
  const openMonthlyDraft = page.locator(`#monthly-item-${monthlyItemId}`).getByRole(
    "button",
    { name: "Открыть в редакторе", exact: true },
  );
  await openMonthlyDraft.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await openMonthlyDraft.count() === 1, "monthly plan did not expose one exact Composer action for its first material");
  await page.setViewportSize({ width: 320, height: 780 });
  await assertNoHorizontalOverflow(page, "monthly campaign at 320px");
  await page.setViewportSize({ width: 1280, height: 900 });
  await openMonthlyDraft.click();
  await page.waitForURL(new RegExp(`/app/composer\\?draft=${monthlyDraftId}(?:&|$)`, "u"));

  const criticalComposerText = page.locator("#composer-text");
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const autopilotText = await readEditableText(criticalComposerText);
  assert(autopilotText === monthlyDraft.text, "Composer did not open the exact first monthly material");
  await criticalComposerText.fill(
    `${autopilotText}\n\nВ общем, кто-то решил, во-первых, участвовать в обсуждении.`,
  );

  const saveCriticalDraft = async (targetPage = page) => {
    const protection = await openComposerSection(targetPage, "composer-protection");
    const saveButton = protection.getByRole("button", { name: /^(Сохранить сейчас|Сохранено)$/u });
    await saveButton.waitFor();
    const alreadySaved = await saveButton.getAttribute("data-loading") !== "true"
      && (await saveButton.textContent())?.trim() === "Сохранено";
    await saveButton.click();
    if (!alreadySaved) {
      await waitFor(async () => {
        const summary = await protection.locator("summary").textContent();
        return summary?.includes("Сохранено") === true;
      }, "Composer save state did not acknowledge the visible text", UI_WAIT_TIMEOUT_MS);
    }
    await waitFor(async () => {
      const row = (await pool.query(
        "select text from drafts where id = $1 and project_id = $2",
        [monthlyDraftId, sharedProjectId],
      )).rows[0];
      const currentText = await readEditableText(targetPage.locator("#composer-text")).catch(() => "");
      return row?.text === currentText;
    }, "Composer save button did not acknowledge the visible text", 12_000);
  };
  await saveCriticalDraft();
  await waitFor(async () => {
    const row = (await pool.query(
      "select text from drafts where id = $1 and project_id = $2",
      [monthlyDraftId, sharedProjectId],
    )).rows[0];
    return row?.text === await readEditableText(criticalComposerText);
  }, "Composer did not durably save the edited text", 15_000);

  // Link tracking remains a project service, but it is no longer configured inside
  // the simplified Composer. Bind it through the authenticated API and then reload;
  // all later UI saves must preserve this server-owned draft field invisibly.
  const criticalUtmValues = {
    utm_source: "telegram",
    utm_medium: "social",
    utm_campaign: "critical_monthly_e2e",
    utm_content: "first_monthly_post",
    utm_term: "legal_tech",
  };
  const criticalLinkResponse = await authenticatedRequest("/api/tracking/links", {
    method: "POST",
    headers: { "idempotency-key": "critical_monthly_e2e_link" },
    data: {
      destination: trackedDestination,
      utmValues: criticalUtmValues,
      templateId: null,
      expiresAt: null,
    },
  });
  assert(
    criticalLinkResponse.status === 201,
    `critical tracking link API failed with ${criticalLinkResponse.status}:${criticalLinkResponse.text}`,
  );
  const criticalLink = JSON.parse(criticalLinkResponse.text).link;
  const criticalTrackedDestination = String(criticalLink.destinationUrl || "");
  const criticalBaseShortPath = `/r/${criticalLink.slug}`;
  assert(/^\/r\/[A-Za-z0-9_-]{20,64}$/u.test(criticalBaseShortPath), "tracking API returned an invalid short path");
  const criticalTrackedUrl = new URL(criticalTrackedDestination);
  assert(
    criticalTrackedUrl.origin === new URL(trackedDestination).origin
      && criticalTrackedUrl.pathname === new URL(trackedDestination).pathname
      && Object.entries(criticalUtmValues).every(([key, value]) => criticalTrackedUrl.searchParams.get(key) === value),
    "tracking API did not preserve the destination and exact campaign values",
  );
  const draftBeforeTrackingResponse = await authenticatedRequest(`/api/drafts/${monthlyDraftId}`);
  assert(draftBeforeTrackingResponse.status === 200, "could not reload the draft before binding tracking");
  const draftBeforeTracking = JSON.parse(draftBeforeTrackingResponse.text).draft;
  const trackedDraftResponse = await authenticatedRequest(`/api/drafts/${monthlyDraftId}`, {
    method: "PATCH",
    data: {
      version: draftBeforeTracking.version,
      text: draftBeforeTracking.text,
      media: draftBeforeTracking.media,
      scheduledAt: draftBeforeTracking.scheduled_at,
      schedule: draftBeforeTracking.scheduled_at ? {
        localDate: draftBeforeTracking.scheduled_local_date,
        localTime: draftBeforeTracking.scheduled_local_time,
        timezone: draftBeforeTracking.scheduled_timezone,
        offset: draftBeforeTracking.scheduled_offset,
        disambiguation: draftBeforeTracking.scheduled_disambiguation,
      } : null,
      origin: draftBeforeTracking.origin,
      sourceRef: draftBeforeTracking.source_ref,
      channelIds: draftBeforeTracking.destinations.map((destination) => destination.channel_id),
      aiValidation: null,
      generationResultId: null,
      tracking: {
        shortLinkId: criticalLink.id,
        shortUrlPath: criticalBaseShortPath,
        destination: criticalLink.destinationUrl,
        utmValues: criticalUtmValues,
        placement: "cta",
      },
    },
  });
  assert(
    trackedDraftResponse.status === 200,
    `tracking was not bound to the draft: ${trackedDraftResponse.status}:${trackedDraftResponse.text}`,
  );
  await page.reload();
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(criticalComposerText) === draftBeforeTracking.text, "tracking binding changed the visible post text");

  const loadEditorial = async (targetPage) => {
    const response = await authenticatedRequestFrom(targetPage, `/api/drafts/${monthlyDraftId}/editorial`);
    assert(response.status === 200, `editorial snapshot failed with ${response.status}:${response.text}`);
    const body = JSON.parse(response.text);
    assert(body?.ok === true && body.editorial?.workflow && body.editorial?.currentRevision, "editorial snapshot is incomplete");
    return body.editorial;
  };
  const submitVisualSourceReview = page.getByRole("button", { name: "Сохранить и отправить на согласование", exact: true });
  await assertTouch(submitVisualSourceReview, "submit initial editorial revision");
  await submitVisualSourceReview.click();
  try {
    await page.getByText("Материал отправлен на согласование.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  } catch (error) {
    const draftState = (await pool.query(
      "select version from drafts where id = $1 and project_id = $2",
      [monthlyDraftId, sharedProjectId],
    )).rows[0];
    const editorialText = await page.locator("#editorial-readiness").innerText().catch(() => "");
    throw new Error(`initial editorial submission failed: ${JSON.stringify({
      databaseDraftVersion: Number(draftState?.version) || null,
      editorialText,
      cause: error instanceof Error ? error.message : String(error),
    })}`);
  }
  await reviewerPage.goto(`/app/composer?draft=${monthlyDraftId}`);
  await reviewerPage.getByRole("heading", { name: "Согласование материала", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const reviewerFirstEditorial = await loadEditorial(reviewerPage);
  assert(
    reviewerFirstEditorial.workflow.state === "in_review"
      && reviewerFirstEditorial.request?.status === "open"
      && reviewerFirstEditorial.request.revisionId === reviewerFirstEditorial.currentRevision.id,
    "reviewer did not receive the exact initial editorial revision",
  );
  await reviewerPage.getByLabel("Комментарий к версии", { exact: true }).fill(
    "Добавьте ясный следующий шаг и ещё раз проверьте оформление вводной фразы.",
  );
  const addEditorialComment = reviewerPage.getByRole("button", { name: "Добавить комментарий", exact: true });
  await assertTouch(addEditorialComment, "add editorial version comment");
  await addEditorialComment.click();
  await reviewerPage.getByText("Комментарий добавлен к этой версии.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await reviewerPage.getByLabel("Комментарий к решению", { exact: true }).fill(
    "Нужен конкретный следующий шаг и чистая типографика.",
  );
  const requestChanges = reviewerPage.getByRole("button", { name: "Запросить правки", exact: true });
  await assertTouch(requestChanges, "request editorial changes");
  await requestChanges.click();
  await waitFor(async () => (
    (await loadEditorial(reviewerPage)).workflow.state === "changes_requested"
  ), "editorial change request did not become durable", 12_000);
  await reviewerPage.getByText("Нужны правки", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });

  await page.goto(`/app/composer?draft=${monthlyDraftId}&from=autopilot-month`);
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const finalEditorialText = `${await readEditableText(criticalComposerText)}\n\nВ общем, во-первых, легалтех помогает обсудить следующий шаг с редакцией без спешки.`;
  await criticalComposerText.fill(finalEditorialText);
  assert(
    finalEditorialText.includes("В общем")
      && finalEditorialText.includes("во-первых")
      && finalEditorialText.includes("легалтех")
      && finalEditorialText.includes("следующий шаг")
      && !finalEditorialText.includes("LegalTech"),
    "corrected editorial text does not preserve the deliberate project terminology",
  );
  await saveCriticalDraft();
  await page.reload();
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(criticalComposerText) === finalEditorialText, "reload lost the corrected editorial text");

  const changedEditorial = await loadEditorial(page);
  if (
    changedEditorial.workflow.state !== "changes_requested"
    || changedEditorial.currentRevision.contentHash === reviewerFirstEditorial.currentRevision.contentHash
  ) {
    const revisionRows = (await pool.query(
      `select id, draft_version, content_hash, snapshot->>'text' as text
         from draft_revisions
        where project_id = $1 and draft_id = $2
        order by draft_version, id`,
      [sharedProjectId, monthlyDraftId],
    )).rows;
    throw new Error(`changed text incorrectly reused the initial editorial revision hash: ${JSON.stringify({
      first: reviewerFirstEditorial.currentRevision,
      changed: changedEditorial.currentRevision,
      workflow: changedEditorial.workflow,
      revisions: revisionRows,
      visibleText: finalEditorialText,
    })}`);
  }
  const submitCorrectedSource = page.getByRole("button", { name: "Сохранить и отправить повторно", exact: true });
  await assertTouch(submitCorrectedSource, "submit corrected source revision");
  await submitCorrectedSource.click();
  await page.getByText("Материал отправлен на согласование.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await reviewerPage.reload();
  await reviewerPage.getByRole("heading", { name: "Согласование материала", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const correctedSourceEditorial = await loadEditorial(reviewerPage);
  assert(
    correctedSourceEditorial.workflow.state === "in_review"
      && correctedSourceEditorial.request?.revisionId === changedEditorial.currentRevision.id
      && correctedSourceEditorial.request?.contentHash === changedEditorial.currentRevision.contentHash,
    "corrected visual source request is not bound to the exact revision and hash",
  );
  await reviewerPage.getByLabel("Комментарий к решению", { exact: true }).fill(
    "Исправленный текст проверен; из этой ревизии можно собирать визуальные материалы.",
  );
  const approveVisualSource = reviewerPage.getByRole("button", { name: "Согласовать версию", exact: true });
  await assertTouch(approveVisualSource, "approve exact corrected visual source revision");
  await approveVisualSource.click();
  await reviewerPage.getByText("Согласован", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const approvedVisualSource = (await loadEditorial(reviewerPage)).workflow;
  assert(
    approvedVisualSource.state === "approved"
      && approvedVisualSource.approvedRevisionId === correctedSourceEditorial.currentRevision.id
      && approvedVisualSource.approvedContentHash === correctedSourceEditorial.currentRevision.contentHash,
    "visual source approval is not bound to the exact revision and hash",
  );
  await page.reload();
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(criticalComposerText) === finalEditorialText, "source approval changed the corrected Composer text");

  const composerMedia = await openComposerSection(page, "composer-media");
  const openVisualStudio = composerMedia.getByRole("button", { name: "Создать с ИИ", exact: true });
  await assertTouch(openVisualStudio, "open legal visual studio");
  await openVisualStudio.click();
  await page.waitForURL(new RegExp(`/app/studio/visuals\\?draft=${monthlyDraftId}&returnTo=autopilot-month$`, "u"));
  const brandKit = page.locator("details").filter({ hasText: "Фирменный стиль проекта" }).first();
  await brandKit.locator("summary").click();
  await brandKit.locator("#brand-name").fill("ТехнологИИ Права QA");
  await brandKit.locator("#brand-signature").fill("ТехнологИИ Права · проверено редакцией");
  await brandKit.getByLabel("Акцент: шестизначный код цвета", { exact: true }).fill("#3157d5");
  await brandKit.locator("#brand-font").selectOption("legal-serif");
  const brandLogoInput = brandKit.locator('input[type="file"][name="file"]');
  const mediaCountBeforeInvalidUpload = Number((await pool.query(
    "select count(*)::int as count from media_assets where project_id = $1",
    [sharedProjectId],
  )).rows[0]?.count);
  await brandLogoInput.setInputFiles(invalidBrandLogoPath);
  await brandKit.getByLabel("Описание логотипа", { exact: true }).fill("Знак проекта ТехнологИИ Права");
  const uploadBrandLogo = brandKit.getByRole("button", { name: "Загрузить логотип", exact: true });
  await assertTouch(uploadBrandLogo, "upload project brand logo");
  expectedBrowserConsoleScopes.add("main");
  await uploadBrandLogo.click();
  await brandKit.getByText("Выберите изображение PNG, JPEG или WebP размером до 10 МБ.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  expectedBrowserConsoleScopes.delete("main");
  assert(
    Number((await pool.query(
      "select count(*)::int as count from media_assets where project_id = $1",
      [sharedProjectId],
    )).rows[0]?.count) === mediaCountBeforeInvalidUpload,
    "damaged image passed upload validation or left a media row",
  );
  await brandLogoInput.setInputFiles(brandLogoPath);
  await uploadBrandLogo.click();
  await brandKit.getByText("Логотип загружен. Сохраните фирменный стиль.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const saveBrandKit = brandKit.getByRole("button", { name: "Сохранить фирменный стиль", exact: true });
  await assertTouch(saveBrandKit, "save project brand kit");
  await saveBrandKit.click();
  await brandKit.getByText("Фирменный стиль сохранён", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const brandKitEvidence = (await pool.query(
    `select name, signature, colors, logo_asset_id, allowed_fonts, active_font, version
       from project_brand_kits where project_id = $1`,
    [sharedProjectId],
  )).rows[0];
  const reloadedBrandKit = await authenticatedRequestFrom(page, "/api/legal-visuals/brand-kit");
  const reloadedBrand = reloadedBrandKit.status === 200
    ? JSON.parse(reloadedBrandKit.text)
    : null;
  assert(
    brandKitEvidence?.name === "ТехнологИИ Права QA"
      && brandKitEvidence?.signature === "ТехнологИИ Права · проверено редакцией"
      && brandKitEvidence?.colors?.accent === "#3157d5"
      && Number(brandKitEvidence?.logo_asset_id) > 0
      && Array.isArray(brandKitEvidence?.allowed_fonts)
      && brandKitEvidence.allowed_fonts.includes("legal-serif")
      && brandKitEvidence?.active_font === "legal-serif"
      && Number(brandKitEvidence?.version) === 1
      && reloadedBrand?.brand?.name === brandKitEvidence.name
      && reloadedBrand?.brand?.font === brandKitEvidence.active_font
      && Number(reloadedBrand?.brand?.logo?.assetId) === Number(brandKitEvidence.logo_asset_id)
      && Number(reloadedBrand?.version) === Number(brandKitEvidence.version),
    "Brand Kit UI did not preserve the logo, accent, allowed font, signature, and version",
  );
  await page.getByRole("heading", { name: "Новая карусель", exact: true }).waitFor();
  await page.getByLabel("Название", { exact: true }).fill("Критическая legal-карусель QA");
  await page.getByLabel("Формат", { exact: true }).selectOption("4:5");
  await page.getByLabel("Шаблон первой карточки", { exact: true }).selectOption("three_actions");
  const createLegalCarousel = page.getByRole("button", { name: "Создать карусель", exact: true });
  await assertTouch(createLegalCarousel, "create legal carousel");
  await createLegalCarousel.click();
  const carouselCards = page.getByRole("list", { name: "Карточки карусели" }).getByRole("listitem");
  await waitFor(async () => (await carouselCards.count()) === 3, "legal carousel did not create three editable cards", 10_000);
  const addCarouselCard = page.getByRole("button", { name: "Добавить карточку", exact: true });
  await assertTouch(addCarouselCard, "add legal carousel card");
  await addCarouselCard.click();
  await addCarouselCard.click();
  await waitFor(async () => (await carouselCards.count()) === 5, "legal carousel did not reach five editable cards", 10_000);
  await carouselCards.nth(1).click();
  const activeCardTitle = page.locator("#card-title");
  await activeCardTitle.focus();
  await page.keyboard.press("Alt+ArrowUp");
  await page.getByText("Карточка перемещена на позицию 1", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await page.keyboard.press("Alt+ArrowDown");
  await page.getByText("Карточка перемещена на позицию 2", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const renderCarousel = page.getByRole("button", { name: "Собрать PNG", exact: true });
  await assertTouch(renderCarousel, "render legal carousel");
  expectedBrowserConsoleScopes.add("main");
  await renderCarousel.click();
  await page.getByText("Текст не помещается в безопасную область. Сократите отмеченные поля.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  expectedBrowserConsoleScopes.delete("main");
  const layoutIssue = page.getByRole("button", { name: /Карточка \d+ · (Заголовок|Тезисы):/u }).first();
  await layoutIssue.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await assertTouch(layoutIssue, "open legal carousel layout issue");
  await layoutIssue.click();
  await waitFor(async () => (await page.locator(":focus").getAttribute("aria-invalid")) === "true", "layout issue did not focus its invalid field", 5_000);
  for (let cardIndex = 0; cardIndex < await carouselCards.count(); cardIndex += 1) {
    await carouselCards.nth(cardIndex).click();
    await page.locator("#card-title").fill(`Проверка карточки ${cardIndex + 1}`);
    const theses = page.locator('textarea[aria-label^="Тезис "]');
    for (let thesisIndex = 0; thesisIndex < await theses.count(); thesisIndex += 1) {
      await theses.nth(thesisIndex).fill(`Краткий тезис ${cardIndex + 1}.${thesisIndex + 1}`);
    }
  }
  await renderCarousel.click();
  await page.getByText("Готово: 5 карточек сохранено в медиатеке", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const legalRenderEvidence = (await pool.query(
    `select operation.id, operation.status, operation.project_id, count(card.card_id)::int as cards,
            design.source_draft_revision_id, design.source_draft_version,
            design.source_content_hash, design.config, design.revision as design_revision
       from legal_visual_render_operations operation
       join legal_visual_designs design
         on design.id = operation.design_id and design.project_id = operation.project_id
       join legal_visual_render_cards card
         on card.operation_id = operation.id and card.project_id = operation.project_id
      where operation.project_id = $1
      group by operation.id, operation.status, operation.project_id, design.id
      order by operation.id desc limit 1`,
    [sharedProjectId],
  )).rows[0];
  assert(
    legalRenderEvidence?.status === "ready"
      && Number(legalRenderEvidence?.project_id) === sharedProjectId
      && Number(legalRenderEvidence?.cards) === 5,
    "legal carousel render did not leave ready five-card project-scoped evidence",
  );
  assert(
    Number(legalRenderEvidence?.source_draft_revision_id) === Number(approvedVisualSource.approvedRevisionId)
      && Number(legalRenderEvidence?.source_draft_version) === Number(correctedSourceEditorial.currentRevision.draftVersion)
      && legalRenderEvidence?.source_content_hash === approvedVisualSource.approvedContentHash
      && Number(legalRenderEvidence?.design_revision) >= 3
      && legalRenderEvidence?.config?.brand?.colors?.accent === "#3157d5"
      && legalRenderEvidence?.config?.brand?.font === "legal-serif"
      && legalRenderEvidence?.config?.brand?.signature === "ТехнологИИ Права · проверено редакцией"
      && Number(legalRenderEvidence?.config?.brand?.logo?.assetId) === Number(brandKitEvidence.logo_asset_id),
    "rendered carousel lost exact approved source or the saved Brand Kit",
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await assertNoHorizontalOverflow(page, "legal visual editor at 320px");
  await page.setViewportSize({ width: 640, height: 800 });
  await assertNoHorizontalOverflow(page, "legal visual editor at 200% desktop zoom equivalent");
  await page.setViewportSize({ width: 1280, height: 900 });

  const videoHeading = page.getByRole("heading", { name: "Сценарии видео", exact: true });
  await videoHeading.scrollIntoViewIfNeeded();
  const videoEditor = page.getByRole("region", { name: "Редактор сценария" });
  await videoEditor.waitFor();
  await page.locator("#new-video-duration").selectOption("45");
  const createVideoScript = page.getByRole("button", { name: "Новый сценарий", exact: true });
  await assertTouch(createVideoScript, "create 45-second video script");
  await createVideoScript.click();
  await page.getByText("Сценарий создан из зафиксированной версии черновика", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await page.locator("#script-title").fill("Сценарий для короткого разбора legal-tech практики");
  const hookVisual = page.locator("#visual-scene-hook");
  await hookVisual.fill("Покажите исходный материал и фирменную карточку без новых утверждений.");
  const saveVideoScript = videoEditor.getByRole("button", { name: "Сохранить", exact: true });
  await assertTouch(saveVideoScript, "save edited video script");
  await saveVideoScript.click();
  await page.getByText("Сценарий сохранён", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const videoScriptEvidence = (await pool.query(
    `select id, project_id, source_draft_id, source_draft_revision_id,
            source_draft_version, source_content_hash,
            duration_seconds, revision, title
       from legal_video_scripts
      where project_id = $1 and source_draft_id = $2
      order by id desc limit 1`,
    [sharedProjectId, monthlyDraftId],
  )).rows[0];
  assert(
    Number(videoScriptEvidence?.project_id) === sharedProjectId
      && Number(videoScriptEvidence?.source_draft_id) === monthlyDraftId
      && Number(videoScriptEvidence?.source_draft_revision_id) === Number(approvedVisualSource.approvedRevisionId)
      && Number(videoScriptEvidence?.source_draft_version) === Number(correctedSourceEditorial.currentRevision.draftVersion)
      && videoScriptEvidence?.source_content_hash === approvedVisualSource.approvedContentHash
      && Number(videoScriptEvidence?.duration_seconds) === 45
      && Number(videoScriptEvidence?.revision) === 2
      && videoScriptEvidence?.title === "Сценарий для короткого разбора legal-tech практики",
    "edited 45-second video script lost exact draft lineage or revision",
  );
  const briefDownload = page.waitForEvent("download", { timeout: UI_WAIT_TIMEOUT_MS });
  await page.getByRole("link", { name: "Скачать техзадание", exact: true }).click();
  const videoBriefDownload = await briefDownload;
  const videoBriefPath = resolve(artifactDir, "critical-video-production-brief.txt");
  await videoBriefDownload.saveAs(videoBriefPath);
  const videoBrief = await readFile(videoBriefPath, "utf8");
  assert(
    videoBrief.includes("00:00")
      && videoBrief.includes("Исходный черновик:")
      && videoBrief.includes(String(monthlyDraftId)),
    "video production brief omitted timing or exact source draft",
  );
  await page.getByRole("heading", { name: "Карусели", exact: true }).scrollIntoViewIfNeeded();

  const addCarouselToPost = page.getByRole("button", { name: "Добавить всю карусель в пост", exact: true });
  await assertTouch(addCarouselToPost, "add entire carousel to post");
  await addCarouselToPost.click();
  await page.waitForURL(new RegExp(`/app/composer\\?draft=${monthlyDraftId}&fromMedia=1&from=studio-visuals&returnTo=autopilot-month$`, "u"));
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(criticalComposerText) === finalEditorialText, "returning from Legal Visuals changed the approved source text");
  await page.getByText("Критическая legal-карусель QA", { exact: false }).first().waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await saveCriticalDraft();

  let publicationAt = new Date();
  publicationAt.setUTCSeconds(0, 0);
  publicationAt.setUTCMinutes(publicationAt.getUTCMinutes() + 3);
  const reviewAt = new Date(publicationAt.getTime() + 24 * 60 * 60_000);
  let publicationDate = publicationAt.toISOString().slice(0, 10);
  let publicationTime = publicationAt.toISOString().slice(11, 16);
  const currentPreferencesResponse = await authenticatedRequest(`/api/drafts/${monthlyDraftId}/publication-preferences`);
  assert(currentPreferencesResponse.status === 200, "publication preferences API is unavailable for the critical draft");
  const currentPreferences = JSON.parse(currentPreferencesResponse.text).preferences;
  const savePreferencesResponse = await authenticatedRequest(`/api/drafts/${monthlyDraftId}/publication-preferences`, {
    method: "PUT",
    data: {
      expectedVersion: currentPreferences.version,
      selectedBlockIds: [signatureBlockId, firstCommentBlockId],
      firstCommentFallback: "skip",
      commentsMode: "provider_default",
      pinAfterPublish: true,
      reviewAt: reviewAt.toISOString(),
      reviewResponsibleUserId: reviewerUserId,
    },
  });
  assert(
    savePreferencesResponse.status === 200,
    `publication preferences were not saved: ${savePreferencesResponse.status}:${savePreferencesResponse.text}`,
  );
  await page.reload();
  await criticalComposerText.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(criticalComposerText) === finalEditorialText, "publication preferences changed the visible post text");
  await openComposerSection(page, "publication-time");
  await page.getByLabel("Дата публикации", { exact: true }).fill(publicationDate);
  await page.getByLabel("Время публикации", { exact: true }).fill(publicationTime);
  await saveCriticalDraft();

  const criticalDraftBeforeReview = await waitFor(async () => {
    const result = await pool.query(
      `select text, media, tracking, scheduled_at, version
         from drafts where id = $1 and project_id = $2`,
      [monthlyDraftId, sharedProjectId],
    );
    const row = result.rows[0];
    return row?.media?.kind === "carousel"
      && Array.isArray(row.media?.items)
      && row.media.items.length === 5
      && row.tracking?.shortUrlPath === criticalBaseShortPath
      && row.scheduled_at
      ? row
      : null;
  }, "Composer did not durably save carousel, tracking, and schedule", 15_000);
  const publicationPreferences = (await pool.query(
    `select selected_block_ids, pin_after_publish, review_at, review_responsible_user_id
       from draft_publication_preferences where project_id = $1 and draft_id = $2`,
    [sharedProjectId, monthlyDraftId],
  )).rows[0];
  const selectedPublicationBlocks = (publicationPreferences?.selected_block_ids || []).map(Number).sort((left, right) => left - right);
  assert(
    JSON.stringify(selectedPublicationBlocks) === JSON.stringify([signatureBlockId, firstCommentBlockId].sort((left, right) => left - right))
      && publicationPreferences?.pin_after_publish === true
      && Number(publicationPreferences?.review_responsible_user_id) === reviewerUserId
      && new Date(publicationPreferences.review_at).toISOString() === reviewAt.toISOString(),
    "publication blocks, pin, or review assignment were not persisted for the draft",
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await assertNoHorizontalOverflow(page, "critical Composer at 320px");
  await page.setViewportSize({ width: 640, height: 800 });
  await assertNoHorizontalOverflow(page, "critical Composer at 200% desktop zoom equivalent");
  await page.setViewportSize({ width: 1280, height: 900 });

  let publicationSafetyRefreshed = false;
  if (publicationAt.getTime() <= Date.now() + 150_000) {
    const minimumSafePublicationAt = new Date();
    minimumSafePublicationAt.setUTCSeconds(0, 0);
    minimumSafePublicationAt.setUTCMinutes(minimumSafePublicationAt.getUTCMinutes() + 3);
    publicationAt = new Date(Math.max(
      minimumSafePublicationAt.getTime(),
      publicationAt.getTime() + 60_000,
    ));
    publicationDate = publicationAt.toISOString().slice(0, 10);
    publicationTime = publicationAt.toISOString().slice(11, 16);
    await page.getByLabel("Дата публикации", { exact: true }).fill(publicationDate);
    await page.getByLabel("Время публикации", { exact: true }).fill(publicationTime);
    publicationSafetyRefreshed = true;
  }
  await saveCriticalDraft();
  const finalDraft = await waitFor(async () => {
    const row = (await pool.query(
      `select text, media, tracking, origin, source_ref, scheduled_at, version
         from drafts where id = $1 and project_id = $2`,
      [monthlyDraftId, sharedProjectId],
    )).rows[0];
    return row?.text === finalEditorialText && row?.origin === "manual" ? row : null;
  }, "human adoption did not durably save the final changed monthly draft", 15_000);
  assert(
    finalDraft.source_ref == null
      && finalDraft.media?.kind === "carousel"
      && finalDraft.tracking?.shortUrlPath === criticalBaseShortPath,
    "human adoption lost media/tracking or retained untrusted Autopilot source attribution",
  );
  assert(
    publicationSafetyRefreshed
      ? Number(finalDraft.version) > Number(criticalDraftBeforeReview.version)
      : Number(finalDraft.version) === Number(criticalDraftBeforeReview.version),
    publicationSafetyRefreshed
      ? "publication safety refresh did not create a newer durable draft version"
      : "idempotent publication save unexpectedly created a newer draft version",
  );
  assert(Number((await pool.query(
    "select draft_id from monthly_campaign_items where id = $1 and project_id = $2",
    [monthlyItemId, sharedProjectId],
  )).rows[0]?.draft_id) === monthlyDraftId, "human adoption broke monthly campaign draft lineage");

  const secondEditorial = await loadEditorial(page);
  assert(
    secondEditorial.workflow.state === "draft"
      && secondEditorial.workflow.approvedRevisionId == null
      && secondEditorial.workflow.approvedContentHash == null
      && secondEditorial.currentRevision.contentHash !== approvedVisualSource.approvedContentHash,
    "media or publication preferences did not invalidate the exact source approval",
  );
  const submitSecondReview = page.getByRole("button", { name: "Сохранить и отправить на согласование", exact: true });
  await assertTouch(submitSecondReview, "submit final media-bearing revision");
  await submitSecondReview.click();
  await page.getByText("Материал отправлен на согласование.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await reviewerPage.reload();
  await reviewerPage.getByRole("heading", { name: "Согласование материала", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const reviewerSecondEditorial = await loadEditorial(reviewerPage);
  assert(
    reviewerSecondEditorial.workflow.state === "in_review"
      && reviewerSecondEditorial.request?.revisionId === secondEditorial.currentRevision.id
      && reviewerSecondEditorial.request?.contentHash === secondEditorial.currentRevision.contentHash,
    "final reviewer request is not bound to the exact media-bearing revision",
  );
  await reviewerPage.getByLabel("Комментарий к решению", { exact: true }).fill(
    "Финальная версия проверена и готова к публикации.",
  );
  const approveFinalRevision = reviewerPage.getByRole("button", { name: "Согласовать версию", exact: true });
  await assertTouch(approveFinalRevision, "approve exact final revision");
  await approveFinalRevision.click();
  await reviewerPage.getByText("Согласован", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const approvedWorkflow = (await loadEditorial(reviewerPage)).workflow;
  assert(
    approvedWorkflow?.state === "approved"
      && approvedWorkflow.approvedRevisionId === reviewerSecondEditorial.currentRevision.id
      && approvedWorkflow.approvedContentHash === reviewerSecondEditorial.currentRevision.contentHash,
    "final approval is not exact-revision bound",
  );
  const editorialEvidence = (await pool.query(
    `select decision.decision, decision.actor_user_id, decision.content_hash
       from draft_editorial_decisions decision
      where decision.project_id = $1 and decision.draft_id = $2
      order by decision.id`,
    [sharedProjectId, monthlyDraftId],
  )).rows;
  assert(
    editorialEvidence.length === 3
      && editorialEvidence[0].decision === "request_changes"
      && editorialEvidence[1].decision === "approve"
      && editorialEvidence[2].decision === "approve"
      && editorialEvidence.every((decision) => Number(decision.actor_user_id) === reviewerUserId),
    "editorial decision ledger does not contain one change request, source approval, and final approval by the second role",
  );
  const editorialAuditActions = (await pool.query(
    `select action from audit_events
      where project_id = $1 and actor_user_id = $2
        and action in ('draft.changes_requested','draft.approved')
      order by id`,
    [sharedProjectId, reviewerUserId],
  )).rows.map((row) => row.action);
  assert(
    editorialAuditActions.includes("draft.changes_requested") && editorialAuditActions.includes("draft.approved"),
    "editorial role decisions are missing from the immutable project audit",
  );

  await page.goto("/app/settings?section=general");
  const reviewerRoleSelect = page.getByLabel(`Роль участника ${reviewerName}`, { exact: true });
  await reviewerRoleSelect.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await reviewerRoleSelect.selectOption("publisher");
  await page.getByText("Роль участника изменена: публикатор.", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert((await pool.query(
    "select role from project_members where project_id = $1 and user_id = $2",
    [sharedProjectId, reviewerUserId],
  )).rows[0]?.role === "publisher", "second user was not promoted to publisher through project settings");

  await reviewerPage.setViewportSize({ width: 320, height: 780 });
  await reviewerPage.goto(`/app/composer?draft=${monthlyDraftId}`);
  await reviewerPage.locator("#composer-text").waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  assert(await readEditableText(reviewerPage.locator("#composer-text")) === finalEditorialText, "publisher did not receive the approved text revision");
  await assertNoHorizontalOverflow(reviewerPage, "publisher Composer at 320px");
  await reviewerPage.setViewportSize({ width: 1280, height: 900 });
  const publisherSchedule = reviewerPage.getByRole("button", { name: "Добавить в календарь", exact: true }).first();
  await publisherSchedule.waitFor();
  await assertTouch(publisherSchedule, "publisher schedule approved post");
  assert(publicationAt.getTime() > Date.now(), "critical journey exceeded the approved future schedule before publisher action");
  let publicationResponse = null;
  const capturePublicationResponse = async (response) => {
    if (
      response.request().method() !== "POST"
      || new URL(response.url()).pathname !== "/api/publication-operations"
    ) return;
    const body = await response.json().catch(() => null);
    const requestBody = response.request().postDataJSON();
    const schedule = requestBody?.schedule;
    publicationResponse = {
      status: response.status(),
      ok: response.ok(),
      operationStatus: typeof body?.operationStatus === "string" ? body.operationStatus : null,
      error: typeof body?.error === "string" ? body.error : "unknown",
      result: typeof body?.result === "string" ? body.result : null,
      schedule: schedule && typeof schedule === "object" ? {
        keys: Object.keys(schedule).sort(),
        scheduledAt: schedule.scheduledAt ?? null,
        localDate: schedule.localDate ?? null,
        localTime: schedule.localTime ?? null,
        timezone: schedule.timezone ?? null,
        disambiguation: schedule.disambiguation ?? null,
        offset: schedule.offset ?? null,
      } : schedule ?? null,
    };
  };
  reviewerPage.on("response", capturePublicationResponse);
  await publisherSchedule.click();
  try {
    await reviewerPage.waitForFunction(
      () => globalThis.location.pathname === "/app/calendar",
      undefined,
      { timeout: UI_WAIT_TIMEOUT_MS },
    );
    await reviewerPage.getByRole("heading", { name: "Календарь", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  } catch (error) {
    throw new Error(`publisher schedule failed: ${JSON.stringify({
      response: publicationResponse,
      url: reviewerPage.url(),
      cause: error instanceof Error ? error.message : String(error),
    })}`);
  } finally {
    reviewerPage.off("response", capturePublicationResponse);
  }

  const criticalPublication = await waitFor(async () => {
    const result = await pool.query(
      `select operation.id as operation_id, operation.draft_version, operation.project_id,
              operation.text as operation_text, operation.options,
              post.id as post_id, post.status, post.text, post.scheduled_at, post.schedule_revision
         from publication_operations operation
         join posts post on post.publication_operation_id = operation.id and post.project_id = operation.project_id
        where operation.project_id = $1 and operation.draft_id = $2
        order by operation.id desc limit 1`,
      [sharedProjectId, monthlyDraftId],
    );
    return result.rows[0] ?? null;
  }, "publisher action did not create a project-scoped publication operation", 15_000);
  const criticalOperationId = Number(criticalPublication.operation_id);
  const criticalPostId = Number(criticalPublication.post_id);
  const publicationTypography = criticalPublication.options?.typography;
  const publicationSnapshotChecks = {
    project: Number(criticalPublication.project_id) === sharedProjectId,
    draftVersion: Number(criticalPublication.draft_version) === Number(finalDraft.version),
    operationMatchesPost: criticalPublication.operation_text === criticalPublication.text,
    approvedTextPrefix: criticalPublication.text.startsWith(finalEditorialText),
    authorSignature: criticalPublication.text.includes("Команда «Аврора» — редакция legal-tech проекта."),
    dictionaryVersion: Number(publicationTypography?.dictionaryVersion) === Number(brandRuleEvidence.dictionary_version),
    publishedAsIs: publicationTypography?.status === "published_as_is",
    noTypographyReviewRun: publicationTypography?.reviewRunId == null,
  };
  if (!Object.values(publicationSnapshotChecks).every(Boolean)) {
    throw new Error(`publication snapshot lost approved lineage: ${JSON.stringify({
      checks: publicationSnapshotChecks,
      actualDraftVersion: Number(criticalPublication.draft_version),
      expectedDraftVersion: Number(finalDraft.version),
      actualDictionaryVersion: Number(publicationTypography?.dictionaryVersion) || null,
      expectedDictionaryVersion: Number(brandRuleEvidence.dictionary_version),
      typographyStatus: publicationTypography?.status ?? null,
      typographyReviewRunId: publicationTypography?.reviewRunId ?? null,
    })}`);
  }

  // Prove deployment recovery against the supported full runtime, not a web-only process.
  // The delayed BullMQ identity and durable outbox row must remain singular across restart.
  const criticalPublishJobId = `post-${criticalPostId}-r${Number(criticalPublication.schedule_revision)}`;
  assert(
    new Date(criticalPublication.scheduled_at).getTime() > Date.now() + 90_000,
    "scheduled publication has too little time left for a deterministic full-runtime restart",
  );
  const jobsBeforeRestart = await publishJobsForPost(criticalPostId);
  assert(
    jobsBeforeRestart.length === 1 && String(jobsBeforeRestart[0].id) === criticalPublishJobId,
    "scheduled publication did not have exactly one revision-bound BullMQ job before restart",
  );
  const durableBeforeRestart = (await pool.query(
    `select post.status, post.scheduled_at, count(outbox.id)::int as outbox_rows,
            min(outbox.status) as outbox_status
       from posts post
       join publication_outbox outbox on outbox.post_id = post.id
      where post.id = $1 and post.project_id = $2
      group by post.id, post.status, post.scheduled_at`,
    [criticalPostId, sharedProjectId],
  )).rows[0];
  assert(
    durableBeforeRestart?.status === "scheduled"
      && Number(durableBeforeRestart?.outbox_rows) === 1
      && durableBeforeRestart?.outbox_status === "enqueued",
    "scheduled publication was not durably owned by exactly one outbox row before restart",
  );

  expectedBrowserConsoleScopes.add("main");
  expectedBrowserConsoleScopes.add("reviewer");
  await stopChild(runtimeProcess, "initial full development runtime");
  await waitForRuntimeUnavailable();
  await waitForNoRuntimeWorkers();
  const durableWhileStopped = (await pool.query(
    `select post.status, post.scheduled_at, count(outbox.id)::int as outbox_rows,
            min(outbox.status) as outbox_status
       from posts post
       join publication_outbox outbox on outbox.post_id = post.id
      where post.id = $1 and post.project_id = $2
      group by post.id, post.status, post.scheduled_at`,
    [criticalPostId, sharedProjectId],
  )).rows[0];
  assert(
    durableWhileStopped?.status === "scheduled"
      && new Date(durableWhileStopped.scheduled_at).toISOString() === new Date(durableBeforeRestart.scheduled_at).toISOString()
      && Number(durableWhileStopped?.outbox_rows) === 1
      && durableWhileStopped?.outbox_status === "enqueued",
    "full-runtime shutdown lost or rewrote the durable scheduled publication",
  );
  const jobsWhileStopped = await publishJobsForPost(criticalPostId);
  assert(
    jobsWhileStopped.length === 1 && String(jobsWhileStopped[0].id) === criticalPublishJobId,
    "full-runtime shutdown lost or duplicated the delayed publication job",
  );

  startFullRuntime("runtime-restarted");
  await waitForFullRuntime("restarted full development runtime did not become ready");
  await waitForFullWorkerSet();
  const jobsAfterRestart = await publishJobsForPost(criticalPostId);
  assert(
    jobsAfterRestart.length === 1 && String(jobsAfterRestart[0].id) === criticalPublishJobId,
    "startup reconciliation did not preserve exactly one revision-bound publication job",
  );
  await reloadAfterRuntimeRestart(page, "main page");
  await reloadAfterRuntimeRestart(reviewerPage, "reviewer page");
  await page.getByRole("heading", { name: "Настройки", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await reviewerPage.getByRole("heading", { name: "Календарь", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  expectedBrowserConsoleScopes.delete("main");
  expectedBrowserConsoleScopes.delete("reviewer");
  interfaceEvidence.runtimeRestart = {
    command: "npm run dev",
    postId: criticalPostId,
    jobId: criticalPublishJobId,
    outboxRows: Number(durableWhileStopped.outbox_rows),
    jobCountBefore: jobsBeforeRestart.length,
    jobCountStopped: jobsWhileStopped.length,
    jobCountAfter: jobsAfterRestart.length,
    sessionsRecovered: true,
  };

  const criticalPublicationWaitMs = Math.max(
    180_000,
    new Date(criticalPublication.scheduled_at).getTime() - Date.now() + 60_000,
  );
  await waitFor(async () => (await pool.query(
    "select status from posts where id = $1 and project_id = $2",
    [criticalPostId, sharedProjectId],
  )).rows[0]?.status === "published", "critical Telegram album did not publish after full-runtime restart", criticalPublicationWaitMs);
  const criticalPublicationParts = (await pool.query(
    `select part_index, part_type, external_message_id, send_status
       from publication_parts where post_id = $1 order by part_index`,
    [criticalPostId],
  )).rows;
  const criticalPublicationMediaParts = criticalPublicationParts.filter(
    (part) => part.part_type === "media",
  );
  assert(
    criticalPublicationParts.every((part) => part.send_status === "sent")
      && criticalPublicationMediaParts.length === 5
      && JSON.stringify(criticalPublicationMediaParts.map((part) => Number(part.external_message_id))) === JSON.stringify([801, 802, 803, 804, 805]),
    "Telegram carousel did not persist the exact five provider album message ids",
  );
  const criticalExtraOperations = await waitFor(async () => {
    const result = await pool.query(
      `select kind, status, external_id, attempts
         from publication_extra_operations
        where project_id = $1 and post_id = $2 and kind in ('first_comment','pin')
        order by sequence_index, id`,
      [sharedProjectId, criticalPostId],
    );
    return result.rows.length === 2 && result.rows.every((row) => row.status === "succeeded")
      ? result.rows
      : null;
  }, "first comment and pin did not both reach durable succeeded states", 60_000);
  assert(
    fakeState.telegram.mediaGroupCalls === 1
      && fakeState.telegram.commentCalls === 1
      && fakeState.telegram.pinCalls === pinCallsBeforeCriticalPublication + 1
      && fakeState.telegram.commentMessageId === 901
      && fakeState.telegram.pinnedMessageId === 801,
    "fake Telegram evidence does not prove one album, one discussion comment, and one pin",
  );
  const firstCommentRequest = fakeState.telegram.requests.find((request) => request.method === "sendMessage" && request.body?.reply_parameters);
  assert(
    firstCommentRequest?.body?.text === "Материалы и запись на консультацию доступны по ссылке в публикации."
      && Number(firstCommentRequest.body.reply_parameters.message_id) === 9901,
    "first comment was not sent as a reply to the observed Telegram discussion message",
  );
  const publicationReviewTask = (await pool.query(
    `select id, responsible_user_id, review_at, status
       from publication_review_tasks where project_id = $1 and post_id = $2`,
    [sharedProjectId, criticalPostId],
  )).rows[0];
  const publicationReviewTaskId = Number(publicationReviewTask?.id);
  assert(
    Number.isSafeInteger(publicationReviewTaskId)
      && publicationReviewTaskId > 0
      && Number(publicationReviewTask?.responsible_user_id) === reviewerUserId
      && new Date(publicationReviewTask.review_at).toISOString() === reviewAt.toISOString()
      && publicationReviewTask.status === "scheduled",
    "publication did not materialize the assigned review date",
  );

  // Time travel only the durable review task after proving the UI-selected date. The
  // same production outbox and BullMQ worker then deliver the reminder deterministically.
  fakeState.telegram.plainTextRateLimited = true;
  const reminderRequests = () => fakeState.telegram.requests.filter((request) =>
    request.method === "sendMessage"
      && !request.body?.reply_parameters
      && String(request.body?.text || "").includes("Пора проверить актуальность публикации"),
  );
  const reminderRequestsBefore = reminderRequests().length;
  await pool.query(
    "update publication_review_tasks set review_at = now() - interval '1 minute' where id = $1 and project_id = $2",
    [publicationReviewTaskId, sharedProjectId],
  );
  await processDuePublicationReviews({
    pool,
    enqueue: (data) => enqueuePublicationReviewReminderJob(data, publicationReviewReminderQueue),
    limit: 10,
  });
  const reminderEvidence = await waitFor(async () => {
    const task = (await pool.query(
      `select status, reminder_status, reminder_attempts, reminder_sent_at
         from publication_review_tasks where id = $1 and project_id = $2`,
      [publicationReviewTaskId, sharedProjectId],
    )).rows[0];
    const outbox = (await pool.query(
      `select status from publication_review_reminder_outbox
        where project_id = $1 and review_task_id = $2`,
      [sharedProjectId, publicationReviewTaskId],
    )).rows[0];
    const notifications = (await pool.query(
      `select id, read_at from project_notifications
        where project_id = $1 and recipient_user_id = $2
          and event_type = 'publication_review_due'
          and entity_type = 'publication_review_task' and entity_id = $3`,
      [sharedProjectId, reviewerUserId, String(publicationReviewTaskId)],
    )).rows;
    return task?.status === "due"
      && task?.reminder_status === "sent"
      && Number(task?.reminder_attempts) === 1
      && task?.reminder_sent_at
      && outbox?.status === "completed"
      && notifications.length === 1
      && notifications[0].read_at == null
      && reminderRequests().length === reminderRequestsBefore + 1
      ? { task, notificationId: Number(notifications[0].id) }
      : null;
  }, "publication review reminder did not reach one durable in-app and Telegram delivery", 30_000);
  assert(
    Number.isSafeInteger(reminderEvidence.notificationId) && reminderEvidence.notificationId > 0,
    "publication review reminder notification has no durable id",
  );

  // Replaying the producer must not create another notification or provider call.
  await processDuePublicationReviews({
    pool,
    enqueue: (data) => enqueuePublicationReviewReminderJob(data, publicationReviewReminderQueue),
    limit: 10,
  });
  const reminderReplayEvidence = (await pool.query(
    `select
       (select count(*)::int from project_notifications
         where project_id = $1 and recipient_user_id = $2
           and event_type = 'publication_review_due'
           and entity_type = 'publication_review_task' and entity_id = $3) as notifications,
       (select reminder_attempts from publication_review_tasks
         where id = $4 and project_id = $1) as attempts`,
    [sharedProjectId, reviewerUserId, String(publicationReviewTaskId), publicationReviewTaskId],
  )).rows[0];
  assert(
    Number(reminderReplayEvidence?.notifications) === 1
      && Number(reminderReplayEvidence?.attempts) === 1
      && reminderRequests().length === reminderRequestsBefore + 1,
    "publication review reminder replay duplicated durable or Telegram delivery",
  );

  await reviewerPage.goto("/app/calendar");
  const notificationTrigger = reviewerPage.getByRole("button", { name: /^Уведомления:/u });
  await notificationTrigger.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const notificationCount = (label) => label.includes("новых нет")
    ? 0
    : Number(label.match(/\d+/u)?.[0] ?? Number.NaN);
  const unreadBeforeMark = await waitFor(async () => {
    const count = notificationCount(String(await notificationTrigger.getAttribute("aria-label") || ""));
    return Number.isSafeInteger(count) && count > 0 ? count : null;
  }, "reminder did not appear in the unread notification count", 12_000);
  await assertTouch(notificationTrigger, "open project notifications");
  await notificationTrigger.click();
  const notificationDialog = reviewerPage.getByRole("dialog", { name: "Уведомления", exact: true });
  await notificationDialog.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const reminderNotification = notificationDialog.getByRole("listitem")
    .filter({ hasText: "Пора проверить публикацию" })
    .first();
  await reminderNotification.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const markReminderRead = reminderNotification.getByRole("button", { name: "Отметить прочитанным", exact: true });
  await assertTouch(markReminderRead, "mark publication review reminder read");
  await markReminderRead.click();
  await reminderNotification.getByText("Прочитано", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await waitFor(async () => (
    notificationCount(String(await notificationTrigger.getAttribute("aria-label") || "")) === unreadBeforeMark - 1
  ), "reading one notification did not decrement the unread count", 12_000);
  await waitFor(async () => Boolean((await pool.query(
    "select read_at from project_notifications where id = $1 and project_id = $2 and recipient_user_id = $3",
    [reminderEvidence.notificationId, sharedProjectId, reviewerUserId],
  )).rows[0]?.read_at), "notification UI did not persist the read timestamp", 12_000);
  const closeNotifications = notificationDialog.getByRole("button", { name: "Закрыть уведомления", exact: true });
  await assertTouch(closeNotifications, "close project notifications");
  await closeNotifications.click();
  await waitFor(
    async () => notificationTrigger.evaluate((element) => document.activeElement === element),
    "closing notification inbox did not restore focus to its trigger",
    8_000,
  );

  await reviewerPage.reload();
  const publishedCalendarCard = reviewerPage.locator(`#calendar-real-${criticalPostId}`);
  await publishedCalendarCard.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await publishedCalendarCard.getByRole("button", { name: /^Открыть публикацию:/u }).click();
  const publicationDialog = reviewerPage.getByRole("dialog", { name: "Управление публикацией", exact: true });
  await publicationDialog.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const unpinDecision = publicationDialog.getByRole("button", { name: "Открепить", exact: true });
  await unpinDecision.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await assertTouch(unpinDecision, "decide to unpin a reviewed publication");
  await unpinDecision.click();
  await publicationDialog.getByText(
    "Решение сохранено. Открепление выполняется отдельно от основной публикации.",
    { exact: true },
  ).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await publicationDialog.getByText("Запрошено открепление", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const unpinDecisionEvidence = await waitFor(async () => {
    const task = (await pool.query(
      `select status, decision, decided_by_user_id, version
         from publication_review_tasks where id = $1 and project_id = $2`,
      [publicationReviewTaskId, sharedProjectId],
    )).rows[0];
    const extras = (await pool.query(
      `select id, status from publication_extra_operations
        where project_id = $1 and post_id = $2 and kind = 'unpin'
        order by id`,
      [sharedProjectId, criticalPostId],
    )).rows;
    return task?.status === "completed"
      && task?.decision === "unpin"
      && Number(task?.decided_by_user_id) === reviewerUserId
      && extras.length === 1
      ? { task, operationId: Number(extras[0].id) }
      : null;
  }, "unpin decision UI did not persist one project-scoped follow-up operation", 12_000);

  await reconcilePublicationExtraRuntime({
    pool,
    enqueue: (data) => enqueuePublicationExtraJob(data, publicationExtraQueue, 10_000),
    limit: 10,
  });
  const unpinEvidence = await waitFor(async () => {
    const rows = (await pool.query(
      `select id, status, external_id, attempts
         from publication_extra_operations
        where project_id = $1 and post_id = $2 and kind = 'unpin'
        order by id`,
      [sharedProjectId, criticalPostId],
    )).rows;
    return rows.length === 1
      && Number(rows[0].id) === unpinDecisionEvidence.operationId
      && rows[0].status === "succeeded"
      && Number(rows[0].attempts) === 1
      && fakeState.telegram.unpinCalls === 1
      && fakeState.telegram.unpinnedMessageId === 801
      ? rows[0]
      : null;
  }, "review decision did not execute exactly one Telegram unpin", 30_000);
  await reconcilePublicationExtraRuntime({
    pool,
    enqueue: (data) => enqueuePublicationExtraJob(data, publicationExtraQueue, 10_000),
    limit: 10,
  });
  assert(
    fakeState.telegram.unpinCalls === 1
      && Number((await pool.query(
        "select count(*)::int as n from publication_extra_operations where project_id = $1 and post_id = $2 and kind = 'unpin'",
        [sharedProjectId, criticalPostId],
      )).rows[0]?.n) === 1,
    "unpin reconciliation replay duplicated the provider action",
  );
  await publicationDialog.getByRole("button", { name: "Обновить", exact: true }).click();
  const unpinFollowup = publicationDialog.locator("li").filter({ hasText: "Открепление" }).last();
  await unpinFollowup.getByText("Выполнено", { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });

  const monthlyPublishedLineage = (await pool.query(
    `select draft_id, post_id from monthly_campaign_items where id = $1 and project_id = $2`,
    [monthlyItemId, sharedProjectId],
  )).rows[0];
  assert(
    Number(monthlyPublishedLineage?.draft_id) === monthlyDraftId
      && Number(monthlyPublishedLineage?.post_id) === criticalPostId,
    "published post is not linked back to the original monthly campaign item",
  );

  const trackingSnapshot = (await pool.query(
    `select project_id, publication_operation_id, post_id, short_link_id,
            placement, destination_url, short_url_path, utm_values, snapshot_hash
       from publication_tracking_snapshots
      where project_id = $1 and publication_operation_id = $2 and post_id = $3`,
    [sharedProjectId, criticalOperationId, criticalPostId],
  )).rows[0];
  const criticalShortPath = String(trackingSnapshot?.short_url_path || "");
  assert(
    Number(trackingSnapshot?.project_id) === sharedProjectId
      && /^\/r\/[A-Za-z0-9_-]{20,64}$/u.test(criticalShortPath)
      && criticalShortPath !== criticalBaseShortPath
      && trackingSnapshot?.destination_url === criticalTrackedDestination
      && trackingSnapshot?.utm_values?.utm_campaign === "critical_monthly_e2e"
      && /^[0-9a-f]{64}$/u.test(String(trackingSnapshot?.snapshot_hash)),
    "publication did not preserve the exact tracking selection as immutable evidence",
  );
  const trackedRedirect = await fetch(`${baseUrl}${criticalShortPath}`, {
    redirect: "manual",
    headers: {
      "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 AuroraE2E/1.0",
      referer: `${baseUrl}/app/calendar`,
    },
  });
  assert(trackedRedirect.status === 307, `tracked short link did not redirect with 307: ${trackedRedirect.status}`);
  const redirectLocation = new URL(String(trackedRedirect.headers.get("location")));
  const attributionToken = redirectLocation.searchParams.get("aurora_attribution");
  const expectedTrackedDestination = new URL(criticalTrackedDestination);
  assert(
    redirectLocation.origin === expectedTrackedDestination.origin
      && redirectLocation.pathname === expectedTrackedDestination.pathname
      && Object.entries(criticalUtmValues).every(([key, value]) => redirectLocation.searchParams.get(key) === value)
      && typeof attributionToken === "string"
      && attributionToken.length >= 40,
    "tracked redirect omitted its first-party destination or signed attribution token",
  );
  const conversionKey = "critical-monthly-consultation-001";
  const conversionPayload = {
    publicKey: trackingConfigured.publicKey,
    token: attributionToken,
    eventType: "consultation_booked",
    occurredAt: new Date().toISOString(),
    idempotencyKey: conversionKey,
  };
  const recordConversion = () => fetch(`${baseUrl}/api/tracking/conversions`, {
    method: "POST",
    headers: {
      origin: fakeBase,
      "content-type": "application/json",
      "idempotency-key": conversionKey,
    },
    body: JSON.stringify(conversionPayload),
  });
  const firstConversion = await recordConversion();
  const firstConversionBody = await firstConversion.json();
  const duplicateConversion = await recordConversion();
  const duplicateConversionBody = await duplicateConversion.json();
  assert(
    firstConversion.status === 201
      && duplicateConversion.status === 200
      && firstConversionBody?.conversion?.duplicate === false
      && duplicateConversionBody?.conversion?.duplicate === true
      && firstConversionBody?.conversion?.id === duplicateConversionBody?.conversion?.id,
    "duplicate conversion key did not replay one durable conversion",
  );
  const trackingLedger = (await pool.query(
    `select
       (select count(*)::int from short_link_clicks where project_id = $1 and short_link_id = $2 and is_likely_bot = false) as clicks,
       (select count(*)::int from conversion_events where project_id = $1 and short_link_id = $2) as conversions`,
    [sharedProjectId, Number(trackingSnapshot.short_link_id)],
  )).rows[0];
  assert(
    Number(trackingLedger?.clicks) === 1 && Number(trackingLedger?.conversions) === 1,
    "tracking ledger did not persist exactly one human click and one idempotent conversion",
  );

  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/app/analytics");
  await page.getByRole("heading", { name: "Результаты", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await page.getByRole("heading", { name: "Переходы и заявки", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const trackingFunnel = page.locator('ol[aria-label="Воронка переходов и заявок"]');
  const trackingMetric = (label) => trackingFunnel.locator("li").filter({ hasText: label }).locator("p.nums");
  await waitFor(async () => {
    const values = await Promise.all([
      trackingMetric("Все переходы").textContent(),
      trackingMetric("Уникальные переходы").textContent(),
      trackingMetric("Подтверждённые конверсии").textContent(),
    ]);
    return values.every((value) => String(value || "").trim() === "1");
  }, "Analytics UI did not render the created click, unique click, and conversion", 15_000);
  const trackingPath = page.locator('ol[aria-label="Путь выбранного среза"]');
  const trackingPathText = String(await trackingPath.textContent() || "").replace(/\s+/gu, "");
  assert(
    trackingPathText.includes(`Проект:${criticalProjectName}`.replace(/\s+/gu, "")),
    "Analytics UI did not attribute the tracking report to the selected critical project",
  );
  const trackingTableRegion = page.getByRole("region", {
    name: "Таблица переходов и подтверждённых конверсий",
    exact: true,
  });
  const trackingUiRow = trackingTableRegion.locator("tbody tr").filter({ hasText: criticalShortPath });
  await trackingUiRow.waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const trackingUiNumericCells = (await trackingUiRow.locator("td.nums").allTextContents())
    .map((value) => String(value).trim());
  assert(
    JSON.stringify(trackingUiNumericCells) === JSON.stringify(["1", "1", "1"]),
    `Analytics tracking row diverged from the durable ledger: ${JSON.stringify(trackingUiNumericCells)}`,
  );
  await page.setViewportSize({ width: 320, height: 780 });
  await assertNoHorizontalOverflow(page, "tracking Analytics at 320px");
  assert(
    await trackingTableRegion.evaluate((element) => (
      element.scrollWidth > element.clientWidth
        && ["auto", "scroll"].includes(globalThis.getComputedStyle(element).overflowX)
    )),
    "wide Analytics table is not contained in its own horizontal scroll region at 320px",
  );
  interfaceEvidence.analyticsUi = {
    project: criticalProjectName,
    path: criticalShortPath,
    totalClicks: 1,
    uniqueClicks: 1,
    confirmedConversions: 1,
    mobileContained: true,
  };

  await page.setViewportSize({ width: 320, height: 780 });
  await page.goto("/app/calendar");
  await page.getByRole("heading", { name: "Календарь", exact: true }).waitFor();
  await assertNoHorizontalOverflow(page, "calendar export entry at 320px");
  const exportTrigger = page.getByRole("button", { name: "Экспортировать", exact: true });
  await exportTrigger.waitFor({ state: "visible", timeout: UI_WAIT_TIMEOUT_MS });
  assert(await exportTrigger.count() === 1, "calendar exposed an ambiguous project export trigger");
  await assertTouch(exportTrigger, "open project export");
  await exportTrigger.click();
  const exportDialog = page.getByRole("dialog", { name: "Экспортировать данные" });
  await exportDialog.waitFor();
  await page.keyboard.press("Escape");
  await waitFor(async () => !(await exportDialog.isVisible()), "Escape did not close the export dialog", 5_000);
  assert(await exportTrigger.evaluate((element) => element === document.activeElement), "export dialog did not restore focus to its trigger");
  await page.setViewportSize({ width: 1280, height: 900 });
  await exportTrigger.click();
  await exportDialog.waitFor();
  await exportDialog.locator('input[name="project-export-kind"][value="content_plan"]').check();
  await exportDialog.getByLabel("С даты", { exact: true }).fill(publicationDate);
  await exportDialog.getByLabel("По дату", { exact: true }).fill(publicationDate);
  const previewExport = exportDialog.getByRole("button", { name: "Проверить выборку", exact: true });
  await assertTouch(previewExport, "preview project export");
  await previewExport.click();
  await exportDialog.getByRole("heading", { name: "Предварительная выборка", exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  await exportDialog.getByText(monthlyItemTitle, { exact: true }).waitFor({ timeout: UI_WAIT_TIMEOUT_MS });
  const previewRowCountText = await exportDialog.getByText(/Найдено строк:/u).textContent();
  const previewRowCount = Number(String(previewRowCountText).replace(/\D/gu, ""));
  assert(previewRowCount === 1, `project export preview expected one published row, received ${previewRowCount}`);

  const exportBuffers = new Map();
  for (const format of ["csv", "xlsx", "pdf"]) {
    await exportDialog
      .locator(`label:has(input[name="project-export-format"][value="${format}"])`)
      .click();
    const downloadPromise = page.waitForEvent("download", { timeout: UI_WAIT_TIMEOUT_MS });
    await exportDialog.getByRole("button", { name: "Сформировать файл", exact: true }).click();
    const download = await downloadPromise;
    const target = resolve(artifactDir, `critical-project-export.${format}`);
    await download.saveAs(target);
    const bytes = await readFile(target);
    assert(bytes.byteLength > 100, `${format.toUpperCase()} project export is empty`);
    exportBuffers.set(format, bytes);
    await waitFor(
      async () => await exportDialog.getByRole("button", { name: "Сформировать файл", exact: true }).isEnabled(),
      `${format.toUpperCase()} export did not return to an interactive state`,
      10_000,
    );
  }

  const csvRows = parseCsv(exportBuffers.get("csv"));
  const csvHeaderIndex = csvRows.findIndex((row) => row.includes("Тема"));
  assert(csvHeaderIndex >= 0, "CSV export omitted the content-plan header");
  const csvTitleIndex = csvRows[csvHeaderIndex].indexOf("Тема");
  const csvDataRows = csvRows.slice(csvHeaderIndex + 1).filter((row) => row.some((value) => String(value).trim()));
  assert(
    csvDataRows.length === previewRowCount
      && csvDataRows[0]?.[csvTitleIndex] === monthlyItemTitle,
    "CSV rows do not match the immutable export preview",
  );

  const xlsxInspection = inspectXlsx(exportBuffers.get("xlsx"));
  assert(/No errors detected/iu.test(xlsxInspection.validation), "XLSX archive failed structural validation");
  const xlsxHeaderIndex = xlsxInspection.rows.findIndex((row) => row.some((cell) => cell?.value === "Тема"));
  assert(xlsxHeaderIndex >= 0, "XLSX export omitted the content-plan header");
  const xlsxTitleIndex = xlsxInspection.rows[xlsxHeaderIndex].findIndex((cell) => cell?.value === "Тема");
  const xlsxDataRows = xlsxInspection.rows.slice(xlsxHeaderIndex + 1).filter((row) => row.some((cell) => String(cell?.value || "").trim()));
  assert(
    xlsxDataRows.length === previewRowCount
      && xlsxDataRows[0]?.[xlsxTitleIndex]?.value === monthlyItemTitle,
    "XLSX rows do not match the immutable export preview",
  );

  const pdfInspection = inspectPdf(exportBuffers.get("pdf"));
  assert(pdfInspection.text.includes(monthlyItemTitle), "PDF export omitted the monthly material title");
  const foreignProjectSentinel = "Новый недельный пост";
  const serializedExports = [
    exportBuffers.get("csv").toString("utf8"),
    xlsxInspection.sheet,
    pdfInspection.text,
  ];
  assert(
    serializedExports.every((content) => content.includes(monthlyItemTitle) && !content.includes(foreignProjectSentinel)),
    "project export parity or project isolation failed across CSV, XLSX, and PDF",
  );
  const projectExportEvidence = (await pool.query(
    `select operation.id, operation.format, operation.status, operation.snapshot,
            operation.snapshot_hash, artifact.byte_size, artifact.sha256
       from project_export_operations operation
       join project_export_artifacts artifact
         on artifact.operation_id = operation.id and artifact.project_id = operation.project_id
      where operation.project_id = $1 and operation.requested_by_user_id = $2
      order by operation.id desc limit 3`,
    [sharedProjectId, userId],
  )).rows;
  assert(
    projectExportEvidence.length === 3
      && projectExportEvidence.every((row) => row.status === "ready" && Number(row.byte_size) > 100 && /^[0-9a-f]{64}$/u.test(String(row.sha256)))
      && JSON.stringify(projectExportEvidence.map((row) => row.format).sort()) === JSON.stringify(["csv", "pdf", "xlsx"]),
    "durable export operations or artifacts are incomplete",
  );
  const exportSnapshotRows = projectExportEvidence.map((row) => row.snapshot?.rows);
  assert(
    exportSnapshotRows.every((rows) => Array.isArray(rows) && rows.length === previewRowCount)
      && exportSnapshotRows.every((rows) => rows[0]?.projectId === String(sharedProjectId) && rows[0]?.title === monthlyItemTitle)
      && exportSnapshotRows.every((rows) => JSON.stringify(rows) === JSON.stringify(exportSnapshotRows[0])),
    "CSV/XLSX/PDF operations were not rendered from the same project-scoped row snapshot",
  );
  await page.setViewportSize({ width: 640, height: 800 });
  await assertNoHorizontalOverflow(page, "project export dialog at 200% desktop zoom equivalent");

  interfaceEvidence.viewportWidths = await captureViewportEvidence(page);
  interfaceEvidence.keyboardOnly = await runKeyboardOnlyCriticalPass(page);
  await writeFile(
    resolve(artifactDir, "browser-diagnostics.json"),
    `${JSON.stringify({ issues: browserIssues, interface: interfaceEvidence }, null, 2)}\n`,
    "utf8",
  );
  assert(
    browserIssues.length === 0,
    `browser runtime reported ${browserIssues.length} unexpected issue(s): ${browserIssues
      .slice(0, 5)
      .map((issue) => `${issue.context}/${issue.kind}: ${issue.message}`)
      .join(" | ")}`,
  );

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
      truncatedReviewDraft: true,
      truncatedAckCommitted: true,
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
    publicationPipeline: {
      draftId: publicationDraft.id,
      operationId: publicationOperationId,
      postId: publicationPostId,
      scheduleRevision: Number(publicationRows[0].schedule_revision),
      doubleSubmitCollapsed: true,
    },
    providerExtrasPipeline: {
      operationId: commentsOperationId,
      destinationPosts: commentsDestinationRows.map((row) => ({
        network: row.network,
        postId: Number(row.id),
        status: row.status,
      })),
      commentsMode: commentsPreferences.commentsMode,
      vkConfigureComments: terminalExtra("vk", "configure_comments")?.status,
      telegramPin: terminalExtra("tg", "pin")?.status,
      unsupportedNotCalled: [
        `vk:${terminalExtra("vk", "pin")?.status}`,
        `tg:${terminalExtra("tg", "configure_comments")?.status}`,
      ],
      providerCalls: {
        vkWallPost: fakeState.vk.wallPostCalls,
        vkCloseComments: fakeState.vk.closeCommentsCalls,
        telegramPublishAndPinExactlyOnce: true,
      },
    },
    criticalJourney: {
      project: {
        id: sharedProjectId,
        ownerUserId: userId,
        reviewerPublisherUserId: reviewerUserId,
        invitationAccepted: true,
        legacyProjectIsolated: true,
      },
      monthlyCampaign: {
        campaignId: monthlyCampaignId,
        initialPlanId: monthlyPlanId,
        planId: activeMonthlyPlanId,
        movedItemId,
        regeneratedPlanId,
        itemId: monthlyItemId,
        draftId: monthlyDraftId,
        title: monthlyItemTitle,
        firstWeekDrafts: preparedMonthlyItems.length,
      },
      composer: {
        humanAdoptionPreservedDraftId: true,
        simplifiedAdvancedPanelsAbsent: true,
        trackingShortPath: criticalShortPath,
        carouselCards: Number(legalRenderEvidence.cards),
        videoScriptId: Number(videoScriptEvidence.id),
        videoDurationSeconds: Number(videoScriptEvidence.duration_seconds),
        exactEditorialApprovalAllowsWordingAsWritten: publicationTypography?.status === "published_as_is",
        publicationBlocks: selectedPublicationBlocks,
      },
      editorial: {
        decisions: editorialEvidence.map((decision) => decision.decision),
        exactApprovedRevisionId: approvedWorkflow.approvedRevisionId,
        exactApprovedContentHash: approvedWorkflow.approvedContentHash,
        scheduledByRole: "publisher",
      },
      publication: {
        operationId: criticalOperationId,
        postId: criticalPostId,
        albumMessageIds: criticalPublicationMediaParts.map((part) => Number(part.external_message_id)),
        extras: criticalExtraOperations.map((operation) => ({
          kind: operation.kind,
          status: operation.status,
          externalId: operation.external_id,
        })),
        reviewAt: new Date(publicationReviewTask.review_at).toISOString(),
        reminder: {
          status: reminderEvidence.task.reminder_status,
          attempts: Number(reminderEvidence.task.reminder_attempts),
          notificationReadThroughUi: true,
          focusRestored: true,
          exactlyOnce: true,
        },
        unpin: {
          operationId: Number(unpinEvidence.id),
          status: unpinEvidence.status,
          externalId: unpinEvidence.external_id,
          decidedThroughUi: true,
          exactlyOnce: true,
        },
      },
      tracking: {
        clickCount: Number(trackingLedger.clicks),
        conversionCount: Number(trackingLedger.conversions),
        duplicateConversionCollapsed: true,
      },
      exports: {
        previewRows: previewRowCount,
        formats: projectExportEvidence.map((row) => row.format).sort(),
        csvXlsxRowParity: csvDataRows.length === xlsxDataRows.length,
        pdfTitleParity: pdfInspection.text.includes(monthlyItemTitle),
        projectIsolation: true,
      },
      interface: {
        keyboardProjectCreate: true,
        keyboardInvitationAccept: true,
        keyboardCarouselReorder: true,
        keyboardMonthlyMove: true,
        editorialActionsThroughUi: true,
        exportEscapeAndFocusRestore: true,
        widths: interfaceEvidence.viewportWidths.map((viewport) => viewport.width),
        viewportArtifacts: interfaceEvidence.viewportWidths.map((viewport) => viewport.file),
        reducedMotion: interfaceEvidence.reducedMotion,
        keyboardOnly: interfaceEvidence.keyboardOnly,
        runtimeRestart: interfaceEvidence.runtimeRestart,
        analyticsUi: interfaceEvidence.analyticsUi,
        todayUi: interfaceEvidence.todayUi,
        browserRuntimeErrors: browserIssues.length,
        touchTargets: true,
      },
    },
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
  await writeFile(
    resolve(artifactDir, "browser-diagnostics.json"),
    `${JSON.stringify({ issues: browserIssues, interface: interfaceEvidence }, null, 2)}\n`,
    "utf8",
  ).catch(() => {});
  throw error;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (publishQueue) await publishQueue.close().catch(() => {});
  if (mediaQueue) await mediaQueue.close().catch(() => {});
  if (statsQueue) await statsQueue.close().catch(() => {});
  if (legalVisualQueue) await legalVisualQueue.close().catch(() => {});
  if (projectExportQueue) await projectExportQueue.close().catch(() => {});
  if (publicationExtraQueue) await publicationExtraQueue.close().catch(() => {});
  if (publicationReviewReminderQueue) await publicationReviewReminderQueue.close().catch(() => {});
  await Promise.all(children.map((subprocess, index) => (
    stopChild(subprocess, `full development child ${index + 1}`).catch(() => {})
  )));
  if (fakeServer) await new Promise((resolve) => fakeServer.close(resolve)).catch(() => {});
  await redis.flushdb().catch(() => {});
  await redis.quit().catch(() => {});
  await pool.query("drop schema public cascade").catch(() => {});
  await pool.query("create schema public").catch(() => {});
  await pool.end().catch(() => {});
}
