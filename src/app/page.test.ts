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
  it("renders the restored Aurora Glass landing with the current product capabilities", () => {
    const markup = renderToStaticMarkup(
      createElement(StoreProvider, null, createElement(LandingPage)),
    );

    expect(markup).toContain("Канал");
    expect(markup).toContain("ведётся,");
    expect(markup).toContain("Запустить первый цикл");
    expect(markup).toContain("Почта и пароль. Канал подключишь следующим шагом.");
    expect(markup).toContain("Три причины, по которым соцсети стоят");
    expect(markup).toContain("Три шага — и дальше автопилот");
    expect(markup).toContain('id="memory"');
    expect(markup.indexOf('id="memory"')).toBeLessThan(markup.indexOf('id="quality"'));
    expect(markup).toContain("Пишет в твоём голосе.");
    expect(markup).toContain("Три источника памяти");
    expect(markup).toContain("Активная опора для материала");
    expect(markup).toContain("В канал проходит");
    expect(markup).toContain("не каждый текст.");
    expect(markup).toContain("Материал 0184");
    expect(markup).toContain("Нужно исправить");
    expect(markup).toContain("Исправить по стандарту");
    expect(markup).toContain("Порог публикации: 85");
    expect(markup).toContain("Ручное подтверждение можно оставить навсегда");
    expect(markup).toContain("А если пост не выйдет?");
    expect(markup).toContain('id="compare"');
    expect(markup).toContain('id="faq"');
    expect(markup).not.toContain('class="aurora-variants aurora-variant-4"');
  });
});
