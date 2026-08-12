import { describe, expect, it, vi } from "vitest";

import { deliverTelegramCarousel, telegramCarouselPartDefinitions } from "./telegram-carousel.mjs";

function harness(parts) {
  const mutable = structuredClone(parts);
  return {
    mutable,
    markSending: vi.fn(async (part) => { mutable.find((item) => item.id === part.id).send_status = "sending"; }),
    markSent: vi.fn(async (part, messageId) => {
      const item = mutable.find((candidate) => candidate.id === part.id);
      item.send_status = "sent";
      item.external_message_id = messageId;
      return { ...item };
    }),
    markFailed: vi.fn(async (part) => { mutable.find((item) => item.id === part.id).send_status = "failed"; }),
    markUnknown: vi.fn(async (part) => { mutable.find((item) => item.id === part.id).send_status = "unknown"; }),
  };
}

describe("Telegram native carousel contract", () => {
  it("plans three ordered media items and sends them in one provider call", async () => {
    const assets = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const definitions = telegramCarouselPartDefinitions({ assets, text: "Короткая подпись" });
    const parts = definitions.map((part, index) => ({
      id: index + 10,
      part_index: part.index,
      part_type: part.type,
      payload_html: part.payloadHtml,
      send_status: "pending",
      external_message_id: null,
    }));
    const state = harness(parts);
    const sendGroup = vi.fn(async () => ({
      ok: true,
      result: [{ message_id: 101 }, { message_id: 102 }, { message_id: 103 }],
    }));

    const result = await deliverTelegramCarousel({
      parts: state.mutable,
      assets,
      sendGroup,
      sendText: vi.fn(),
      ...state,
    });

    expect(result).toMatchObject({ ok: true, externalId: 101 });
    expect(sendGroup).toHaveBeenCalledOnce();
    expect(sendGroup).toHaveBeenCalledWith(assets, expect.stringContaining("Короткая подпись"));
    expect(state.mutable.map((part) => part.external_message_id)).toEqual(["101", "102", "103"]);
  });

  it("does not resend a group after an ambiguous provider handoff", async () => {
    const assets = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const parts = [
      { id: 1, part_index: 0, part_type: "media", payload_html: null, send_status: "sent", external_message_id: "201" },
      { id: 2, part_index: 1, part_type: "media", payload_html: null, send_status: "sending", external_message_id: null },
      { id: 3, part_index: 2, part_type: "media", payload_html: null, send_status: "sending", external_message_id: null },
    ];
    const state = harness(parts);
    const sendGroup = vi.fn();

    const result = await deliverTelegramCarousel({
      parts: state.mutable,
      assets,
      sendGroup,
      sendText: vi.fn(),
      ...state,
    });

    expect(result).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(sendGroup).not.toHaveBeenCalled();
  });

  it("marks every item failed when Telegram rejects the group before delivery", async () => {
    const assets = [{ id: 1 }, { id: 2 }, { id: 3 }];
    const parts = assets.map((_, index) => ({ id: index + 1, part_index: index, part_type: "media", payload_html: null, send_status: "pending", external_message_id: null }));
    const state = harness(parts);
    const result = await deliverTelegramCarousel({
      parts: state.mutable,
      assets,
      sendGroup: vi.fn(async () => ({ ok: false, error_code: 400, description: "Bad Request" })),
      sendText: vi.fn(),
      ...state,
    });
    expect(result).toMatchObject({ ok: false, deliveryUnknown: false, providerErrorCode: 400 });
    expect(state.mutable.every((part) => part.send_status === "failed")).toBe(true);
  });
});
