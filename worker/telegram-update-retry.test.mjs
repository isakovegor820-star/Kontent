import { describe, expect, it } from "vitest";

import {
  nextTelegramUpdateFailure,
  telegramRetryAfterMs,
} from "./telegram-update-retry.mjs";

describe("Telegram update retries", () => {
  it("retries a failed update twice and then releases the queue", () => {
    const first = nextTelegramUpdateFailure(0);
    const second = nextTelegramUpdateFailure(first.attempts);
    const third = nextTelegramUpdateFailure(second.attempts);

    expect(first).toEqual({ attempts: 1, retry: true, exhausted: false });
    expect(second).toEqual({ attempts: 2, retry: true, exhausted: false });
    expect(third).toEqual({ attempts: 3, retry: false, exhausted: true });
  });

  it("retries only explicit Telegram throttling and server rejections", () => {
    expect(telegramRetryAfterMs({ ok: false, error_code: 429, parameters: { retry_after: 2 } }))
      .toBe(2_000);
    expect(telegramRetryAfterMs({ ok: false, error_code: 503 })).toBe(1_500);
    expect(telegramRetryAfterMs({ ok: false, error_code: 400 })).toBeNull();
    expect(telegramRetryAfterMs({ ok: true })).toBeNull();
  });

  it("caps provider-requested delays so polling remains observable", () => {
    expect(telegramRetryAfterMs({ ok: false, error_code: 429, parameters: { retry_after: 300 } }))
      .toBe(30_000);
  });
});
