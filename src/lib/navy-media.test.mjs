import { describe, expect, it, vi } from "vitest";
import {
  createNavyMediaClient,
  isRetryableNavyMediaStatus,
} from "./navy-media.mjs";

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
  };
}

describe("Navy media client", () => {
  it("sends the stable provider idempotency and correlation headers", async () => {
    const fetchImpl = vi.fn(async () => response(202, { id: "navy-41" }));
    const client = createNavyMediaClient({
      apiKey: "secret-not-logged",
      baseUrl: "https://navy.example/v1/",
      fetchImpl,
    });

    await expect(client.create({
      payload: { model: "nano-banana-2", prompt: "do not log this" },
      requestKey: "aurora-media-11111111-1111-4111-8111-111111111111",
      requestId: "11111111-1111-4111-8111-111111111111",
    })).resolves.toMatchObject({ state: "pending", providerJobId: "navy-41" });

    expect(fetchImpl).toHaveBeenCalledWith(
      "https://navy.example/v1/images/generations",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "idempotency-key": "aurora-media-11111111-1111-4111-8111-111111111111",
          "x-request-id": "11111111-1111-4111-8111-111111111111",
        }),
      }),
    );
  });

  it("preserves the 429 subtype and retries only the explicit allowlist", async () => {
    const client = createNavyMediaClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => response(429, { error: { message: "raw provider detail" } })),
    });
    await expect(client.create({ payload: {}, requestKey: "stable", requestId: "request" }))
      .rejects.toMatchObject({ code: "provider_rate_limited", httpStatus: 429, retryable: true });
    expect([429, 500, 502, 503].every(isRetryableNavyMediaStatus)).toBe(true);
    expect([400, 408, 409, 422, 504].some(isRetryableNavyMediaStatus)).toBe(false);
  });

  it("returns inline data media without forcing an HTTPS-only parser", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const client = createNavyMediaClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => response(200, { data: [{ url: dataUrl }] })),
    });
    await expect(client.create({ payload: {}, requestKey: "stable", requestId: "request" }))
      .resolves.toEqual({ state: "completed", outputUrl: dataUrl, providerJobId: null });
  });

  it("fails terminally on a completed response without media", async () => {
    const client = createNavyMediaClient({
      apiKey: "test",
      fetchImpl: vi.fn(async () => response(200, { status: "completed" })),
    });
    await expect(client.poll({ providerJobId: "job-1", requestId: "request" }))
      .rejects.toMatchObject({ code: "empty_result", retryable: false });
  });
});
