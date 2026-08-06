import { describe, expect, it } from "vitest";

import {
  buildTelegramPayload,
  splitTelegramHtml,
  telegramEntityLength,
  telegramHtmlToText,
} from "./telegram-payload.mjs";

describe("Telegram final payload", () => {
  it.each([4095, 4096])("keeps %i visible characters in one message", (length) => {
    const payload = buildTelegramPayload({ text: "x".repeat(length) });
    expect(payload.parts).toHaveLength(1);
    expect(payload.parts[0].entityLength).toBe(length);
  });

  it("splits 4097 visible characters and never exceeds the final limit", () => {
    const payload = buildTelegramPayload({ text: "x".repeat(4097) });
    expect(payload.parts).toHaveLength(2);
    expect(payload.parts.map((part) => part.entityLength)).toEqual([4096, 1]);
    expect(payload.parts.every((part) => telegramEntityLength(part.payloadHtml) <= 4096)).toBe(true);
  });

  it("measures final formatted text rather than raw input", () => {
    const input = Array.from({ length: 50 }, (_, index) => `Предложение ${index + 1}.`).join(" ");
    const payload = buildTelegramPayload({ text: input });
    expect(payload.formattedText.length).toBeGreaterThan(input.length);
    expect(payload.entityLength).toBe(payload.formattedText.length);
  });

  it("counts escaped HTML entities as one visible character", () => {
    const payload = buildTelegramPayload({ text: "<tag> & value" });
    expect(payload.formattedHtml).toContain("&lt;tag&gt; &amp; value");
    expect(payload.entityLength).toBe("<tag> & value".length);
  });

  it("never splits surrogate pairs or loses combining Unicode sequences", () => {
    const text = `${"x".repeat(4094)}👩‍💻e\u0301`;
    const payload = buildTelegramPayload({ text });
    expect(payload.parts.length).toBeGreaterThan(1);
    expect(payload.parts.every((part) => part.entityLength <= 4096)).toBe(true);
    expect(payload.parts.map((part) => telegramHtmlToText(part.payloadHtml)).join("")).toBe(text);
  });

  it("falls back to a safe hard boundary for a single long sentence", () => {
    const text = "я".repeat(9000);
    const payload = buildTelegramPayload({ text });
    expect(payload.parts.map((part) => part.entityLength)).toEqual([4096, 4096, 808]);
    expect(payload.parts.map((part) => telegramHtmlToText(part.payloadHtml)).join("")).toBe(text);
  });

  it("closes and reopens bold and spoiler formatting at each part boundary", () => {
    const payload = buildTelegramPayload({ text: `**${"a".repeat(3000)}||${"b".repeat(3000)}||**` });
    expect(payload.parts).toHaveLength(2);
    for (const part of payload.parts) {
      expect(part.payloadHtml).toMatch(/^<b>/u);
      expect(part.payloadHtml).toMatch(/<\/b>$/u);
      expect(part.entityLength).toBeLessThanOrEqual(4096);
    }
    expect(payload.parts[1].payloadHtml).toContain("<tg-spoiler>");
  });

  it.each([1023, 1024])("uses a media caption at %i visible characters", (length) => {
    const payload = buildTelegramPayload({ text: "x".repeat(length), hasAsset: true });
    expect(payload.parts).toEqual([expect.objectContaining({ type: "media_caption", entityLength: length })]);
  });

  it("separates media and text at 1025 visible characters", () => {
    const payload = buildTelegramPayload({ text: "x".repeat(1025), hasAsset: true });
    expect(payload.parts.map((part) => part.type)).toEqual(["media", "text"]);
    expect(payload.parts[1].entityLength).toBe(1025);
  });

  it("prefers paragraph and sentence boundaries", () => {
    const html = `${"a".repeat(4080)}.\n\nSecond paragraph`;
    const [first, second] = splitTelegramHtml(html);
    expect(telegramHtmlToText(first.html)).toBe(`${"a".repeat(4080)}.\n\n`);
    expect(telegramHtmlToText(second.html)).toBe("Second paragraph");
  });
});
