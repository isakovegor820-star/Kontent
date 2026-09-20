import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { botConnectionKey, parseLegacyBotStartPayload } from "../src/lib/bot-connection.mjs";
import { formatBotDisconnectConfirmation } from "./bot-copy.mjs";

const source = ts.createSourceFile("worker.mjs", readFileSync(new URL("../worker.mjs", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

// Exercise the real worker functions without starting polling, queues or live delivery.
function workerFunction(name, dependencies) {
  const declaration = source.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === name);
  if (!declaration) throw new Error(`Missing worker function ${name}`);
  return new Function(...Object.keys(dependencies), `return (${declaration.getText(source)})`)(...Object.values(dependencies));
}

function startHarness(account = { id: "7", enabled: true }) {
  const dependencies = {
    pool: {},
    userByChat: vi.fn(async () => account),
    botSendConnectionOnboarding: vi.fn(),
    botSendMenu: vi.fn(),
    tgSend: vi.fn(),
    consumeLegacyBotLink: vi.fn(async () => ({ state: "invalid" })),
    parseLegacyBotStartPayload,
    botChannelConnectPrompt: vi.fn(async () => null),
    botToday: vi.fn(async () => ({ text: "Сегодня", buttons: [] })),
    COMPETITOR_MECHANIC_ACTION_LABEL: "Создать пост по механике",
  };
  dependencies.botResumeAccount = workerFunction("botResumeAccount", dependencies);
  return { ...dependencies, start: workerFunction("handleStart", dependencies) };
}

describe("returning to the Telegram bot", () => {
  it("binds a disconnect button to the saved connection within Telegram callback limits", async () => {
    const connectionKey = botConnectionKey(7, 123, "42");
    const prompt = workerFunction("botDisconnectPrompt", { pool: {}, getBotAccountConnection: async () => ({ connectionKey }), formatBotDisconnectConfirmation });
    const result = await prompt(7);
    expect(result.buttons[0][0].data).toBe(`connection:disconnect_confirm:${connectionKey}`);
    expect(Buffer.byteLength(result.buttons[0][0].data)).toBeLessThanOrEqual(64);
  });
  it("opens the saved account menu on every bare /start", async () => {
    const h = startHarness();
    await h.start(123, { id: 123 }, null);
    await h.start(123, { id: 123 }, null);
    expect(h.botSendMenu).toHaveBeenCalledTimes(2);
    expect(h.botSendMenu).toHaveBeenCalledWith(123, 7);
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(h.consumeLegacyBotLink).not.toHaveBeenCalled();
  });

  it.each(["a".repeat(32), `${"b".repeat(32)}_channel`, "obsolete-payload"])("keeps the current account when reopening an unusable link: %s", async (code) => {
    const h = startHarness();
    await h.start(123, { id: 123 }, code);
    expect(h.botSendMenu).toHaveBeenCalledWith(123, 7);
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(h.botChannelConnectPrompt).not.toHaveBeenCalled();
    expect(h.tgSend).not.toHaveBeenCalled();
  });

  it("offers first-time connection only to an unlinked chat", async () => {
    const h = startHarness(null);
    await h.start(123, { id: 123 }, null);
    expect(h.botSendConnectionOnboarding).toHaveBeenCalledOnce();
    expect(h.botSendMenu).not.toHaveBeenCalled();
  });

  it("does not bypass disabled bot access through /start", async () => {
    const h = startHarness({ id: "7", enabled: false });
    await h.start(123, { id: 123 }, null);
    expect(h.tgSend).toHaveBeenCalledWith(123, expect.stringContaining("приостановлен"));
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
    expect(h.botSendMenu).not.toHaveBeenCalled();
  });

  it("does not treat a failed account read as an unlinked account", async () => {
    const h = startHarness();
    h.userByChat.mockRejectedValue(new Error("database unavailable"));
    await expect(h.start(123, { id: 123 }, null)).rejects.toThrow("database unavailable");
    expect(h.botSendConnectionOnboarding).not.toHaveBeenCalled();
  });

  it("keeps a fresh explicit channel intent", async () => {
    const h = startHarness();
    h.consumeLegacyBotLink.mockResolvedValue({ state: "connected", userId: 7, projectId: 12 });
    await h.start(123, { id: 123 }, `${"a".repeat(32)}_channel`);
    expect(h.botChannelConnectPrompt).toHaveBeenCalledWith(7, { force: true });
  });

  it("routes a requested account transfer through explicit web confirmation", async () => {
    const h = startHarness();
    h.consumeLegacyBotLink.mockResolvedValue({ state: "move_required" });
    await h.start(123, { id: 123 }, "a".repeat(32));
    expect(h.botSendConnectionOnboarding).toHaveBeenCalledWith(123, { id: 123 }, { moveRequired: true });
    expect(h.botChannelConnectPrompt).not.toHaveBeenCalled();
    expect(h.botToday).not.toHaveBeenCalled();
  });
});
