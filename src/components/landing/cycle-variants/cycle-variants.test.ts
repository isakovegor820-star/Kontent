import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  CycleVariants,
  type CycleVariant,
} from "./cycle-variants";

describe("cycle landing variants", () => {
  it.each([
    [1, "Ловит момент"],
    [2, "Из сигнала"],
    [3, "Пост под контролем"],
    [4, "Неделя собирается"],
    [5, "Каждая реакция"],
  ] as const)("renders variant %i", (variant, heading) => {
    const markup = renderToStaticMarkup(
      createElement(CycleVariants, { variant: variant as CycleVariant }),
    );

    expect(markup).toContain(heading);
    expect(markup).toContain("Разведка");
    expect(markup).toContain("ИИ-контент");
    expect(markup).toContain("Автопостинг");
    expect(markup).toContain("Реакции");
    expect(markup).toContain("Запустить первый цикл");
  });
});
