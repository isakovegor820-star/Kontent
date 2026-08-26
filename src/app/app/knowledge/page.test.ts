import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./page.tsx", import.meta.url), "utf8");

describe("Knowledge source form", () => {
  it("contains the long mobile tabs without widening the document", () => {
    expect(source).toContain('className="max-w-full min-w-0 overflow-x-auto pb-1"');
    expect(source).toContain('className="min-w-max"');
    expect(source).toContain('<Card className="min-w-0 space-y-4 p-5">');
  });

  it("associates every source field with a persistent label", () => {
    for (const id of [
      "knowledge-source-title",
      "knowledge-source-text",
      "knowledge-about",
      "knowledge-services",
      "knowledge-prices",
      "knowledge-taboos",
    ]) {
      expect(source).toContain(`htmlFor="${id}"`);
      expect(source).toContain(`id="${id}"`);
    }
  });

  it("announces empty submissions and moves focus to the field to fix", () => {
    expect(source).toContain('setPasteError("Вставь текст, который нужно добавить в базу.")');
    expect(source).toContain("textRef.current?.focus()");
    expect(source).toContain('setFormError("Заполни хотя бы одно поле, чтобы добавить материал.")');
    expect(source).toContain("aboutRef.current?.focus()");
    expect(source).toContain("aria-invalid={Boolean(pasteError)}");
    expect(source).toContain("aria-invalid={Boolean(formError)}");
  });
});
