import { describe, expect, it, vi } from "vitest";

import {
  botCallbackInteraction,
  botMessageInteraction,
  recordBotInteraction,
} from "./bot-interaction.mjs";

describe("Telegram bot interaction telemetry", () => {
  it("classifies messages without retaining user text", () => {
    expect(botMessageInteraction({ command: "status" })).toEqual({ type: "command", action: "status" });
    expect(botMessageInteraction({ replyAction: "create" })).toEqual({ type: "reply_button", action: "create" });
    expect(botMessageInteraction({ hasVoice: true })).toEqual({ type: "voice", action: "voice_message" });
    expect(botMessageInteraction({ hasAttachment: true })).toEqual({ type: "attachment", action: "media_attachment" });
    expect(JSON.stringify(botMessageInteraction({ text: "секретный текст клиента" }))).not.toContain("секретный");
  });

  it("drops callback ids and one-time tokens", () => {
    const interaction = botCallbackInteraction("connection:project:42:single-use-token");
    expect(interaction).toEqual({ type: "callback", action: "connection:project" });
    expect(JSON.stringify(interaction)).not.toContain("42");
    expect(JSON.stringify(interaction)).not.toContain("single-use-token");
  });

  it("stores one idempotent metadata row without a message body", async () => {
    const query = vi.fn().mockResolvedValue({ rowCount: 1, rows: [] });
    await expect(recordBotInteraction({ query }, {
      telegramUpdateId: 101,
      userId: 7,
      type: "command",
      action: "projects",
      text: "не должно сохраниться",
    })).resolves.toBe(true);
    expect(query).toHaveBeenCalledOnce();
    expect(query.mock.calls[0][0]).toContain("on conflict (telegram_update_id) do nothing");
    expect(query.mock.calls[0][1]).toEqual([101, 7, "command", "projects"]);
    expect(JSON.stringify(query.mock.calls)).not.toContain("не должно сохраниться");
  });

  it("rejects malformed updates before querying the database", async () => {
    const query = vi.fn();
    await expect(recordBotInteraction({ query }, {
      telegramUpdateId: -1,
      type: "message",
      action: "free_text",
    })).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });
});
