import { describe, expect, it, vi } from "vitest";

import { probeAdminTelegramBot, sendAdminBotTest } from "./admin-bot";

describe("admin Telegram runtime probe", () => {
  it("reports missing configuration without making a network request", async () => {
    const fetcher = vi.fn();
    await expect(probeAdminTelegramBot({}, fetcher)).resolves.toMatchObject({
      state: "not_configured",
      configured: false,
      miniAppReady: false,
      voiceReady: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns only safe bot identity fields", async () => {
    const fetcher = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ ok: true, result: { id: 77, first_name: "Аврора", username: "aurora_bot" } }),
    });
    const result = await probeAdminTelegramBot({
      TG_BOT_TOKEN: "secret-token",
      APP_URL: "https://aurora.example",
      OPENAI_API_KEY: "configured",
    }, fetcher);
    expect(result).toMatchObject({ state: "healthy", botName: "Аврора", username: "aurora_bot", botId: "77", miniAppReady: true, voiceReady: true });
    expect(JSON.stringify(result)).not.toContain("secret-token");
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
