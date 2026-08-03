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
  it("renders the streamlined production story without comparison controls", () => {
    const markup = renderToStaticMarkup(createElement(LandingPage));

    expect(markup).toContain("Ритм появляется там, где раньше всё зависало");
    expect(markup).toContain("Автопилот для экспертов и Telegram-авторов");
    expect(markup).toContain("Запустить первый цикл");
    expect(markup).toContain("Почта и пароль. Канал подключишь следующим шагом.");
    expect(markup).toContain("Продукт работает сейчас");
    expect(markup).toContain("Не начинаешь с пустого листа");
    expect(markup).toContain("Не переписываешь ИИ с нуля");
    expect(markup).toContain("Не держишь ноутбук открытым");
    expect(markup).toContain('id="memory"');
    expect(markup.indexOf('id="memory"')).toBeLessThan(markup.indexOf('id="quality"'));
    expect(markup).toContain("Манифест памяти");
    expect(markup).toContain("Интерактивная гравитация слова Аврора");
    expect(markup).toContain("В канал проходит<br/>не каждый текст");
    expect(markup).toContain("Материал 0184");
    expect(markup).toContain("Нужно исправить");
    expect(markup).toContain("Исправить по стандарту");
    expect(markup).not.toContain("Юридический");
    expect(markup).toContain("Визуальный секвенсор");
    expect(markup).toContain("0 / 6 слоёв");
    expect(markup).toContain("Слои визуального секвенсора");
    expect(markup).toContain("Включить слой Тикер");
    expect(markup).not.toContain("Нажми на буквы — включи ритм");
    expect(markup).toContain("v3-scroll-progress");
    expect(markup).toContain("Кинетический манифест");
    expect(markup).toContain("Механика продукта");
    expect(markup).toContain("Как работает Аврора");
    expect(markup).toContain("Кинетические глаголы");
    expect(markup).toContain("сильную тему");
    expect(markup).not.toContain("4 шага. Один готовый пост.");
    expect(markup).not.toContain("Лист 01 / 04");
    expect(markup).not.toContain("Сейчас в работе:");
    expect(markup).toContain("Что произойдёт после регистрации?");
    expect(markup).not.toContain("02 / Кинетический манифест");
    expect(markup).not.toContain("03 / 03");
    expect(markup).toContain(">Канал</span>");
    expect(markup).toContain("не должен");
    expect(markup).toContain(">зависеть</span>");
    expect(markup).toContain("от твоего");
    expect(markup).not.toContain("Переключатель финальных сцен");
    expect(markup).not.toContain("Переключатель механик футера");
    expect(markup).not.toContain("Пусть канал");
    expect(markup).not.toContain("Пост, который написала Аврора");
    expect(markup).not.toContain('class="rv rv2"');
    expect(markup).not.toContain('id="pricing"');
    expect(markup).not.toContain("Сейчас — нисколько");
    expect(markup).not.toContain("Бесплатно");
    expect(markup).not.toContain("0 ₽");
    expect(markup).not.toContain("Подключить Telegram-канал");
    expect(markup).not.toContain("×7,8");
    expect(markup).not.toContain("71 400");
    expect(markup).not.toContain("+34%");
    expect(markup).not.toContain("40 сек");
    expect(markup).not.toContain("Выпуск №0048");
    expect(markup).not.toContain('id="v3-ledger-title"');
    expect(markup).not.toContain('class="rv-switcher"');
    expect(markup).not.toContain('class="av-switcher"');
  });
});
