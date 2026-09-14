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
  it("plans a caption up to 1024 and deterministic text chunks above it", () => {
    expect(telegramPartDefinitions({ hasAsset: true, text: "x".repeat(1024) })).toEqual([
      expect.objectContaining({ index: 0, type: "media_caption", entityLength: 1024 }),
    ]);
    expect(telegramPartDefinitions({ hasAsset: true, text: "x".repeat(4097) })).toEqual([
      expect.objectContaining({ index: 0, type: "media" }),
      expect.objectContaining({ index: 1, type: "text", entityLength: 4096 }),
      expect.objectContaining({ index: 2, type: "text", entityLength: 1 }),
    ]);
    expect(telegramPartDefinitions({ hasAsset: false, text: "text" })).toEqual([
      expect.objectContaining({ index: 0, type: "text", entityLength: 4 }),
    ]);
  });

  it("persists partial success and retries only the missing second part", async () => {
    const first = harness(
      telegramPartDefinitions({ hasAsset: true, text: "x".repeat(1025) }).map((part) => ({
        part_index: part.index,
        part_type: part.type,
        payload_html: part.payloadHtml,
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
      [{
        part_index: 0,
        part_type: "text",
        payload_html: "message",
        send_status: "pending",
        external_message_id: null,
      }],
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

  it("does not resend an unknown second part or an already sent first part", async () => {
    const attempt = harness([
      {
        part_index: 0,
        part_type: "text",
        payload_html: "first",
        send_status: "sent",
        external_message_id: "201",
      },
      {
        part_index: 1,
        part_type: "text",
        payload_html: "second",
        send_status: "unknown",
        external_message_id: null,
      },
    ], []);
    await expect(deliverTelegramParts(attempt.input)).resolves.toMatchObject({
      ok: false,
      deliveryUnknown: true,
      parts: [expect.objectContaining({ external_message_id: "201" })],
    });
    expect(attempt.sendText).not.toHaveBeenCalled();
  });

  it("rejects an oversized persisted part before any provider call", async () => {
    const attempt = harness([{
      part_index: 0,
      part_type: "text",
      payload_html: "x".repeat(4097),
      send_status: "pending",
      external_message_id: null,
    }], []);
    await expect(deliverTelegramParts(attempt.input)).resolves.toMatchObject({
      ok: false,
      deliveryUnknown: false,
      reason: "telegram_payload_invalid",
    });
    expect(attempt.sendText).not.toHaveBeenCalled();
    expect(attempt.mutable[0].send_status).toBe("failed");
  });
});
