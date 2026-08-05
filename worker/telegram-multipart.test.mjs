import { describe, expect, it, vi } from "vitest";

import { deliverTelegramParts, telegramPartDefinitions } from "./telegram-multipart.mjs";

function harness(parts, responses) {
  const mutable = parts.map((part) => ({ ...part }));
  const sendText = vi.fn(async () => responses.shift());
  const sendAsset = vi.fn(async () => responses.shift());
  return {
    mutable,
    sendText,
    sendAsset,
    input: {
      parts: mutable,
      formatted: "x".repeat(901),
      asset: { kind: "image" },
      sendText,
      sendAsset,
      markSending: async (part) => { part.send_status = "sending"; },
      markSent: async (part, externalMessageId) => {
        part.send_status = "sent";
        part.external_message_id = externalMessageId;
        return { ...part };
      },
      markFailed: async (part) => { part.send_status = "failed"; },
      markUnknown: async (part) => { part.send_status = "unknown"; },
    },
  };
}

describe("Telegram multipart delivery", () => {
  it("plans one caption within Telegram's safe limit and two ordered parts above it", () => {
    expect(telegramPartDefinitions({ hasAsset: true, formattedLength: 900 })).toEqual([
      { index: 0, type: "media_caption" },
    ]);
    expect(telegramPartDefinitions({ hasAsset: true, formattedLength: 901 })).toEqual([
      { index: 0, type: "media" },
      { index: 1, type: "text" },
    ]);
    expect(telegramPartDefinitions({ hasAsset: false, formattedLength: 10 })).toEqual([
      { index: 0, type: "text" },
    ]);
  });

  it("persists partial success and retries only the missing second part", async () => {
    const first = harness(
      telegramPartDefinitions({ hasAsset: true, formattedLength: 901 }).map((part) => ({
        part_index: part.index,
        part_type: part.type,
        send_status: "pending",
        external_message_id: null,
      })),
      [
        { ok: true, result: { message_id: 101 } },
        { ok: false, error_code: 429, description: "slow down", parameters: { retry_after: 17 } },
      ],
    );
    const partial = await deliverTelegramParts(first.input);
    expect(partial).toMatchObject({ ok: false, retryAfterSeconds: 17, deliveryUnknown: false });
    expect(first.mutable.map((part) => [part.send_status, part.external_message_id])).toEqual([
      ["sent", "101"],
      ["failed", null],
    ]);
    expect(first.sendAsset).toHaveBeenCalledTimes(1);
    expect(first.sendText).toHaveBeenCalledTimes(1);

    const retry = harness(first.mutable, [{ ok: true, result: { message_id: 102 } }]);
    const complete = await deliverTelegramParts(retry.input);
    expect(complete).toMatchObject({ ok: true, externalId: 101 });
    expect(complete.parts.map((part) => part.external_message_id)).toEqual(["101", "102"]);
    expect(retry.sendAsset).not.toHaveBeenCalled();
    expect(retry.sendText).toHaveBeenCalledTimes(1);
  });

  it("marks a thrown transport result unknown and forbids automatic continuation", async () => {
    const attempt = harness(
      [{ part_index: 0, part_type: "text", send_status: "pending", external_message_id: null }],
      [],
    );
    attempt.sendText.mockRejectedValueOnce(new Error("timeout after send"));
    await expect(deliverTelegramParts(attempt.input)).resolves.toMatchObject({
      ok: false,
      deliveryUnknown: true,
      parts: [],
    });
    expect(attempt.mutable[0].send_status).toBe("unknown");
  });
});
