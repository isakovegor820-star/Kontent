import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OpportunityPostDialog } from "./opportunity-post-dialog";

describe("OpportunityPostDialog", () => {
  it("exposes an accessible network and post-variant choice", () => {
    const html = renderToStaticMarkup(createElement(OpportunityPostDialog, {
      target: { id: 88, title: "Новые правила исполнительского производства" },
      channels: [{
        id: 11,
        network: "tg",
        title: "Право сегодня",
        handle: "law",
        is_active: true,
      }],
      defaultChannelId: 11,
      busy: false,
      onClose: () => undefined,
      onConfirm: () => undefined,
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain("Социальная сеть");
    expect(html).toContain("Новостной");
    expect(html).toContain("Короткий");
    expect(html).toContain("Экспертный");
    expect(html).toContain("Продающий");
    expect(html).toContain("Создать пост");
  });
});
