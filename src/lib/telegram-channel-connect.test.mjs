import { describe, expect, it, vi } from "vitest";

import {
  markTelegramChannelUnavailable,
  saveVerifiedTelegramChannel,
  telegramChannelAdminUrl,
  telegramChannelMembershipChange,
} from "./telegram-channel-connect.mjs";

function transactionPool(handler) {
  const query = vi.fn(handler);
  const release = vi.fn();
  return { pool: { connect: vi.fn(async () => ({ query, release })) }, query, release };
}

describe("Telegram native channel connection", () => {
  it("builds the official channel picker link with the minimum publish permission", () => {
    expect(telegramChannelAdminUrl("@Aurora_bot"))
      .toBe("https://t.me/Aurora_bot?startchannel&admin=post_messages");
    expect(telegramChannelAdminUrl("https://t.me/Aurora_bot")).toBeNull();
  });

  it("recognizes publish-ready, revoked and insufficient-rights channel updates", () => {
    const base = { chat: { id: -1001, type: "channel" } };
    expect(telegramChannelMembershipChange({
      my_chat_member: { ...base, new_chat_member: { status: "administrator", can_post_messages: true } },
    }).state).toBe("ready");
    expect(telegramChannelMembershipChange({
      my_chat_member: { ...base, new_chat_member: { status: "administrator", can_post_messages: false } },
    }).state).toBe("permission_lost");
    expect(telegramChannelMembershipChange({
      my_chat_member: { ...base, new_chat_member: { status: "kicked" } },
    }).state).toBe("revoked");
    expect(telegramChannelMembershipChange({
      my_chat_member: { chat: { id: -1002, type: "group" }, new_chat_member: { status: "administrator" } },
    }).state).toBe("ignored");
  });

  it("connects a verified channel and records the Telegram update idempotently", async () => {
    const tx = transactionPool(async (sql) => {
      const text = String(sql);
      if (text.includes("select member.role")) return { rows: [{ role: "owner" }] };
      if (text.includes("project_id <>")) return { rows: [] };
      if (text.includes("order by is_active")) return { rows: [] };
      if (text.includes("insert into channels")) return { rows: [{ id: 41 }] };
      return { rows: [], rowCount: 1 };
    });

    await expect(saveVerifiedTelegramChannel(tx.pool, {
      userId: 7,
      projectId: 12,
      chat: { id: -1001, title: "Команда", username: "team" },
      requestId: "telegram-my-chat-member:99",
    })).resolves.toMatchObject({ state: "connected", channelId: 41, projectId: 12 });

    const insert = tx.query.mock.calls.find(([sql]) => String(sql).includes("insert into channels"));
    expect(insert?.[1]).toEqual([12, 7, -1001, "Команда", "team", null]);
    const event = tx.query.mock.calls.find(([sql]) => String(sql).includes("insert into channel_events"));
    expect(event?.[1]).toContain("telegram-my-chat-member:99");
    expect(tx.release).toHaveBeenCalledOnce();
  });

  it("does not move a channel that is active in another project", async () => {
    const tx = transactionPool(async (sql) => {
      const text = String(sql);
      if (text.includes("select member.role")) return { rows: [{ role: "owner" }] };
      if (text.includes("project_id <>")) return { rows: [{ id: 9, project_id: 3 }] };
      return { rows: [] };
    });
    await expect(saveVerifiedTelegramChannel(tx.pool, {
      userId: 7,
      projectId: 12,
      chat: { id: -1001, title: "Команда" },
    })).resolves.toEqual({ state: "taken" });
    expect(tx.query.mock.calls.some(([sql]) => String(sql).includes("insert into channels"))).toBe(false);
  });

  it("marks a connected channel unavailable when Telegram removes the permission", async () => {
    const tx = transactionPool(async (sql) => {
      if (String(sql).includes("from channels") && String(sql).includes("is_active = true")) {
        return { rows: [{ id: 41, status: "active" }] };
      }
      return { rows: [], rowCount: 1 };
    });
    await expect(markTelegramChannelUnavailable(tx.pool, {
      chatId: -1001,
      status: "permission_lost",
      actorUserId: 7,
      requestId: "telegram-my-chat-member:100",
    })).resolves.toMatchObject({
      state: "permission_lost",
      channelId: 41,
      errorCode: "telegram_publish_permission_lost",
    });
  });
});
