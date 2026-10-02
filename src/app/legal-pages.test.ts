import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LEGAL_EMAIL } from "@/lib/contact";
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
});
