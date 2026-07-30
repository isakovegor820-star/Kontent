import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  V3KineticFooterLab,
  type FooterInteractionVariant,
} from "./kinetic-footer-lab";

describe("kinetic footer interaction variants", () => {
  it.each([1, 2, 3] satisfies FooterInteractionVariant[])(
    "renders interaction variant %s",
    (variant) => {
      const markup = renderToStaticMarkup(createElement(V3KineticFooterLab, { variant }));

      expect(markup).toContain('id="footer"');
      expect(markup).toContain("Переключатель механик футера");
      expect(markup).toContain(`href="/footer/3/${variant}#footer"`);
      expect(markup.match(/<button/g)).toHaveLength(6 + (variant === 2 ? 1 : 0));
    },
  );
});
