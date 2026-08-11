import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { analyzeLegalTypography } from "@/lib/legal-typographer";
import { TypographerPanel } from "./typographer-panel";

const noop = vi.fn();

describe("TypographerPanel", () => {
  it("uses native controls and exposes before/after meaning without relying on color", () => {
    const suggestions = analyzeLegalTypography("Срок  3-5 дней -- проверьте.");
    const html = renderToStaticMarkup(createElement(TypographerPanel, {
      suggestions,
      selectedIds: suggestions.map((item) => item.id),
      onSelectionChange: noop,
      onApplySelected: noop,
      onApplySafe: noop,
      onUndo: noop,
      canUndo: true,
    }));
    expect(html).toContain("<section");
    expect(html).toContain('aria-labelledby="typographer-title"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("<del");
    expect(html).toContain("<ins");
    expect(html).toContain("Было: ");
    expect(html).toContain("Станет: ");
    expect(html).toContain("Применить выбранные");
    expect(html).not.toContain("transition-all");
  });

  it("has an honest empty state and no enabled destructive action", () => {
    const html = renderToStaticMarkup(createElement(TypographerPanel, {
      suggestions: [],
      selectedIds: [],
      onSelectionChange: noop,
      onApplySelected: noop,
      onApplySafe: noop,
      onUndo: noop,
    }));
    expect(html).toContain("Текст оформлен");
    expect(html).toContain("Замены не найдены");
    expect(html).toContain("disabled");
  });
});
