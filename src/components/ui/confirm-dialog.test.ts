// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfirmDialog } from "./confirm-dialog";

afterEach(cleanup);

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

  it("isolates the background and restores page scroll and focus when closed", async () => {
    const props = { title: "Confirm fixture", description: "Fixture", confirmLabel: "Confirm", onConfirm: vi.fn(), onCancel: vi.fn() };
    const view = render(createElement("div", null, createElement("button", null, "Outside"), createElement(ConfirmDialog, { ...props, open: false })));
    const outside = screen.getByRole("button", { name: "Outside" });
    outside.focus();
    const originalOverflow = document.body.style.overflow;
    view.rerender(createElement("div", null, createElement("button", null, "Outside"), createElement(ConfirmDialog, { ...props, open: true })));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Отмена" })));
    expect(outside.inert).toBe(true);
    expect(document.body.style.overflow).toBe("hidden");
    view.rerender(createElement("div", null, createElement("button", null, "Outside"), createElement(ConfirmDialog, { ...props, open: false })));
    expect(Boolean(outside.inert)).toBe(false);
    expect(document.body.style.overflow).toBe(originalOverflow);
    expect(document.activeElement).toBe(outside);
  });
});
