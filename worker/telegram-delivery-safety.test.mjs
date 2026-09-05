import { telegramUpdateContext } from "./telegram-update-delivery.mjs";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { deliverTelegramParts } from "./telegram-multipart.mjs";
import { deliverTelegramCarousel } from "./telegram-carousel.mjs";
import * as responseContract from "../src/lib/telegram-response.mjs";

const workerSource = readFileSync(new URL("../worker.mjs", import.meta.url), "utf8");
function actualTransports(fetchImpl) {
  const start = workerSource.indexOf("async function tg(method,");
  const end = workerSource.indexOf("const sleep =", start);
  const context = vm.createContext({
    fetch: fetchImpl, AbortSignal, FormData, Blob, TOKEN: "synthetic-token", TELEGRAM_API_URL: "https://telegram.invalid",
    pool: { query: async () => ({ rows: [], rowCount: 1 }) },
    telegramSafeErrorDescription: String, telegramUpdateContext,
    ...responseContract,
  });
  return vm.runInContext(`${workerSource.slice(start, end)}; ({ tg, tgSendAsset, tgSendMediaGroup });`, context);
}
function stateFor(types) {
  const parts = types.map((part_type, id) => ({ id, part_type, part_index: id, payload_html: part_type === "text" ? "safe fixture" : null, send_status: "pending", external_message_id: null }));
  return {
    parts,
    markSending: async (part) => { part.send_status = "sending"; },
    markSent: async (part, id) => { Object.assign(part, { send_status: "sent", external_message_id: id }); return { ...part }; },
    markUnknown: async (part) => { part.send_status = "unknown"; },
    markFailed: async (part) => { part.send_status = "failed"; },
  };
}

const image = { kind: "image", mime_type: "image/png", file_name: "fixture.png", data: Buffer.from("synthetic") };
describe("A2 provider acceptance and lost acknowledgement", () => {
  for (const format of ["text", "photo", "video", "album"]) {
    for (const fault of ["broken_json", "missing_receipt", "partial_receipt", "duplicate_receipt"]) {
      if (format !== "album" && ["partial_receipt", "duplicate_receipt"].includes(fault)) continue;
      it(`${format}: ${fault} remains unknown after reloading persisted parts`, async () => {
        const fetchImpl = vi.fn(async () => ({ status: 200, json: async () => {
          if (fault === "broken_json") throw new SyntaxError("Unexpected end of JSON input");
          if (fault === "partial_receipt") return { ok: true, result: [{ message_id: 101 }] };
          if (fault === "duplicate_receipt") return { ok: true, result: [1, 1, 1].map((message_id) => ({ message_id })) };
          return { ok: true, result: {} };
        } }));
        const transports = actualTransports(fetchImpl);
        const state = stateFor(format === "album" ? ["media", "media", "media"] : [format === "text" ? "text" : "media"]);
        const deliver = (persisted) => format === "album"
          ? deliverTelegramCarousel({ ...state, parts: persisted, assets: [image, image, image], sendGroup: (assets) => transports.tgSendMediaGroup(-100, assets), sendText: vi.fn() })
          : deliverTelegramParts({ ...state, parts: persisted, asset: format === "video" ? { ...image, kind: "video" } : image, sendText: () => transports.tg("sendMessage", { chat_id: -100, text: "safe fixture" }), sendAsset: (asset) => transports.tgSendAsset(-100, asset) });
        expect(await deliver(state.parts)).toMatchObject({ ok: false, deliveryUnknown: true });
        expect(state.parts.every((part) => ["sending", "unknown"].includes(part.send_status))).toBe(true);
        expect(await deliver(structuredClone(state.parts))).toMatchObject({ ok: false, deliveryUnknown: true });
        expect(fetchImpl).toHaveBeenCalledTimes(1);
      });
    }
  }
  it("keeps the durable sending fence if saving a positive receipt fails", async () => {
    const state = stateFor(["text"]);
    const sendText = vi.fn(async () => ({ ok: true, result: { message_id: 991 } }));
    const markSent = vi.fn(async () => { throw new Error("database connection lost after provider acceptance"); });
    expect(await deliverTelegramParts({ ...state, markSent, sendText })).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(await deliverTelegramParts({ ...state, parts: structuredClone(state.parts), markSent, sendText })).toMatchObject({ ok: false, deliveryUnknown: true });
    expect(sendText).toHaveBeenCalledTimes(1);
  });
});
