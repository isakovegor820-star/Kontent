import { describe, expect, it, vi } from "vitest";

import {
  BOT_CONNECTION_TOKEN_PATTERN,
  confirmBotConnectionSession,
  createBotConnectionSession,
  createLegacyBotLink,
  consumeLegacyBotLink,
  hashBotConnectionToken,
  inspectBotConnectionSession,
  maskBotAccountEmail,
  normalizeTelegramBotUsername,
  parseLegacyBotStartPayload,
} from "./bot-connection.mjs";

const NOW = Date.parse("2026-08-18T12:00:00.000Z");
const FUTURE = "2026-08-18T12:15:00.000Z";

describe("Telegram initiated connection tokens", () => {
  it("creates a 256-bit URL-safe secret and persists only its digest", async () => {
    const queries = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        if (String(sql).includes("returning expires_at")) return { rows: [{ expires_at: FUTURE }] };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };
    const result = await createBotConnectionSession({ connect: async () => client }, {
      telegramUserId: 123,
      telegramChatId: 123,
      username: "aurora_user",
      displayName: "Анна Иванова",
    });

    expect(result.token).toMatch(BOT_CONNECTION_TOKEN_PATTERN);
    const insert = queries.find((entry) => entry.sql.includes("insert into bot_connection_sessions"));
    expect(insert.params[0]).toBe(hashBotConnectionToken(result.token));
    expect(insert.params).not.toContain(result.token);
    expect(queries.at(-1).sql).toBe("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rejects malformed tokens before querying the database", async () => {
    const query = vi.fn();
    await expect(inspectBotConnectionSession({ query }, { token: "short" })).resolves.toEqual({ state: "invalid" });
    expect(query).not.toHaveBeenCalled();
  });

  it("reports both kinds of connection move before confirmation", async () => {
    const token = "a".repeat(43);
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        token_hash: hashBotConnectionToken(token),
        telegram_user_id: "123",
        telegram_chat_id: "123",
        telegram_username: "anna",
        telegram_display_name: "Анна",
        expires_at: FUTURE,
        used_at: null,
        revoked_at: null,
        confirmed_user_id: null,
      }] })
      .mockResolvedValueOnce({ rows: [{
        tg_chat_id: "999",
        enabled: true,
        chat_linked_to_another_account: true,
      }] });

    const result = await inspectBotConnectionSession({ query }, { token, userId: 7, nowMs: NOW });
    expect(result).toMatchObject({
      state: "pending",
      moveRequired: true,
      chatLinkedToAnotherAccount: true,
      accountLinkedToAnotherChat: true,
    });
  });

  it("does not replace an existing chat until the move is explicitly confirmed", async () => {
    const token = "b".repeat(43);
    const queries = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text.includes("from bot_connection_sessions") && text.includes("for update")) {
          return { rows: [{
            telegram_chat_id: "123",
            expires_at: FUTURE,
            used_at: null,
            revoked_at: null,
            confirmed_user_id: null,
          }] };
        }
        if (text.includes("from users app_user")) {
          return { rows: [{ id: "7", tg_chat_id: "999", enabled: true }] };
        }
        if (text.includes("select id from users")) return { rows: [{ id: "8" }] };
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const result = await confirmBotConnectionSession({ connect: async () => client }, {
      token,
      userId: 7,
      nowMs: NOW,
    });
    expect(result).toMatchObject({ state: "move_required" });
    expect(queries.some((entry) => entry.sql.includes("set tg_chat_id = case"))).toBe(false);
    expect(queries.at(-1).sql).toBe("rollback");
  });
});

describe("Telegram account labels", () => {
  it("masks the local part while leaving a recognizable account", () => {
    expect(maskBotAccountEmail("egor@example.com")).toBe("eg***@example.com");
    expect(maskBotAccountEmail("a@example.com")).toBe("a@example.com");
    expect(maskBotAccountEmail("not-an-email")).toBe("аккаунт Авроры");
  });

  it("accepts only Telegram-compatible bot usernames", () => {
    expect(normalizeTelegramBotUsername("@Aurora_bot")).toBe("Aurora_bot");
    expect(normalizeTelegramBotUsername("https://t.me/aurora_bot")).toBeNull();
    expect(normalizeTelegramBotUsername("bot")).toBeNull();
  });
});

