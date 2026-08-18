import { describe, expect, it, vi } from "vitest";

import {
  loadAdminBotData,
  probeAdminTelegramBot,
  repairAdminTelegramConfiguration,
  sendAdminBotTest,
} from "./admin-bot";
import { TELEGRAM_BOT_COMMANDS } from "./telegram-bot-commands.mjs";
import { telegramPollingGuardConfiguration } from "../../worker/telegram-polling-guard.mjs";

describe("admin Telegram runtime probe", () => {
  it("reports missing configuration without making a network request", async () => {
    const fetcher = vi.fn();
    await expect(probeAdminTelegramBot({}, fetcher)).resolves.toMatchObject({
      state: "not_configured",
      configured: false,
      miniAppReady: false,
      voiceReady: false,
      businessReady: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only safe bot identity fields", async () => {
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      const result = value.endsWith("/getMe")
        ? { id: 77, first_name: "Аврора", username: "aurora_bot", can_connect_to_business: true }
        : value.endsWith("/getWebhookInfo")
          ? { url: "" }
          : TELEGRAM_BOT_COMMANDS;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await probeAdminTelegramBot({
      TG_BOT_TOKEN: "secret-token",
      APP_URL: "https://aurora.example",
      OPENAI_API_KEY: "configured",
    }, fetchMock as unknown as typeof fetch);
    expect(result).toMatchObject({
      state: "healthy",
      botName: "Аврора",
      username: "aurora_bot",
      botId: "77",
      miniAppReady: true,
      voiceReady: true,
      voiceProvider: "openai",
      webhookClear: true,
      webhookGuarded: false,
      commandsReady: true,
      businessReady: true,
    });
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

describe("admin Telegram configuration repair", () => {
  it("restores the guarded command queue and menu without dropping updates", async () => {
    const query = vi.fn(async () => ({ rows: [], rowCount: 1 }));
    const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
      void _url;
      void _init;
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = await repairAdminTelegramConfiguration({ query } as never, {
      actorUserId: 7,
      env: { TG_BOT_TOKEN: "secret-token" },
      fetcher: fetchMock as unknown as typeof fetch,
    });
    expect(result).toEqual({ status: "repaired", queueGuardConfigured: true, commandsConfigured: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/setWebhook$/u);
    expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({
      url: expect.stringMatching(/^https:\/\/api\.telegram\.org\/aurora-polling-guard-/u),
      drop_pending_updates: false,
      max_connections: 1,
    });
    expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({ commands: TELEGRAM_BOT_COMMANDS });
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret-token");
  });

  it("recognizes the worker queue guard as a healthy receive mode", async () => {
    const token = "secret-token";
    const guardedUrl = telegramPollingGuardConfiguration(token).url;
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      const value = String(url);
      const result = value.endsWith("/getMe")
        ? { id: 77, first_name: "Аврора", username: "aurora_bot" }
        : value.endsWith("/getWebhookInfo")
          ? { url: guardedUrl, pending_update_count: 0 }
          : TELEGRAM_BOT_COMMANDS;
      return new Response(JSON.stringify({ ok: true, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(probeAdminTelegramBot({ TG_BOT_TOKEN: token }, fetchMock as unknown as typeof fetch))
      .resolves.toMatchObject({ webhookClear: false, webhookGuarded: true });
  });
});

describe("admin test delivery", () => {
  it("persists delivery and audit metadata without a message body", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("select app_user.tg_chat_id")) return { rows: [{ tg_chat_id: 123, enabled: true }] };
      return { rows: [], rowCount: 1 };
    });
    const fetcher = vi.fn().mockResolvedValue({ json: async () => ({ ok: true }) });
    const result = await sendAdminBotTest({ query } as never, {
      actorUserId: 1,
      targetUserId: 2,
      env: { TG_BOT_TOKEN: "secret" },
      fetcher,
    });
    expect(result).toEqual({ status: "delivered" });
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into bot_delivery_events"))).toBe(true);
    expect(query.mock.calls.some(([sql]) => sql.includes("insert into bot_admin_action_events"))).toBe(true);
    expect(JSON.stringify(query.mock.calls)).not.toContain("Тест Авроры");
    expect(JSON.stringify(query.mock.calls)).not.toContain("secret");
  });
});

describe("admin bot usage overview", () => {
  it("returns interaction totals, per-user activity and a privacy-safe recent journal", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("as linked_users")) return { rows: [{
        linked_users: "2", active_projects: "1", interactions: "9", active_users: "2",
        command_interactions: "3", button_interactions: "4", message_interactions: "2",
        last_interaction_at: "2026-08-18T10:00:00.000Z",
      }] };
      if (sql.includes("generate_series")) return { rows: [{
        day: "2026-08-18", drafts: "1", scheduled: "1", published: "0", failures: "0", interactions: "9",
      }] };
      if (sql.includes("from users app_user")) return { rows: [{
        id: "7", name: "Анна", linked: true, enabled: true, interactions: "6", commands: "2",
        buttons: "3", messages: "1", last_interaction_at: "2026-08-18T10:00:00.000Z",
      }] };
      if (sql.includes("from projects project")) return { rows: [{
        id: "4", name: "Проект", enabled: true, interactions: "6",
      }] };
      if (sql.includes("from bot_notification_preferences")) return { rows: [{}] };
      if (sql.includes("from bot_delivery_events event")) return { rows: [] };
      if (sql.includes("group by event.interaction_type")) return { rows: [{
        interaction_type: "command", action: "status", count: "3",
      }] };
      if (sql.includes("from bot_interaction_events event") && sql.includes("user_name")) return { rows: [{
        id: "12", interaction_type: "callback", action: "connection:status",
        user_name: "Анна", project_name: "Проект", created_at: "2026-08-18T10:00:00.000Z",
      }] };
      if (sql.includes("select * from (")) return { rows: [] };
      throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
    });

    const result = await loadAdminBotData({ query } as never, 7);
    expect(result.summary).toMatchObject({
      interactions: 9,
      activeUsers: 2,
      commandInteractions: 3,
      buttonInteractions: 4,
      messageInteractions: 2,
      lastInteractionAt: "2026-08-18T10:00:00.000Z",
    });
    expect(result.daily[0]).toMatchObject({ interactions: 9 });
    expect(result.users[0]).toMatchObject({ interactions: 6, commands: 2, buttons: 3, messages: 1 });
    expect(result.projects[0]).toMatchObject({ interactions: 6 });
    expect(result.topActions[0]).toEqual({ type: "command", action: "status", count: 3 });
    expect(result.interactions[0]).toEqual({
      id: 12,
      type: "callback",
      action: "connection:status",
      user: "Анна",
      project: "Проект",
      createdAt: "2026-08-18T10:00:00.000Z",
    });
    expect(JSON.stringify(result)).not.toContain("incoming_text");
  });
});
