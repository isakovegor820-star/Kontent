import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { V3AnimatedFooter, type FooterVariant } from "./footer-variants";

describe("animated footer variants", () => {
  it.each([1, 2, 3] satisfies FooterVariant[])("renders footer variant %s", (variant) => {
    const markup = renderToStaticMarkup(
      createElement(V3AnimatedFooter, { variant, showSwitcher: true }),
    );

    expect(markup).toContain('id="footer"');
    expect(markup).toContain('aria-label="Аврора"');
    expect(markup).toContain("Переключатель вариантов футера");
    expect(markup).toContain(`href="/footer/${variant}#footer"`);
  });
});