describe("legacy Telegram connection links", () => {
  it("keeps the channel intent separate from the one-time secret", () => {
    const code = "a".repeat(32);
    expect(parseLegacyBotStartPayload(`${code}_channel`)).toEqual({ code, intent: "channel" });
    expect(parseLegacyBotStartPayload(code)).toEqual({ code, intent: null });
    expect(parseLegacyBotStartPayload("unexpected")).toEqual({ code: "unexpected", intent: null });
  });

  it("replaces an old link and creates the new link in one transaction", async () => {
    const queries = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        queries.push({ sql: String(sql), params });
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const link = await createLegacyBotLink({ connect: async () => client }, { userId: 7 });

    expect(link.code).toMatch(/^[a-f0-9]{32}$/u);
    expect(queries.map((entry) => entry.sql.trim())).toEqual(expect.arrayContaining([
      "begin",
      "commit",
    ]));
    expect(queries.find((entry) => entry.sql.includes("insert into bot_links")).params)
      .toEqual([link.code, 7, 15]);
    expect(queries.at(-1).sql).toBe("commit");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("rolls back link replacement when the new link cannot be stored", async () => {
    const queries = [];
    const client = {
      query: vi.fn(async (sql) => {
        const text = String(sql);
        queries.push(text);
        if (text.includes("insert into bot_links")) throw new Error("database unavailable");
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    await expect(createLegacyBotLink({ connect: async () => client }, { userId: 7 }))
      .rejects.toThrow("database unavailable");
    expect(queries.at(-1)).toBe("rollback");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("does not consume a link while bot access is disabled", async () => {
    const code = "b".repeat(32);
    const queries = [];
    const client = {
      query: vi.fn(async (sql) => {
        const text = String(sql);
        queries.push(text);
        if (text.includes("select user_id from bot_links")) return { rows: [{ user_id: "7" }] };
        if (text.includes("from users app_user")) {
          return { rows: [{ id: "7", tg_chat_id: null, enabled: false }] };
        }
        return { rows: [], rowCount: 0 };
      }),
      release: vi.fn(),
    };

    const result = await consumeLegacyBotLink({ connect: async () => client }, {
      code,
      telegramChatId: 123,
    });

    expect(result).toEqual({ state: "account_disabled" });
    expect(queries.at(-1)).toBe("rollback");
    expect(queries.some((sql) => sql.includes("update bot_links set used_at"))).toBe(false);
  });

  it("moves the chat and consumes the link in the same transaction", async () => {
    const code = "c".repeat(32);
    const queries = [];
    const client = {
      query: vi.fn(async (sql, params) => {
        const text = String(sql);
        queries.push({ sql: text, params });
        if (text.includes("select user_id from bot_links")) return { rows: [{ user_id: "7" }] };
        if (text.includes("from users app_user")) {
          return { rows: [{ id: "7", tg_chat_id: "999", enabled: true }] };
        }
        if (text.includes("select id from users")) return { rows: [{ id: "8" }] };
        return { rows: [], rowCount: text.startsWith("update") ? 1 : 0 };
      }),
      release: vi.fn(),
    };

    const result = await consumeLegacyBotLink({ connect: async () => client }, {
      code,
      telegramChatId: 123,
    });

    expect(result).toEqual({
      state: "connected",
      userId: 7,
      telegramChatId: 123,
      moved: true,
    });
    const accountUpdate = queries.find((entry) => entry.sql.includes("set tg_chat_id = case"));
    const linkUpdate = queries.find((entry) => entry.sql.includes("update bot_links set used_at"));
    expect(accountUpdate.params).toEqual([7, 123]);
    expect(linkUpdate.params).toEqual([code]);
    expect(queries.at(-1).sql).toBe("commit");
  });
});
