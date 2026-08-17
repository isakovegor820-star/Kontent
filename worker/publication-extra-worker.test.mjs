import { describe, expect, it, vi } from "vitest";

import {
  captureTelegramAudienceComment,
  observeTelegramDiscussionUpdate,
  processPublicationExtraOperation,
  syncTelegramDiscussionChats,
} from "./publication-extra-worker.mjs";

const fingerprint = "a".repeat(64);

function operationRow(overrides = {}) {
  return {
    id: "5",
    project_id: "7",
    publication_operation_id: "11",
    post_id: "13",
    channel_id: "17",
    kind: "first_comment",
    fingerprint,
    request_snapshot: { providerId: "vk", text: "Первый комментарий" },
    provider_started_at: null,
    external_message_id: "44",
    tg_message_id: null,
    vk_post_id: "44",
    network: "vk",
    channel_user_id: "3",
    tg_chat_id: null,
    vk_group_id: "99",
    vk_token: "encrypted",
    ...overrides,
  };
}

function operationPool(row, extra = {}) {
  const query = vi.fn(async (sql, values) => {
    if (sql.includes("update publication_extra_operations extra")) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (sql.includes("set provider_started_at")) return { rows: [], rowCount: 1 };
    if (sql.includes("set status = 'succeeded'")) return { rows: [], rowCount: 1 };
    if (sql.includes("select extra.id")) return { rows: [] };
    if (sql.includes("insert into audit_events")) return { rows: [] };
    if (sql.includes("update publication_extra_outbox")) return { rows: [], rowCount: 1 };
    if (sql.includes("set status = $4")) return { rows: [], rowCount: 1 };
    if (extra.query) return extra.query(sql, values);
    throw new Error(`unexpected query: ${sql}`);
  });
  return { query };
}

