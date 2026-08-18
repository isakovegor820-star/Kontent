import { describe, expect, it } from "vitest";

import { telegramSafeErrorDescription } from "./telegram-safe-error.mjs";

describe("Telegram error redaction", () => {
  it("removes connection sessions and bot tokens before persistence", () => {
    const value = telegramSafeErrorDescription(
      "Bad Request: URL 'http://localhost:3000/bot/connect#token=session-secret' "
      + "called /bot123456:ABC_def-12345678901234567890/sendMessage",
    );

    expect(value).toContain("#token=[redacted]");
    expect(value).toContain("/bot[redacted]/sendMessage");
    expect(value).not.toContain("session-secret");
    expect(value).not.toContain("ABC_def");
  });

  it("bounds stored provider text", () => {
    expect(telegramSafeErrorDescription("x".repeat(800))).toHaveLength(500);
    expect(telegramSafeErrorDescription("abcdef", 3)).toBe("abc");
  });
});
