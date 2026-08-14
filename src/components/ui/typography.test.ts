import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { H1, H2, H3, HelperText, Text } from "./typography";

describe("Typography", () => {
  it("maps H1, H2 and H3 to stable semantic roles", () => {
    const html = renderToStaticMarkup(
      createElement("div", null,
        createElement(H1, null, "Первый уровень"),
        createElement(H2, null, "Второй уровень"),
        createElement(H3, null, "Третий уровень"),
      ),
    );

    expect(html).toContain('<h1 data-typography="h1" class="type-h1 text-text">');
    expect(html).toContain('<h2 data-typography="h2" class="type-h2 text-text">');
    expect(html).toContain('<h3 data-typography="h3" class="type-h3 text-text">');
  });

  it("keeps text role and semantic tone independent", () => {
    const secondary = renderToStaticMarkup(
      createElement(Text, { variant: "secondary" }, "Дополнительный текст"),
    );
    const error = renderToStaticMarkup(
      createElement(HelperText, { tone: "danger" }, "Исправьте значение"),
    );

    expect(secondary).toContain('data-typography="secondary"');
    expect(secondary).toContain("type-secondary text-text-2");
    expect(error).toContain('data-typography="helper"');
    expect(error).toContain("type-caption text-danger-text");
    expect(error).not.toContain("text-text-3");
  });

  it("keeps the Helvetica stack and platform hierarchy in the shared CSS contract", () => {
    const globals = readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");
    const platform = readFileSync(path.join(process.cwd(), "src/app/app/app-v3.css"), "utf8");

    expect(globals).toContain('--font-interface: "Helvetica Neue", Helvetica, Arial, sans-serif;');
    expect(globals).toContain("--type-h1-size:");
    expect(globals).toContain("--type-body-size:");
    expect(globals).toContain("--type-input-size: 1rem;");
    expect(platform).toContain(".app-v3 h1,");
    expect(platform).toContain(".app-v3 h2,");
    expect(platform).toContain(".app-v3 h3,");
    expect(platform).toContain("[contenteditable=\"true\"]");
    expect(platform).toContain("font-size: var(--type-button-size) !important;");
    expect(platform).toContain("line-height: var(--type-caption-line);");
  });
});
