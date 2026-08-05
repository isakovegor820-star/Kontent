import { describe, expect, it, vi } from "vitest";

import {
  acknowledgeAiTerminal,
  AiTerminalAckError,
  stableAiClientRequest,
} from "./ai-client-idempotency";

describe("AI client request identity", () => {
  it("reuses the key for the same logical request after an uncertain stream", () => {
    const createKey = vi.fn(() => "new-key");
    const previous = { fingerprint: '{"input":"same"}', key: "saved-key" };

    expect(stableAiClientRequest(previous, previous.fingerprint, createKey)).toBe(previous);
    expect(createKey).not.toHaveBeenCalled();
  });

  it("allocates a new key when request content or destination changes", () => {
    const createKey = vi.fn(() => "new-key");

    expect(stableAiClientRequest(
      { fingerprint: '{"channelId":1}', key: "old-key" },
      '{"channelId":2}',
      createKey,
    )).toEqual({ fingerprint: '{"channelId":2}', key: "new-key" });
    expect(createKey).toHaveBeenCalledOnce();
  });

  it("ACKs a terminal stream with the same stable key", async () => {
    const fetchImpl = vi.fn(async () => Response.json(
      { ok: true, requestId: "ack-request", replayed: false },
      { status: 200, headers: { "x-ai-acknowledged": "true" } },
    ));

    await expect(acknowledgeAiTerminal("studio_stream_test_1", { fetchImpl })).resolves.toEqual({
      requestId: "ack-request",
      replayed: false,
    });
    expect(fetchImpl).toHaveBeenCalledWith("/api/ai/generate/ack", expect.objectContaining({
      method: "POST",
      headers: { "idempotency-key": "studio_stream_test_1" },
    }));
  });

  it("fails closed when ACK is missing or unavailable", async () => {
    const fetchImpl = vi.fn(async () => Response.json(
      { ok: false, requestId: "ack-failed", retryable: true },
      { status: 503 },
    ));

    const error = await acknowledgeAiTerminal("studio_stream_test_1", { fetchImpl }).catch((value) => value);
    expect(error).toBeInstanceOf(AiTerminalAckError);
    expect(error).toMatchObject({ status: 503, requestId: "ack-failed", retryable: true });
  });
});
