import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { V3ProductionFooter } from "./production-footer";

describe("V3ProductionFooter", () => {
  it("is a static product footer rather than an unrelated letter game", () => {
    const markup = renderToStaticMarkup(createElement(V3ProductionFooter));
    expect(markup).toContain("Аврора готовит, проверяет и публикует");
    expect(markup).toContain('href="/register"');
    expect(markup).not.toContain("Собери Аврору");
    expect(markup).not.toContain("<button");
  });
});