describe("publication extra worker", () => {
  it("publishes a VK first comment with deterministic guid and never duplicates a succeeded replay", async () => {
    const pool = operationPool(operationRow());
    const vkRequest = vi.fn(async () => ({ response: { comment_id: 55 } }));
    const result = await processPublicationExtraOperation({
      pool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest: vi.fn(),
      vkRequest,
      decryptToken: vi.fn(() => "token"),
      finalAttempt: false,
    });
    expect(result).toMatchObject({ ok: true, externalId: "55" });
    expect(vkRequest).toHaveBeenCalledWith(
      "wall.createComment",
      expect.objectContaining({ owner_id: -99, post_id: 44, message: "Первый комментарий", guid: expect.any(Number) }),
      "token",
    );

    const replayPool = operationPool(null, {
      query: (sql) => {
        if (sql.includes("select status, external_id")) return { rows: [{ status: "succeeded", external_id: "55" }] };
        throw new Error(`unexpected query: ${sql}`);
      },
    });
    const replayRequest = vi.fn();
    await expect(processPublicationExtraOperation({
      pool: replayPool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest: replayRequest,
      vkRequest: replayRequest,
      decryptToken: vi.fn(),
    })).resolves.toMatchObject({ ok: true, replayed: true, externalId: "55" });
    expect(replayRequest).not.toHaveBeenCalled();
  });

  it("enforces Telegram first comment as a reply to the observed discussion copy", async () => {
    const row = operationRow({
      kind: "first_comment",
      request_snapshot: { providerId: "tg", text: "Материалы — по ссылке" },
      network: "tg",
      external_message_id: "66",
      tg_message_id: "66",
      vk_post_id: null,
      tg_chat_id: "-100900",
    });
    const pool = operationPool(row, {
      query: (sql) => {
        if (sql.includes("from telegram_discussion_messages")) {
          return { rows: [{ discussion_chat_id: "-100800", discussion_message_id: "70" }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
    });
    const telegramRequest = vi.fn(async () => ({ ok: true, result: { message_id: 71 } }));
    await expect(processPublicationExtraOperation({
      pool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest,
      vkRequest: vi.fn(),
      decryptToken: vi.fn(),
    })).resolves.toMatchObject({ ok: true, externalId: "71" });
    expect(telegramRequest).toHaveBeenCalledWith("sendMessage", {
      chat_id: -100800,
      text: "Материалы — по ссылке",
      disable_web_page_preview: true,
      reply_parameters: { message_id: 70 },
    });
  });

  it("does not repeat an ambiguous Telegram comment provider call", async () => {
    const row = operationRow({
      request_snapshot: { providerId: "tg", text: "Комментарий" },
      provider_started_at: "2026-08-11T10:00:00.000Z",
      network: "tg",
    });
    const pool = operationPool(row);
    const telegramRequest = vi.fn();
    await expect(processPublicationExtraOperation({
      pool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest,
      vkRequest: vi.fn(),
      decryptToken: vi.fn(),
    })).rejects.toMatchObject({ code: "telegram_comment_delivery_unknown" });
    expect(telegramRequest).not.toHaveBeenCalled();
  });

  it("successfully closes VK comments without changing the published post state", async () => {
    const pool = operationPool(operationRow({
      kind: "configure_comments",
      request_snapshot: { providerId: "vk", commentsEnabled: false },
    }));
    const vkRequest = vi.fn(async () => ({ response: 1 }));
    await expect(processPublicationExtraOperation({
      pool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest: vi.fn(),
      vkRequest,
      decryptToken: vi.fn(() => "token"),
    })).resolves.toMatchObject({ ok: true, externalId: "44" });
    expect(vkRequest).toHaveBeenCalledWith(
      "wall.closeComments",
      { owner_id: -99, post_id: 44 },
      "token",
    );
    expect(pool.query.mock.calls.some(([sql]) => String(sql).includes("update posts"))).toBe(false);
    expect(String(pool.query.mock.calls[0]?.[0])).toContain("'pending','queued','failed_retry'");
  });

  it.each([
    ["pin", "pinChatMessage"],
    ["unpin", "unpinChatMessage"],
  ])("successfully performs Telegram %s once", async (kind, method) => {
    const pool = operationPool(operationRow({
      kind,
      request_snapshot: { providerId: "tg", pinned: kind === "pin" },
      network: "tg",
      external_message_id: "66",
      tg_message_id: "66",
      vk_post_id: null,
      tg_chat_id: "-100900",
    }));
    const telegramRequest = vi.fn(async () => ({ ok: true, result: true }));
    await expect(processPublicationExtraOperation({
      pool,
      operationId: 5,
      projectId: 7,
      fingerprint,
      telegramRequest,
      vkRequest: vi.fn(),
      decryptToken: vi.fn(),
    })).resolves.toMatchObject({ ok: true, externalId: "66" });
    expect(telegramRequest).toHaveBeenCalledOnce();
    expect(telegramRequest).toHaveBeenCalledWith(method, {
      chat_id: "-100900",
      message_id: 66,
      disable_notification: true,
    });
  });

  it("observes automatic-forward updates without requiring message text", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("from channels")) return { rows: [{ id: "17", project_id: "7" }] };
      if (sql.includes("from posts post")) return { rows: [{ id: "13" }] };
      if (sql.includes("update channels")) return { rows: [] };
      if (sql.includes("insert into telegram_discussion_messages")) return { rows: [] };
      if (sql.includes("update publication_extra_operations")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await observeTelegramDiscussionUpdate({ query }, {
      message: {
        message_id: 70,
        is_automatic_forward: true,
        chat: { id: -100800 },
        forward_origin: { type: "channel", chat: { id: -100900 }, message_id: 66 },
      },
    });
    expect(result).toEqual({ observed: true, postId: 13 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("tg_chat_id = $1"), [-100900]);
    const postLookup = query.mock.calls.find(([sql]) => String(sql).includes("from posts post"));
    expect(String(postLookup?.[0])).toContain("post.tg_message_id::text = $3::text");
    expect(String(postLookup?.[0])).toContain("post.external_message_id = $3::text");
    expect(postLookup?.[1]).toEqual(["7", "17", 66]);
  });

  it("discovers the discussion mapping from the first user comment reply", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("from channels")) return { rows: [{ id: "17", project_id: "7" }] };
      if (sql.includes("from posts post")) return { rows: [{ id: "13" }] };
      if (sql.includes("update channels")) return { rows: [] };
      if (sql.includes("insert into telegram_discussion_messages")) return { rows: [] };
      if (sql.includes("update publication_extra_operations")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await observeTelegramDiscussionUpdate({ query }, {
      message: {
        message_id: 71,
        text: "А можно подробнее?",
        chat: { id: -100800, type: "supergroup" },
        reply_to_message: {
          message_id: 70,
          is_automatic_forward: true,
          forward_origin: { type: "channel", chat: { id: -100900 }, message_id: 66 },
        },
      },
    });
    expect(result).toEqual({ observed: true, postId: 13 });
    const mappingInsert = query.mock.calls.find(([sql]) => String(sql).includes("insert into telegram_discussion_messages"));
    expect(mappingInsert?.[1]).toEqual(["7", "17", "13", -100900, 66, -100800, 70]);
  });

  it("captures a mapped user comment in the audience inbox and notifies project editors", async () => {
    const query = vi.fn(async (sql, values) => {
      if (sql.includes("from telegram_discussion_messages mapping")) {
        expect(values).toEqual([-100800, [70]]);
        return {
          rows: [{
            project_id: "7",
            channel_id: "17",
            origin_message_id: "66",
            title: "ТехнологИИ Права",
            handle: "TexPravoAI",
          }],
        };
      }
      if (sql.includes("insert into bot_client_inquiries")) return { rows: [{ id: "91" }] };
      if (sql.includes("insert into project_notifications")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await captureTelegramAudienceComment({ query }, {
      message: {
        message_id: 71,
        text: "А можно подробнее?",
        chat: { id: -100800, type: "supergroup" },
        from: { id: 8001, first_name: "Анна", username: "anna" },
        reply_to_message: { message_id: 70 },
      },
    });
    expect(result).toEqual({ captured: true, inquiryId: 91 });
    const inboxInsert = query.mock.calls.find(([sql]) => String(sql).includes("insert into bot_client_inquiries"));
    expect(inboxInsert?.[1]).toEqual([
      "7",
      "telegram-comment:-100800:71",
      "Telegram · ТехнологИИ Права",
      "https://t.me/TexPravoAI/66?comment=71",
      "Анна",
      "А можно подробнее?",
      "Комментарий к публикации в канале «ТехнологИИ Права».",
      -100800,
      71,
      8001,
    ]);
    const notificationInsert = query.mock.calls.find(([sql]) => String(sql).includes("insert into project_notifications"));
    expect(String(notificationInsert?.[0])).toContain("'audience_comment_received'");
    expect(String(notificationInsert?.[0])).not.toContain("А можно подробнее");
  });

  it("keeps unrelated group messages and Telegram service forwards out of the audience inbox", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    await expect(captureTelegramAudienceComment({ query }, {
      message: {
        message_id: 70,
        is_automatic_forward: true,
        chat: { id: -100800, type: "supergroup" },
        text: "Опубликованный пост",
      },
    })).resolves.toEqual({ captured: false });
    await expect(captureTelegramAudienceComment({ query }, {
      message: {
        message_id: 71,
        chat: { id: -100800, type: "supergroup" },
        from: { is_bot: true },
        text: "Служебное сообщение",
        reply_to_message: { message_id: 70 },
      },
    })).resolves.toEqual({ captured: false });
    expect(query).not.toHaveBeenCalled();
  });

  it("synchronizes linked discussion groups from Telegram channel metadata", async () => {
    const query = vi.fn(async (sql) => {
      if (sql.includes("select id, project_id, tg_chat_id")) {
        return { rows: [{ id: "17", project_id: "7", tg_chat_id: "-100900" }] };
      }
      if (sql.includes("update channels")) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected query: ${sql}`);
    });
    const telegramRequest = vi.fn(async () => ({
      ok: true,
      result: { id: -100900, linked_chat_id: -100800 },
    }));
    await expect(syncTelegramDiscussionChats({ query }, telegramRequest))
      .resolves.toEqual({ synchronized: 1, total: 1 });
    expect(telegramRequest).toHaveBeenCalledWith("getChat", { chat_id: -100900 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("tg_discussion_chat_id = $2"), ["17", -100800, "7"]);
  });

  it("captures an ordinary message from a linked Telegram discussion group", async () => {
    const query = vi.fn(async (sql, values) => {
      if (sql.includes("channel.tg_discussion_chat_id = $1")) {
        expect(values).toEqual([-100800]);
        return {
          rows: [{
            project_id: "7",
            channel_id: "17",
            origin_message_id: null,
            title: "ТехнологИИ Права",
            handle: "TexPravoAI",
          }],
        };
      }
      if (sql.includes("insert into bot_client_inquiries")) return { rows: [{ id: "92" }] };
      if (sql.includes("insert into project_notifications")) return { rows: [] };
      throw new Error(`unexpected query: ${sql}`);
    });
    const result = await captureTelegramAudienceComment({ query }, {
      message: {
        message_id: 81,
        text: "Подскажите, с чего начать?",
        chat: { id: -100800, type: "supergroup" },
        from: { id: 8002, first_name: "Егор" },
      },
    });
    expect(result).toEqual({ captured: true, inquiryId: 92 });
    const insert = query.mock.calls.find(([sql]) => String(sql).includes("insert into bot_client_inquiries"));
    expect(insert?.[1]).toEqual([
      "7",
      "telegram-comment:-100800:81",
      "Telegram · ТехнологИИ Права",
      "https://t.me/c/800/81",
      "Егор",
      "Подскажите, с чего начать?",
      "Сообщение в группе обсуждений канала «ТехнологИИ Права».",
      -100800,
      81,
      8002,
    ]);
  });
});
