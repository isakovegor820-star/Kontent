import { describe, expect, it } from "vitest";
import {
  redactBotCredential,
  redactBotCredentialsDeep,
  TG_BOT_CREDENTIAL_PATTERN,
} from "../../sentry-redaction.mjs";

describe("sentry-redaction", () => {
  it("removes a Telegram bot credential from a URL", () => {
    const url = "https://api.telegram.org/bot1234567890:AAHg7kYzN1wX2vQ3rR4tT5yU6iI7oO8pP9/sendMessage";
    const cleaned = redactBotCredential(url);
    expect(cleaned).not.toContain("1234567890:AAHg7kYzN1wX2vQ3rR4tT5yU6iI7oO8pP9");
    expect(cleaned).toContain("[tg-credential-redacted]");
    expect(cleaned).toContain("/sendMessage");
  });

  it("leaves unrelated strings untouched", () => {
    expect(redactBotCredential("https://example.com/posts/42")).toBe("https://example.com/posts/42");
    expect(redactBotCredential("user 42 approved post 7")).toBe("user 42 approved post 7");
  });

  it("cleans breadcrumbs and nested error payloads deeply", () => {
    const event = {
      message: "fetch failed https://api.telegram.org/bot9876543210:BBXxYyZz0123456789_abcdefghijklmnop/editMessageText",
      breadcrumbs: [
        { data: { url: "https://api.telegram.org/bot9876543210:BBXxYyZz0123456789_abcdefghijklmnop/sendMessage" } },
      ],
      request: { url: "https://api.telegram.org/bot9876543210:BBXxYyZz0123456789_abcdefghijklmnop/getChat" },
      extra: { nested: { list: ["https://api.telegram.org/bot9876543210:BBXxYyZz0123456789_abcdefghijklmnop/sendPhoto"] } },
      keep: "normal value",
      number: 42,
    };
    redactBotCredentialsDeep(event);
    expect(JSON.stringify(event)).not.toContain("9876543210:BBXxYyZz");
    expect(event.keep).toBe("normal value");
    expect(event.number).toBe(42);
    expect(event.breadcrumbs[0].data.url).toContain("[tg-credential-redacted]");
  });

  it("survives circular references", () => {
    const payload = { name: "x" };
    payload.self = payload;
    expect(() => redactBotCredentialsDeep(payload)).not.toThrow();
    expect(payload.name).toBe("x");
  });

  it("pattern matches only bot-id:token pairs", () => {
    expect(TG_BOT_CREDENTIAL_PATTERN.test("1234567890:AAHg7kYzN1wX2vQ3rR4tT5yU6iI7oO8pP9")).toBe(true);
    expect(TG_BOT_CREDENTIAL_PATTERN.test("plain text without token")).toBe(false);
  });
});
