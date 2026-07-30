import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FooterInteractionComparison } from "./footer-interaction-comparison";

describe("footer interaction comparison", () => {
  it("shows all three mechanics without choosing one", () => {
    const markup = renderToStaticMarkup(createElement(FooterInteractionComparison));

    expect(markup).toContain("Сравнение / ничего не выбрано");
    expect(markup).toContain('id="mechanic-1-footer"');
    expect(markup).toContain('id="mechanic-2-footer"');
    expect(markup).toContain('id="mechanic-3-footer"');
    expect(markup).not.toContain("Переключатель механик футера");
  });
});
