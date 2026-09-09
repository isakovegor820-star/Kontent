import { describe, expect, it, vi } from "vitest";
import { verifyTelegramChannelActor } from "./telegram-connect-provider.mjs";

const input = { token: "123:test-only", actorId: 456, chatRef: "@safe" };
const json = (result) => Response.json({ ok: true, result });
const valid = () => vi.fn()
  .mockResolvedValueOnce(json({ id: -1001, type: "channel" }))
  .mockResolvedValueOnce(json({ status: "administrator", can_post_messages: true }))
  .mockResolvedValueOnce(json({ status: "creator" }));

describe("bounded Telegram connection checks", () => {
  it("checks current bot and actor on the same resolved channel", async () => {
    const fetcher = valid();
    await expect(verifyTelegramChannelActor({ ...input, fetcher })).resolves.toMatchObject({ id: -1001 });
    expect(fetcher.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { chat_id: "@safe" }, { chat_id: -1001, user_id: 123 }, { chat_id: -1001, user_id: 456 },
    ]);
  });
  it.each([
    [new Response('{"ok":', { status: 200 }), "provider_invalid_response", 502],
    [Response.json({ ok: false, error_code: 503 }), "provider_unavailable", 503],
    [Response.json({ ok: false, error_code: 401 }), "bot_credentials_invalid", 503],
    [Response.json({ ok: false, error_code: 403 }), "no_access", 422],
  ])("classifies provider response without inventing missing rights", async (response, code, status) => {
    await expect(verifyTelegramChannelActor({ ...input, fetcher: vi.fn().mockResolvedValue(response) })).rejects.toMatchObject({ code, status });
  });
  it("preserves confirmed provider retry_after", async () => {
    await expect(verifyTelegramChannelActor({ ...input, fetcher: vi.fn().mockResolvedValue(Response.json({
      ok: false, error_code: 429, parameters: { retry_after: 17 },
    })) })).rejects.toMatchObject({ code: "provider_rate_limited", retryAfter: 17, status: 429 });
  });
  it("bounds an unresponsive transport even if it ignores AbortSignal", async () => {
    const started = Date.now();
    await expect(verifyTelegramChannelActor({ ...input, deadlineMs: 20, fetcher: () => new Promise(() => {}) }))
      .rejects.toMatchObject({ code: "provider_timeout", status: 504 });
    expect(Date.now() - started).toBeLessThan(500);
  });
  it("bounds a stalled JSON body under the same deadline", async () => {
    await expect(verifyTelegramChannelActor({ ...input, deadlineMs: 20, fetcher: async () => ({ json: () => new Promise(() => {}) }) }))
      .rejects.toMatchObject({ code: "provider_timeout" });
  });
  it("cancels when the caller disconnects", async () => {
    const controller = new AbortController();
    const result = verifyTelegramChannelActor({ ...input, signal: controller.signal, fetcher: () => new Promise(() => {}) });
    controller.abort();
    await expect(result).rejects.toMatchObject({ code: "request_cancelled" });
  });
  it("does not treat unspecified bot publish permission as granted", async () => {
    await expect(verifyTelegramChannelActor({ ...input, fetcher: vi.fn()
      .mockResolvedValueOnce(json({ id: -1001, type: "channel" }))
      .mockResolvedValueOnce(json({ status: "administrator" })) })).rejects.toMatchObject({ code: "not_admin" });
  });
});
