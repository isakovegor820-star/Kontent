import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LEGAL_EMAIL } from "@/lib/contact";
import ConsentPage from "./consent/page";
import CookiesPage from "./cookies/page";
import PersonalDataPage from "./personal-data/page";
import PrivacyPage from "./privacy/page";
import TermsPage from "./terms/page";

describe("public legal pages", () => {
  it("renders actual terms instead of an email-only placeholder", () => {
    const markup = renderToStaticMarkup(createElement(TermsPage));
    expect(markup).toContain("Условия использования");
    expect(markup).toContain("Допустимое использование");
    expect(markup).toContain("Это не является обещанием бессрочного бесплатного тарифа");
    // Адрес берётся из lib/contact, а не из литерала: смена домена — правка в одном месте.
    expect(markup).toContain(LEGAL_EMAIL);
  });

  it("explains collected data, processors, retention and user requests", () => {
    const markup = renderToStaticMarkup(createElement(PrivacyPage));
    expect(markup).toContain("Какие данные мы получаем");
    expect(markup).toContain("Кому данные могут передаваться");
    expect(markup).toContain("Хранение и защита");
    expect(markup).toContain("Ваши права и запросы");
  });

  // Трек A плана 152-ФЗ: три документа, которых раньше не было отдельными
  // страницами. Структура обязательна, формулировки утверждает юрист,
  // поэтому тест держит состав разделов, а не конкретные фразы.
  it("renders the consent document with the required composition", () => {
    const markup = renderToStaticMarkup(createElement(ConsentPage));
    expect(markup).toContain("Кто даёт согласие");
    expect(markup).toContain("Какие данные обрабатываются");
    expect(markup).toContain("Цель обработки");
    expect(markup).toContain("Срок действия и отзыв согласия");
    expect(markup).toContain("Как подтверждается согласие");
  });

  it("renders the cookie document with categories and withdrawal", () => {
    const markup = renderToStaticMarkup(createElement(CookiesPage));
    expect(markup).toContain("Необходимые cookie");
    expect(markup).toContain("Аналитические cookie");
    expect(markup).toContain("Рекламные cookie");
    expect(markup).toContain("Как изменить или отозвать выбор");
  });

  it("publishes implemented protection measures", () => {
    const markup = renderToStaticMarkup(createElement(PersonalDataPage));
    expect(markup).toContain("Технические меры");
    expect(markup).toContain("Работа с обращениями");
    expect(markup).toContain("Оценка вреда субъектам");
  });

  // Реквизиты оператора печатаются только после подтверждения. Иначе документ
  // выглядел бы заполненным, оставаясь пустым (см. lib/contact.ts).
  it("does not print unconfirmed operator details as a fact", () => {
    const markup = renderToStaticMarkup(createElement(ConsentPage));
    expect(markup).not.toContain("ИНН: ");
    expect(markup).not.toContain("ОГРН: ");
  });
});
