import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReadOnlyLifecycle } from "./read-only-lifecycle.mjs";
import { mapConcurrent } from "./lib.mjs";
import { selectDueCompetitorSources } from "./reconnaissance-schedule.mjs";

// Evaluate the actual worker functions without importing its DB/Redis/startup side effects.
const source = readFileSync(process.env.AURORA_SHUTDOWN_SOURCE || new URL("../worker.mjs", import.meta.url), "utf8");
const parsed = ts.createSourceFile("worker.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
function workerFunction(name, dependencies) {
  const node = parsed.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === name);
  if (!node) throw new Error(`Missing worker function ${name}`);
  return new Function(...Object.keys(dependencies), `${node.getText(parsed)}; return ${name};`)(...Object.values(dependencies));
}
function harness(fetchImpl) {
  vi.useFakeTimers();
  vi.stubGlobal("fetch", fetchImpl);
  const readOnlyWork = createReadOnlyLifecycle();
  const quiet = { warn: vi.fn(), log: vi.fn(), error: vi.fn() };
  const fetchTgWithBackoff = workerFunction("fetchTgWithBackoff", {
    readOnlyWork, TG_FETCH_ATTEMPTS: 3, console: quiet,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  return { readOnlyWork, fetchTgWithBackoff };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("restartable worker reads during shutdown", () => {
  it("cancels reads before draining publications, and still waits for the active send", async () => {
    const readOnlyWork = createReadOnlyLifecycle();
    let releaseSend;
    const activeSend = new Promise((resolve) => { releaseSend = resolve; });
    const shutdownText = parsed.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === "shutdown").getText(parsed);
    const queues = Object.fromEntries([...shutdownText.matchAll(/await (\w+)\?\.close\(\)/gu)].map((match) => [match[1], null]));
    const close = vi.fn(() => activeSend);
    const closeCron = vi.fn(async () => {});
    const exit = vi.fn();
    const reportWorkerDatabasePool = vi.fn();
    const clearInterval = vi.fn();
    const workerDatabasePoolReportTimer = {};
    const shutdown = workerFunction("shutdown", {
      ...queues, readOnlyWork, shutdownStarted: false, worker: { close }, cronWorker: { close: closeCron },
      telegramPollingLeaseHeld: false, TELEGRAM_POLLING_OWNER: null,
      stopPublicationHeartbeat: vi.fn(), stopTelegramPollingLeaseRenewal: vi.fn(),
      reportWorkerDatabasePool, clearInterval, workerDatabasePoolReportTimer,
      console: { log: vi.fn() }, process: { exit },
    });
    const run = shutdown("SIGTERM");
    await shutdown("SIGTERM");
    expect(readOnlyWork.signal.aborted).toBe(true);
    expect(close).toHaveBeenCalledTimes(1);
    expect(closeCron).toHaveBeenCalledExactlyOnceWith(true);
    expect(clearInterval).toHaveBeenCalledExactlyOnceWith(workerDatabasePoolReportTimer);
    expect(reportWorkerDatabasePool).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    releaseSend(); await run;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });
  it("cancels Bot API reads without aborting or duplicating a pending send", async () => {
    const readOnlyWork = createReadOnlyLifecycle();
    const calls = [];
    let confirmSend;
    const fetchImpl = vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      calls.push({ url, signal });
      if (url.endsWith("/sendMessage")) confirmSend = () => resolve(Response.json({ ok: true, result: { message_id: 7 } }));
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    vi.stubGlobal("fetch", fetchImpl);
    const query = vi.fn(async () => ({ rows: [] }));
    const tgTransport = workerFunction("tgTransport", {
      readOnlyWork, TELEGRAM_API_URL: "https://telegram.invalid", TOKEN: "0:synthetic",
      readTelegramResponse: (response) => response.json(), pool: { query },
    });
    const tgRead = workerFunction("tgRead", { readOnlyWork, tgTransport });
    const send = tgTransport("sendMessage", { chat_id: 1 });
    const read = tgRead("getChat", { chat_id: "@synthetic" }).catch((error) => error);
    readOnlyWork.stop();
    expect(readOnlyWork.isCancellation(await read)).toBe(true);
    expect(calls.find((call) => call.url.endsWith("/sendMessage")).signal.aborted).toBe(false);
    await expect(tgRead("sendMessage", { chat_id: 1 })).rejects.toThrow("telegram_read_method_required");
    confirmSend();
    await expect(send).resolves.toMatchObject({ ok: true, result: { message_id: 7 } });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(1);
  });
  it("preserves a caller timeout as a timeout when shutdown has not started", async () => {
    const readOnlyWork = createReadOnlyLifecycle();
    const timeout = new DOMException("deadline", "TimeoutError");
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })));
    const result = readOnlyWork.fetch("https://read.invalid", { signal: controller.signal }).catch((error) => error);
    controller.abort(timeout);
    expect(await result).toBe(timeout);
    expect(readOnlyWork.isCancellation(await result)).toBe(false);
  });
  it("does not start a new Telegram request after shutdown in network backoff", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    const { readOnlyWork, fetchTgWithBackoff } = harness(fetchImpl);
    const result = fetchTgWithBackoff("https://t.me/s/synthetic").catch((error) => error);
    await vi.advanceTimersByTimeAsync(1);
    readOnlyWork.stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(readOnlyWork.isCancellation(await result)).toBe(true);
  });
  it("releases a one-hour Retry-After wait within the existing shutdown bound", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 429, headers: { "retry-after": "3600" } }));
    const { readOnlyWork, fetchTgWithBackoff } = harness(fetchImpl);
    let settled = false;
    void fetchTgWithBackoff("https://t.me/s/synthetic").catch(() => {}).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(1);
    readOnlyWork.stop();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(settled).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("aborts an in-flight public read immediately", async () => {
    const fetchImpl = vi.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const { readOnlyWork, fetchTgWithBackoff } = harness(fetchImpl);
    let cancelled = false;
    void fetchTgWithBackoff("https://t.me/s/synthetic").catch((error) => { cancelled = readOnlyWork.isCancellation(error); });
    readOnlyWork.stop();
    await vi.advanceTimersByTimeAsync(1);
    expect(cancelled).toBe(true);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });
  it("retains normal network retries and the original final error", async () => {
    const network = new Error("ECONNRESET");
    const fetchImpl = vi.fn().mockRejectedValue(network);
    const { fetchTgWithBackoff } = harness(fetchImpl);
    const result = fetchTgWithBackoff("https://t.me/s/synthetic").catch((error) => error);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(await result).toBe(network);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("honors Retry-After during normal work, and returns final 429 without inventing success", async () => {
    const limited = new Response(null, { status: 429, headers: { "retry-after": "30" } });
    const fetchImpl = vi.fn().mockResolvedValue(limited);
    const { fetchTgWithBackoff } = harness(fetchImpl);
    const result = fetchTgWithBackoff("https://t.me/s/synthetic");
    await vi.advanceTimersByTimeAsync(29_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(await result).toBe(limited);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
  it("does not turn a cancelled page into no_feed or partial successful history", async () => {
    const { readOnlyWork } = harness(vi.fn());
    readOnlyWork.stop();
    const fetchCompetitorPage = workerFunction("fetchCompetitorPage", {
      readOnlyWork, fetchTgWithBackoff: async () => readOnlyWork.throwIfStopped(),
      console: { error: vi.fn() },
    });
    const result = await fetchCompetitorPage("synthetic").catch((error) => error);
    expect(readOnlyWork.isCancellation(result)).toBe(true);
  });
  it("leaves interrupted sources pending and does not start the next concurrency batch", async () => {
    const readOnlyWork = createReadOnlyLifecycle();
    let release;
    const blocked = new Promise((resolve) => { release = resolve; });
    const rows = Array.from({ length: 13 }, (_, id) => ({ id, handle: `synthetic${id}`, status: "refreshing" }));
    const query = vi.fn(async () => ({ rows: [] }));
    const collectCompetitor = vi.fn(async () => { await blocked; readOnlyWork.throwIfStopped(); });
    const collectCompetitors = workerFunction("collectCompetitors", {
      readOnlyWork, pool: { query }, selectDueCompetitorSources: async () => rows,
      mapConcurrent, RECON_CONCURRENCY: 6, collectCompetitor,
      console: { error: vi.fn(), log: vi.fn() },
    });
    const run = collectCompetitors();
    await Promise.resolve(); await Promise.resolve();
    expect(collectCompetitor).toHaveBeenCalledTimes(6);
    readOnlyWork.stop(); release(); await run;
    expect(collectCompetitor).toHaveBeenCalledTimes(6);
    expect(query).not.toHaveBeenCalled();
    const restartQuery = vi.fn(async () => ({ rows }));
    expect(await selectDueCompetitorSources({ query: restartQuery })).toEqual(rows);
    expect(restartQuery.mock.calls[0][0]).toContain("status in ('pending','refreshing')");
    expect(() => createReadOnlyLifecycle().throwIfStopped()).not.toThrow();
  });
});
