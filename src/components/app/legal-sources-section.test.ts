import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { LegalSourcesSection } from "./legal-sources-section";

describe("LegalSourcesSection", () => {
  it("renders an accessible legal category and explicit licensing limits", () => {
    const html = renderToStaticMarkup(createElement(LegalSourcesSection));

    expect(html).toContain('aria-labelledby="legal-sources-title"');
    expect(html).toContain('id="legal-sources-title"');
    expect(html).toContain("Юридические источники");
    expect(html).toContain("Публичные RSS");
    expect(html).toContain("не собирает пароль, cookies браузера и данные сессии");
    expect(html).toContain("не скрейпит закрытый кабинет");
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain('role="status"');
  });
});
