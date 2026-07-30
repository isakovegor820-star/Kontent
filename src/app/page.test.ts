import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import LandingPage from "./page";

vi.mock("next/font/google", () => ({
  Dela_Gothic_One: () => ({ variable: "test-kinetic" }),
  Unbounded: () => ({ variable: "test-display" }),
  IBM_Plex_Mono: () => ({ variable: "test-mono" }),
}));

describe("production landing page", () => {
  it("renders the approved reasons route without comparison controls", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage));

    expect(markup).toContain('class="rv rv2"');
    expect(markup.match(/data-route-action=/g)).toHaveLength(3);
    expect(markup).toContain('id="memory"');
    expect(markup).toContain("Пишет не из воздуха");
    expect(markup).toContain("Визуальный секвенсор");
    expect(markup).toContain("v3-scroll-progress");
    expect(markup).toContain("Кинетический манифест");
    expect(markup).not.toContain("02 / Кинетический манифест");
    expect(markup).not.toContain("03 / 03");
    expect(markup).toContain(">Канал</span>");
    expect(markup).toContain("не должен");
    expect(markup).toContain(">зависеть</span>");
    expect(markup).toContain("от твоего");
    expect(markup).not.toContain("Переключатель финальных сцен");
    expect(markup).not.toContain("Переключатель механик футера");
    expect(markup).not.toContain("Пусть канал");
    expect(markup).not.toContain('id="pricing"');
    expect(markup).not.toContain("Сейчас — нисколько");
    expect(markup).not.toContain("Бесплатно");
    expect(markup).not.toContain("0 ₽");
    expect(markup).not.toContain('id="v3-ledger-title"');
    expect(markup).not.toContain('class="rv-switcher"');
    expect(markup).not.toContain('class="av-switcher"');
  });
});
