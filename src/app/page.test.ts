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
  it("renders the evidence-driven Aurora positioning", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(LandingPage)),
    );

    expect(markup).toContain("Сначала");
    expect(markup).toContain("доказательство.");
    expect(markup).toContain("Content Intelligence для Telegram");
    expect(markup).toContain("Найти сигнал в моей нише");
    expect(markup).toContain("Разбор сигнала");
    expect(markup).toContain("Демо-данные");
    expect(markup).toContain("Не лучше во всём. Сильнее в главном переходе.");
    expect(markup).toContain("Что стоит публиковать дальше — и почему?");
    expect(markup).toContain("От чужого сигнала — к вашему решению");
    expect(markup).toContain("Можно открыть любой вывод и понять, откуда он взялся");
    expect(markup).toContain("Не концепт. Рабочие контуры продукта.");
    expect(markup).toContain("Дайте Авроре её доказать");
    expect(markup).toContain('<main id="main">');
    expect(markup).toContain('aria-controls="landing-mobile-menu"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('href="/register"');
    expect(markup).toContain('id="access"');
    expect(markup).not.toContain("Все соцсети");
    expect(markup).not.toContain("Instagram");
    expect(markup).not.toContain("YouTube");
    expect(markup).not.toContain("Отзывы наших клиентов");
    expect(markup).not.toContain("Мария Иванова");
    expect(markup).not.toContain("990 ₽");
    expect(markup).not.toContain("14 дней бесплатно");
    expect(markup).not.toContain("Поддержка 24/7");
  });
});
