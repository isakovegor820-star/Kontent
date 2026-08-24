import { createElement } from "react";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

const source = readFileSync(new URL("./confirm-dialog.tsx", import.meta.url), "utf8");

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

  it("supports a primary confirmation for non-destructive actions", () => {
    const html = renderToStaticMarkup(createElement(ConfirmDialog, {
      open: true,
      title: "Добавить посты в календарь?",
      description: "Проверь даты перед подтверждением.",
      confirmLabel: "Добавить в календарь",
      confirmVariant: "primary",
      onConfirm: vi.fn(),
      onCancel: vi.fn(),
    }));

    expect(html).toContain('data-variant="primary"');
    expect(html).toContain("Добавить в календарь");
  });

  it("isolates the background and locks page scroll while open", () => {
    expect(source).toContain("sibling.inert = true");
    expect(source).toContain("element.inert = wasInert");
    expect(source).toContain('document.body.style.overflow = "hidden"');
    expect(source).toContain("document.body.style.overflow = previousOverflow");
    expect(source).toContain("overscroll-contain");
  });
});
