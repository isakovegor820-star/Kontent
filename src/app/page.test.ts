import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { StoreProvider } from "@/lib/store";
import LandingPage from "./page";

vi.mock("next/font/google", () => ({
  Dela_Gothic_One: () => ({ variable: "test-kinetic" }),
  Unbounded: () => ({ variable: "test-display" }),
  IBM_Plex_Mono: () => ({ variable: "test-mono" }),
}));

describe("production landing page", () => {
  it("renders the complete Aurora SMM landing structure", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(LandingPage)),
    );

    expect(markup).toContain("Аврора — ваш центр управления контентом");
    expect(markup).toContain("SMM-платформа нового поколения");
    expect(markup).toContain("Попробовать бесплатно");
    expect(markup).toContain("Всё необходимое для эффективного SMM");
    expect(markup).toContain("Планирование публикаций");
    expect(markup).toContain("Просто. Удобно. Эффективно.");
    expect(markup).toContain("Данные, которые помогают расти");
    expect(markup).toContain("124K");
    expect(markup).toContain("Отзывы наших клиентов");
    expect(markup).toContain("Выберите подходящий тариф");
    expect(markup).toContain("Готовы вывести ваш SMM на новый уровень?");
    expect(markup).toContain('href="#main-content"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('href="/register"');
    expect(markup).toContain('id="pricing"');
    expect(markup).not.toContain("Три причины, по которым соцсети стоят");
  });
});
