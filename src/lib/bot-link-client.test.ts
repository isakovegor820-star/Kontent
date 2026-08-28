import { describe, expect, it } from "vitest";
import { parseBotLinkStatusResponse, requireBotUnlinkSuccess } from "./bot-link-client";

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
});
