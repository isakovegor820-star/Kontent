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
  it("renders the factual Aurora landing for legal content", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(LandingPage)),
    );

    expect(markup).toContain("Юридический контент с проверкой рисков и доказательств");
    expect(markup).toContain("SMM-платформа для юридического контента");
    expect(markup).toContain("Создать первый материал");
    expect(markup).toContain("Рабочий контур для юридической редакции");
    expect(markup).toContain("Планирование публикаций");
    expect(markup).toContain("От идеи до согласованной публикации");
    expect(markup).toContain("Проверяйте риски и доказательства до публикации");
    expect(markup).toContain("Пример проверки материала");
    expect(markup).toContain("Что уже есть для юридического редактора");
    expect(markup).toContain("Фактический статус рабочих контуров");
    expect(markup).toContain("Начните с проверяемого материала");
    expect(markup).toContain('<main id="main">');
    expect(markup).toContain('aria-controls="landing-mobile-menu"');
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
