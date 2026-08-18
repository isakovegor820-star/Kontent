import { describe, expect, it } from "vitest";

import { serializeEditableText } from "./editable-text.mjs";

const text = (value) => ({ nodeType: 3, nodeValue: value, childNodes: [] });
const element = (tagName, ...childNodes) => ({
  nodeType: 1,
  nodeValue: null,
  tagName,
  childNodes,
});
const root = (...childNodes) => ({ nodeType: 1, nodeValue: null, tagName: "DIV", childNodes });

describe("serializeEditableText", () => {
  it("preserves an empty paragraph produced by contenteditable fill", () => {
    expect(serializeEditableText(root(
      text("Строка 1"),
      element("DIV", element("BR")),
      element("DIV", text("Строка 2")),
    ))).toBe("Строка 1\n\nСтрока 2");
  });

  it("keeps canonical text newlines and normal block boundaries equivalent", () => {
    expect(serializeEditableText(root(text("Строка 1\n\nСтрока 2"))))
      .toBe("Строка 1\n\nСтрока 2");
    expect(serializeEditableText(root(
      element("DIV", text("Строка 1")),
      element("DIV", text("Строка 2")),
    ))).toBe("Строка 1\nСтрока 2");
  });

  it("normalizes non-breaking spaces and trims only trailing line breaks", () => {
    expect(serializeEditableText(root(
      text("Текст\u00a0поста"),
      element("DIV", element("BR")),
    ))).toBe("Текст поста");
  });

  it("reports element ranges after inserted block boundaries", () => {
    const ranges = [];
    const bold = element("STRONG", text("Первый"));
    const paragraph = element("DIV", text("Второй"));
    expect(serializeEditableText(root(bold, paragraph), (node, start, end) => {
      ranges.push({ tagName: node.tagName, start, end });
    })).toBe("Первый\nВторой");
    expect(ranges).toContainEqual({ tagName: "STRONG", start: 0, end: 6 });
    expect(ranges).toContainEqual({ tagName: "DIV", start: 7, end: 13 });
  });
});
