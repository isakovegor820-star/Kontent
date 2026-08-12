import { describe, expect, it, vi } from "vitest";

import {
  observeTelegramDiscussionUpdate,
  processPublicationExtraOperation,
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
});
