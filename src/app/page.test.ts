import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COMPARISON_COLUMNS, COMPARISON_LEGEND, COMPARISON_ROWS } from "@/lib/comparison";
import {
  PRODUCT_ANSWER,
  PRODUCT_CONTENT_UPDATED_AT,
  PRODUCT_DOES_NOT_FIT,
  PRODUCT_FITS,
} from "@/lib/product";
import { FAQ_ITEMS } from "@/lib/seo/faq";
import { StoreProvider } from "@/lib/store";
import LandingPage from "./page";

const render = () => renderToStaticMarkup(createElement(StoreProvider, null, createElement(LandingPage)));

afterEach(() => {
  vi.unstubAllEnvs();
});

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
    expect(markup).not.toContain("SMM-платформа для юридического контента");
    expect(markup).not.toMatch(/class="[^"]*eyebrow/);
    expect(markup).not.toMatch(/class="[^"]*accessStatus/);
    expect(markup).toContain("Создать первый материал");
    expect(markup).toContain("Рабочий контур для юридической редакции");
    expect(markup).toContain("Планирование публикаций");
    expect(markup).toContain("От идеи до согласованной публикации");
    expect(markup).toContain("Контекст собран");
    expect(markup).toContain("План готов");
    expect(markup).toContain("Источники связаны");
    expect(markup).toContain("Версия согласована");
    expect(markup).toContain("process-route-gradient");
    expect(markup).toContain("Проверяйте риски и доказательства до публикации");
    expect(markup).toContain("Пример проверки материала");
    expect(markup).toContain("Что уже есть для юридического редактора");
    expect(markup).toContain('data-editor-capability="evidence"');
    expect(markup).toContain('data-editor-capability="sources"');
    expect(markup).toContain('data-editor-capability="history"');
    expect(markup).toContain('data-capability-scene="evidence"');
    expect(markup).toContain("Карточка доказательства");
    expect(markup).toContain("Юридические источники");
    expect(markup).toContain("История согласования");
    expect(markup).toContain("Фактический статус рабочих контуров");
    expect(markup).toContain('data-access-card="editor"');
    expect(markup).toContain('data-access-card="telegram"');
    expect(markup).toContain('data-access-card="vk"');
    expect(markup).toContain("Настройки тона, включая необязательный мат");
    expect(markup).toContain("Повторная попытка без дублей");
    expect(markup).toContain("Статус готовности внутри проекта");
    expect(markup).toContain("Начните с проверяемого материала");
    expect(markup).toContain('<main id="main">');
    expect(markup).toContain('aria-controls="landing-mobile-menu"');
    expect(markup).toContain('href="/login"');
    expect(markup).toContain('href="/register"');
    expect(markup).toContain('href="/terms"');
    expect(markup).toContain('href="/privacy"');
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

describe("landing blocks for search and generative answers", () => {
  it("opens with a direct answer of 40 to 60 words", () => {
    const markup = render();
    const words = PRODUCT_ANSWER.split(/\s+/u).filter(Boolean);
    expect(words.length).toBeGreaterThanOrEqual(40);
    expect(words.length).toBeLessThanOrEqual(60);
    expect(markup).toContain(PRODUCT_ANSWER);

    // Ответ обязан идти в разметке раньше остальных блоков: генеративный движок
    // вырезает первые абзацы, а не тот блок, который ниже визуально.
    const answerAt = markup.indexOf(PRODUCT_ANSWER);
    const featuresAt = markup.indexOf('id="features"');
    const answerBlockAt = markup.indexOf('id="answer"');
    expect(answerBlockAt).toBeGreaterThan(-1);
    expect(answerAt).toBeGreaterThan(answerBlockAt);
    expect(answerAt).toBeLessThan(featuresAt);
  });

  it("states who the product is not for, not only who it suits", () => {
    const markup = render();
    expect(markup).toContain("Кому подходит Аврора");
    expect(markup).toContain("Подойдёт, если");
    expect(markup).toContain("Не подойдёт, если");
    for (const item of [...PRODUCT_FITS, ...PRODUCT_DOES_NOT_FIT]) {
      expect(markup).toContain(item.slice(0, 60));
    }
  });

  it("compares with alternatives in a real table and admits the weak row", () => {
    const markup = render();
    expect(markup).toContain("<table");
    expect(markup).toContain("<caption");
    for (const column of COMPARISON_COLUMNS) {
      expect(markup).toContain(column);
    }
    for (const row of COMPARISON_ROWS) {
      expect(markup).toContain(row.criterion);
    }
    // Без этой строки таблица читается как реклама. С ней — как сравнение.
    const weakRow = COMPARISON_ROWS.find((row) => row.criterion === "Глубина аналитики чужих каналов");
    expect(weakRow?.cells[0]).toBe("нет");
    expect(markup).toContain(COMPARISON_LEGEND);
  });

  it("renders every FAQ question as a heading and never invents a price", () => {
    const markup = render();
    const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    for (const item of FAQ_ITEMS) {
      // Вопрос обязан быть заголовком, а не строкой списка: иначе он не становится
      // отдельным входом ни в поиске, ни в ответе движка.
      expect(markup).toMatch(new RegExp(`<h3[^>]*>${escape(item.question)}</h3>`, "u"));
      expect(markup).toContain(item.answer);
    }
    // Вопрос про цену не публикуется, пока цены нет.
    expect(markup).not.toContain("Сколько стоит");
    expect(markup).not.toMatch(/\d[\d\s]*₽/u);
    expect(markup).not.toMatch(/\d[\d\s]*руб/iu);
  });

  it("builds FAQPage markup from the same array that renders the text", () => {
    vi.stubEnv("APP_URL", "https://app.example.com");
    const markup = render();
    const blocks = [...markup.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    expect(blocks.length).toBeGreaterThan(0);

    const faq = blocks
      .map((block) => JSON.parse(block[1].replace(/\\u003c/gu, "<")))
      .find((value) => value["@type"] === "FAQPage");
    expect(faq).toBeDefined();
    expect(faq.mainEntity).toHaveLength(FAQ_ITEMS.length);
    for (const item of FAQ_ITEMS) {
      const entity = faq.mainEntity.find((entry: { name: string }) => entry.name === item.question);
      expect(entity, `вопрос без разметки: ${item.question}`).toBeDefined();
      expect(entity.acceptedAnswer.text).toBe(item.answer);
    }
  });

  it("omits FAQPage markup entirely when the canonical origin is unknown", () => {
    vi.stubEnv("APP_URL", "");
    const markup = render();
    expect(markup).not.toContain("FAQPage");
  });

  it("shows a real update date and no placeholder author", () => {
    const markup = render();
    expect(markup).toContain(`Обновлено: ${PRODUCT_CONTENT_UPDATED_AT}`);
    expect(markup).not.toContain("Имя Фамилия");
    expect(markup).not.toContain("[НУЖНО");
    expect(markup).not.toContain("TODO");
  });
});
