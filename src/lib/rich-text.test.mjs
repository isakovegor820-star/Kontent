import { describe, expect, it } from "vitest";

import {
  normalizeRichTextEntities,
  normalizeRichTextUrl,
  sliceRichTextEntities,
  trimRichTextContent,
} from "./rich-text.mjs";

describe("rich text contract", () => {
  it("normalizes bare links and accepts only safe schemes", () => {
    expect(normalizeRichTextUrl("example.com/docs")).toBe("https://example.com/docs");
    expect(normalizeRichTextUrl("mailto:hello@example.com")).toBe("mailto:hello@example.com");
    expect(() => normalizeRichTextUrl("javascript:alert(1)")).toThrow("rich_text_url_invalid");
  });

  it("canonicalizes and deduplicates valid ranges", () => {
    expect(normalizeRichTextEntities("hello", [
      { type: "italic", offset: 1, length: 3 },
      { type: "bold", offset: 0, length: 5 },
      { type: "bold", offset: 0, length: 5 },
    ])).toEqual([
      { type: "bold", offset: 0, length: 5 },
      { type: "italic", offset: 1, length: 3 },
    ]);
  });

  it("rejects out-of-range and executable entities", () => {
    expect(() => normalizeRichTextEntities("hello", [
      { type: "bold", offset: 4, length: 2 },
    ])).toThrow("rich_text_entities_invalid");
    expect(() => normalizeRichTextEntities("hello", [
      { type: "link", offset: 0, length: 5, url: "data:text/html,x" },
    ])).toThrow("rich_text_url_invalid");
  });

  it("clips ranges when publication trims or slices text", () => {
    const entities = [{ type: "bold", offset: 0, length: 6 }];
    expect(sliceRichTextEntities(entities, 2, 5)).toEqual([
      { type: "bold", offset: 0, length: 3 },
    ]);
    expect(trimRichTextContent("  hello  ", [
      { type: "italic", offset: 1, length: 6 },
    ])).toEqual({
      text: "hello",
      entities: [{ type: "italic", offset: 0, length: 5 }],
    });
  });
});
