import { describe, expect, it, vi } from "vitest";
import {
  parseBotLinkStatusResponse,
  requestTelegramChannelConnection,
  requireBotUnlinkSuccess,
  telegramChannelConnectionSnapshot,
} from "./bot-link-client";

describe("bot link client responses", () => {
  it("accepts only a successful, explicit link status", async () => {
    await expect(
      parseBotLinkStatusResponse(
        Response.json({
          linked: true,
          bot: "aurora_bot",
          channelConnectUrl: "https://t.me/aurora_bot?startchannel&admin=post_messages",
          botStatus: "up",
        }, { status: 200 }),
      ),
    ).resolves.toEqual({
      linked: true,
      bot: "aurora_bot",
      channelConnectUrl: "https://t.me/aurora_bot?startchannel&admin=post_messages",
      botStatus: "up",
    });
    await expect(
      parseBotLinkStatusResponse(
        Response.json({ linked: true, bot: "aurora_bot", botStatus: "conflict" }, { status: 200 }),
      ),
    ).resolves.toEqual({
      linked: true,
      bot: "aurora_bot",
      channelConnectUrl: null,
      botStatus: "conflict",
    });

    await expect(
      parseBotLinkStatusResponse(Response.json({ error: "server" }, { status: 500 })),
    ).rejects.toThrow("bot_link_status_unavailable");
    await expect(
      parseBotLinkStatusResponse(Response.json({ linked: false }, { status: 500 })),
    ).rejects.toThrow("bot_link_status_unavailable");
    await expect(
      parseBotLinkStatusResponse(Response.json({ linked: "false" }, { status: 200 })),
    ).rejects.toThrow("bot_link_status_unavailable");
    await expect(
      parseBotLinkStatusResponse(Response.json({ linked: true, bot: "aurora_bot", botStatus: "unknown" })),
    ).rejects.toThrow("bot_link_status_invalid");
  });

  it("confirms unlinking only from an HTTP success with ok true", async () => {
    await expect(requireBotUnlinkSuccess(Response.json({ ok: true }))).resolves.toBeUndefined();
    await expect(
      requireBotUnlinkSuccess(Response.json({ ok: false, error: "server" }, { status: 500 })),
    ).rejects.toThrow("bot_unlink_failed");
    await expect(
      requireBotUnlinkSuccess(Response.json({ ok: false }, { status: 200 })),
    ).rejects.toThrow("bot_unlink_failed");
  });

  it("opens the native picker immediately for an already linked account", async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({
      linked: true,
      bot: "aurora_bot",
      channelConnectUrl: "https://t.me/aurora_bot?startchannel&admin=post_messages",
      botStatus: "up",
    }));

    await expect(requestTelegramChannelConnection(fetcher)).resolves.toEqual({
      url: "https://t.me/aurora_bot?startchannel&admin=post_messages",
      bot: "aurora_bot",
      linkingAccount: false,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("requests a channel-intent start link when the private chat is not linked", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({
        linked: false,
        bot: "aurora_bot",
        channelConnectUrl: "https://t.me/aurora_bot?startchannel&admin=post_messages",
        botStatus: "up",
      }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        url: "https://t.me/aurora_bot?start=code_channel",
      }));

    await expect(requestTelegramChannelConnection(fetcher)).resolves.toMatchObject({
      url: "https://t.me/aurora_bot?start=code_channel",
      linkingAccount: true,
    });
    expect(fetcher.mock.calls[1]).toEqual([
      "/api/bot/link",
      expect.objectContaining({ body: JSON.stringify({ intent: "channel" }) }),
    ]);
  });

  it("detects both a new channel and a verified reconnect", () => {
    const before = telegramChannelConnectionSnapshot([{
      id: 7,
      network: "tg",
      is_active: false,
      status: "revoked",
      updated_at: "2026-08-28T10:00:00.000Z",
    }]);
    const after = telegramChannelConnectionSnapshot([{
      id: 7,
      network: "tg",
      is_active: true,
      status: "active",
      updated_at: "2026-08-28T10:01:00.000Z",
    }]);
    expect(after).not.toBe(before);
    expect(telegramChannelConnectionSnapshot([{
      id: 9,
      network: "vk",
      is_active: true,
      status: "active",
      updated_at: "2026-08-28T10:01:00.000Z",
    }])).toBe("");
  });
});
