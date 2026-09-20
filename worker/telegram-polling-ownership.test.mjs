import { readFileSync } from "node:fs";
import { createContext, runInContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";

const source = ts.createSourceFile("worker.mjs", readFileSync(new URL("../worker.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functions = ["ensureTelegramPollingLease", "verifyTelegramPollingLease", "enableTelegramPollingGuard", "openTelegramPollingQueue", "pollUpdates"];
const code = functions.map((name) => source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(source)).join("\n");

function harness() {
  const state = { redisOwner: true, polls: 0 };
  const context = createContext({
    TOKEN: "test-token", BOT_POLL: true, shutdownStarted: false,
    TELEGRAM_POLLING_OWNER: "worker-a", TELEGRAM_POLLING_GUARD: { allowed_updates: [] },
    TELEGRAM_BOT_COMMANDS: [], telegramPollingLeaseHeld: true,
    telegramPollingLeaseRenewal: null, telegramPollingQueueOpen: true,
    connection: {}, console: { log() {}, warn() {}, error() {} },
    acquireTelegramPollingLease: vi.fn(async () => false),
    releaseTelegramPollingLease: vi.fn(async () => true),
    renewTelegramPollingLease: vi.fn(async () => state.redisOwner),
    startTelegramPollingLeaseRenewal: vi.fn(),
    syncTelegramDiscussionChats: vi.fn(async () => null),
    pool: { query: vi.fn(async () => ({ rows: [{ last_update: 0 }] })) },
    refreshTelegramPollingHeartbeat: vi.fn(),
    telegramUpdateContext: { run: async (_context, run) => run() },
    handleUpdate: vi.fn(async () => undefined),
    sleep: async () => { context.shutdownStarted = true; },
    telegramRetryAfterMs: () => null,
    tg: vi.fn(async (method) => {
      if (method !== "getUpdates") return { ok: true };
      state.polls += 1;
      if (state.polls > 1) context.shutdownStarted = true;
      return { ok: true, result: state.polls === 1 ? [{ update_id: 1 }, { update_id: 2 }] : [] };
    }),
  });
  runInContext(code, context);
  return { state, context };
}

describe("Telegram polling ownership during handover", () => {
  it("releases ownership acquired while shutdown was starting", async () => {
    const { context } = harness();
    context.telegramPollingLeaseHeld = false;
    context.acquireTelegramPollingLease.mockImplementation(async () => { context.shutdownStarted = true; return true; });
    expect(await context.ensureTelegramPollingLease()).toBe(false);
    expect(context.releaseTelegramPollingLease).toHaveBeenCalledOnce();
    expect(context.startTelegramPollingLeaseRenewal).not.toHaveBeenCalled();
    expect(context.telegramPollingLeaseHeld).toBe(false);
  });
  it("does not configure Telegram, reconcile channels or poll without ownership", async () => {
    const { context } = harness();
    context.telegramPollingLeaseHeld = false;
    await context.pollUpdates();
    expect(context.tg).not.toHaveBeenCalled();
    expect(context.syncTelegramDiscussionChats).not.toHaveBeenCalled();
    expect(context.pool.query).not.toHaveBeenCalled();
  });

  it("checks Redis even when the in-memory ownership flag is still true", async () => {
    const { context, state } = harness();
    state.redisOwner = false;
    await context.pollUpdates();
    expect(context.renewTelegramPollingLease).toHaveBeenCalled();
    expect(context.tg).not.toHaveBeenCalled();
    expect(context.telegramPollingLeaseHeld).toBe(false);
  });

  it("discards a batch if ownership changes while Telegram is responding", async () => {
    const { context, state } = harness();
    context.tg.mockImplementation(async (method) => {
      if (method === "getUpdates") state.redisOwner = false;
      return { ok: true, result: [{ update_id: 1 }] };
    });
    await context.pollUpdates();
    expect(context.handleUpdate).not.toHaveBeenCalled();
    expect(context.refreshTelegramPollingHeartbeat).not.toHaveBeenCalled();
    expect(context.pool.query.mock.calls.some(([sql]) => sql.startsWith("update bot_state"))).toBe(false);
  });

  it("stops after a long command loses ownership without acknowledging the batch", async () => {
    const { context, state } = harness();
    context.handleUpdate.mockImplementation(async () => { state.redisOwner = false; });
    await context.pollUpdates();
    expect(context.handleUpdate).toHaveBeenCalledTimes(1);
    expect(context.pool.query.mock.calls.some(([sql]) => sql.startsWith("update bot_state"))).toBe(false);
  });

  it("cannot close another owner's Telegram queue during shutdown", async () => {
    const { context, state } = harness();
    state.redisOwner = false;
    context.shutdownStarted = true;
    expect(await context.enableTelegramPollingGuard()).toBe(false);
    expect(context.tg).not.toHaveBeenCalled();
  });

  it("does not delete the webhook if ownership changes while the guard is armed", async () => {
    const { context, state } = harness();
    context.tg.mockImplementation(async () => { state.redisOwner = false; return { ok: true }; });
    expect(await context.openTelegramPollingQueue()).toBe(false);
    expect(context.tg.mock.calls.map(([method]) => method)).toEqual(["setWebhook"]);
  });

  it("rechecks ownership between commands and persists progress monotonically", async () => {
    const { context, state } = harness();
    context.pool.query.mockImplementation(async (sql) => {
      if (sql.startsWith("update bot_state")) state.redisOwner = false;
      return { rows: [{ last_update: 0 }] };
    });
    await context.pollUpdates();
    expect(context.handleUpdate).toHaveBeenCalledTimes(1);
    expect(context.pool.query.mock.calls.filter(([sql]) => sql.startsWith("update bot_state")))
      .toEqual([[expect.stringContaining("greatest(last_update, $1)"), [1]]]);
  });
});
