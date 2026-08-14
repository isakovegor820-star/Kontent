import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, buttonClassName, canonicalButtonVariant } from "./button";

describe("Button", () => {
  it("normalizes old variants into the shared semantic roles", () => {
    expect(canonicalButtonVariant("brand")).toBe("primary");
    expect(canonicalButtonVariant("solid")).toBe("primary");
    expect(canonicalButtonVariant("soft")).toBe("secondary");
    expect(canonicalButtonVariant("outline")).toBe("secondary");
  });

  it("renders a blue primary action with the shared interaction states", () => {
    const html = renderToStaticMarkup(createElement(Button, { variant: "primary" }, "Сохранить"));

    expect(html).toContain('type="button"');
    expect(html).toContain('data-variant="primary"');
    expect(html).toContain("bg-brand");
    expect(html).toContain("not(:disabled):hover");
    expect(html).toContain("bg-brand-hover");
    expect(html).toContain("not(:disabled):active");
    expect(html).toContain("bg-brand-active");
    expect(html).toContain("scale-[0.96]");
  });

  it("keeps the label visible and distinguishes loading from disabled", () => {
    const loading = renderToStaticMarkup(createElement(Button, { loading: true }, "Сохранить"));
    const disabled = renderToStaticMarkup(createElement(Button, { disabled: true }, "Сохранить"));

    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('data-loading="true"');
    expect(loading).toContain("cursor-wait");
    expect(loading).toContain("Сохранить");
    expect(loading).not.toContain("disabled:opacity-45");
    expect(disabled).toContain("disabled:opacity-45");
  });

  it("keeps secondary actions neutral and destructive actions red", () => {
    expect(buttonClassName({ variant: "secondary" })).toContain("bg-surface");
    expect(buttonClassName({ variant: "danger" })).toContain("bg-danger-soft");
  });
});
