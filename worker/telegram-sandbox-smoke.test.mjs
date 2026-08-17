import { describe, expect, it, vi } from "vitest";

import { runTelegramSandboxSmoke } from "../scripts/telegram-sandbox-smoke.mjs";

const CONFIRMATION = "I_UNDERSTAND_THIS_SENDS_A_REAL_TELEGRAM_MESSAGE";
const TOKEN = "1234567890:abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMN";

function environment(overrides = {}) {
  return {
    AURORA_ALLOW_TELEGRAM_SANDBOX_SEND: CONFIRMATION,
    TG_SANDBOX_BOT_TOKEN: TOKEN,
    TG_SANDBOX_CHAT_ID: "-1001234567890",
    TG_SANDBOX_EXPECTED_BOT_USERNAME: "aurora_sandbox_bot",
    ...overrides,
  };
}

function jsonResponse(payload) {
  return { json: vi.fn(async () => payload) };
}

describe("Telegram sandbox smoke", () => {
  it("refuses to use ordinary Telegram variables or send without an explicit confirmation", async () => {
    const fetchImpl = vi.fn();
    await expect(runTelegramSandboxSmoke({
      env: { TG_BOT_TOKEN: TOKEN, TG_CHAT_ID: "-1001234567890" },
      fetchImpl,
    })).rejects.toMatchObject({ code: "telegram_sandbox_send_not_confirmed" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses a sandbox token that is also configured as the ordinary bot", async () => {
    await expect(runTelegramSandboxSmoke({
      env: environment({ TG_BOT_TOKEN: TOKEN }),
      fetchImpl: vi.fn(),
    })).rejects.toMatchObject({ code: "sandbox_token_must_be_distinct" });
  });

  it("refuses a sandbox chat that is also configured as the ordinary chat", async () => {
    const fetchImpl = vi.fn();
    await expect(runTelegramSandboxSmoke({
      env: environment({ TG_CHAT_ID: "-1001234567890" }),
      fetchImpl,
    })).rejects.toMatchObject({ code: "sandbox_chat_must_be_distinct" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks bot identity and business owner before one silent sandbox send", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { username: "aurora_sandbox_bot" } }))
      .mockResolvedValueOnce(jsonResponse({
        ok: true,
        result: { id: "business-1", user: { id: 8123456789 } },
      }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { message_id: 73 } }));
    const logger = { log: vi.fn() };
    await expect(runTelegramSandboxSmoke({
      env: environment({
        TG_SANDBOX_BUSINESS_CONNECTION_ID: "business-connection-1",
        TG_SANDBOX_EXPECTED_BUSINESS_USER_ID: "8123456789",
      }),
      fetchImpl,
      logger,
      now: new Date("2026-08-17T10:00:00.000Z"),
    })).resolves.toMatchObject({
      ok: true,
      botUsername: "aurora_sandbox_bot",
      businessConnectionChecked: true,
      messageId: 73,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetchImpl.mock.calls[2][1].body)).toMatchObject({
      chat_id: "-1001234567890",
      business_connection_id: "business-connection-1",
      disable_notification: true,
    });
    expect(logger.log.mock.calls[0][0]).not.toContain(TOKEN);
  });

  it("does not send when the business connection owner is unexpected", async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { username: "aurora_sandbox_bot" } }))
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { user: { id: 9000000000 } } }));
    await expect(runTelegramSandboxSmoke({
      env: environment({
        TG_SANDBOX_BUSINESS_CONNECTION_ID: "business-connection-1",
        TG_SANDBOX_EXPECTED_BUSINESS_USER_ID: "8123456789",
      }),
      fetchImpl,
    })).rejects.toMatchObject({ code: "sandbox_business_owner_mismatch" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ ok: false, description: "forbidden" }, "telegram_rejected"],
    [{ ok: true, result: {} }, "telegram_response_ambiguous"],
  ])("fails closed for rejected and malformed sends", async (sendResponse, code) => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ ok: true, result: { username: "aurora_sandbox_bot" } }))
      .mockResolvedValueOnce(jsonResponse(sendResponse));
    await expect(runTelegramSandboxSmoke({ env: environment(), fetchImpl }))
      .rejects.toEqual(expect.objectContaining({ code }));
  });
});
