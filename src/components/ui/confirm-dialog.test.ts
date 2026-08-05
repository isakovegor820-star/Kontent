import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

describe("ConfirmDialog", () => {
  it("renders an explicitly labelled modal confirmation with safe cancel first", () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, {
      open: true,
      title: "Удалить черновик?",
      description: "Удаление нельзя отменить.",
      confirmLabel: "Удалить черновик",
      cancelLabel: "Оставить",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    }));

    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toMatch(/aria-labelledby="[^"]+"/);
    expect(html).toMatch(/aria-describedby="[^"]+"/);
    expect(html).toContain("Удалить черновик?");
    expect(html).toContain("Удаление нельзя отменить.");
    expect(html.indexOf("Оставить")).toBeLessThan(html.indexOf("Удалить черновик</button>"));
  });

  it("renders nothing before confirmation is requested", () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, {
      open: false,
      title: "Удалить черновик?",
      description: "Удаление нельзя отменить.",
      confirmLabel: "Удалить",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    }));
    expect(html).toBe("");
  });
});
