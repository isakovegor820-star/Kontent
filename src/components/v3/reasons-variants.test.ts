import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ReasonsVariants } from "./reasons-variants";

describe("ReasonsVariants variant 2", () => {
  it("renders three plain signal routes without the old middle control", () => {
    const markup = renderToStaticMarkup(
      createElement(ReasonsVariants, { variant: 2 }),
    );

    const routes = [
      ...markup.matchAll(
        /<div class="rv2-step__route" data-route-action="([^"]+)">/g,
      ),
    ];
    const actions = [
      ...markup.matchAll(/<span class="rv2-step__action">([^<]+)<\/span>/g),
    ].map(([, action]) => action);
    const lines = markup.match(
      /class="rv2-step__route-line" aria-hidden="true"/g,
    );
    const signals = markup.match(
      /class="rv2-step__signal" aria-hidden="true"/g,
    );

    expect(routes).toHaveLength(3);
    expect(actions).toEqual(["Планирует", "Находит", "Объясняет"]);
    expect(lines).toHaveLength(3);
    expect(signals).toHaveLength(3);
    expect(markup).not.toContain("rv2-step__hinge");
    expect(markup).not.toContain("rv2-step__marker");
    expect(markup).not.toContain("<button");
  });
});
