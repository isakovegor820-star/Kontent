import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { V3ScrollFinale, type ScrollFinaleVariant } from "./scroll-finale";

const CASES: Array<[ScrollFinaleVariant, string]> = [
  [1, "Ты задаёшь"],
  [2, "Кинетический манифест"],
  [3, "Что Аврора"],
];

describe("scroll finale variants", () => {
  it.each(CASES)("renders variant %s", (variant, headline) => {
    const markup = renderToStaticMarkup(createElement(V3ScrollFinale, { variant }));

    expect(markup).toContain('id="finale"');
    expect(markup).toContain(headline);
    expect(markup).not.toContain("Пусть канал");
  });
});
