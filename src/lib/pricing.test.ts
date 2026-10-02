import { describe, expect, it } from "vitest";

import { PRICING, hasPublishedPricing, type PricingPlan } from "./pricing";
import { FAQ_ITEMS, PRICE_FAQ, faqItems } from "@/lib/seo/faq";

const PLAN: PricingPlan = {
  name: "Практика",
  price: "1 900 ₽ в месяц",
  priceRub: 1900,
  includes: ["Контент-план", "Источники и доказательства"],
  audience: "Одна практика или небольшая редакция",
};

describe("pricing stays unpublished until it is real", () => {
  it("ships without a price, because there is no price", () => {
    // Это не «забыли заполнить», а осознанное состояние: цена появляется
    // одной записью, и вместе с ней включаются таблица и вопрос в FAQ.
    expect(PRICING).toEqual([]);
    expect(hasPublishedPricing()).toBe(false);
  });

  it("keeps the price question out of the page while there is no price", () => {
    expect(FAQ_ITEMS.map((item) => item.question)).not.toContain(PRICE_FAQ.question);
    expect(faqItems([]).map((item) => item.question)).not.toContain(PRICE_FAQ.question);
  });

  it("turns the price question on together with the price, not separately", () => {
    const withPrice = faqItems([PLAN]);
    expect(withPrice.map((item) => item.question)).toContain(PRICE_FAQ.question);
    // Вопрос добавляется в конец и не вытесняет остальные.
    expect(withPrice).toHaveLength(FAQ_ITEMS.length + 1);
    expect(withPrice[withPrice.length - 1]).toBe(PRICE_FAQ);
    expect(hasPublishedPricing([PLAN])).toBe(true);
  });

  it("keeps the price answer honest about where the numbers are", () => {
    // Ответ не должен обещать «дёшево» или «от» без числа: он отправляет к таблице,
    // которая появляется в том же изменении.
    expect(PRICE_FAQ.answer).toContain("на этой странице");
    expect(PRICE_FAQ.answer).not.toMatch(/\d/u);
  });

  it("requires a numeric price for structured data, not just a string", () => {
    // Разметка SoftwareApplication не умеет читать «1 900 ₽ в месяц»: ей нужно число.
    // Поэтому в типе два поля, и расхождение между ними ловится здесь.
    for (const plan of [PLAN]) {
      expect(Number.isFinite(plan.priceRub)).toBe(true);
      expect(plan.priceRub).toBeGreaterThan(0);
      // Число и строка должны говорить одно и то же: «1 900 ₽» и priceRub: 1900.
      // Пробелы, включая неразрывные, в цене не считаются разделителем разрядов.
      const normalized = plan.price.replace(/[\s\u00a0]/gu, "");
      expect(normalized).toContain(String(plan.priceRub));
    }
  });
});
