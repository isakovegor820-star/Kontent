import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const NONCE = "test-nonce-abc123";

vi.mock("next/headers", () => ({
  headers: async () => new Map([["x-nonce", NONCE]]),
}));

const { JsonLd } = await import("./json-ld");

const SRC = fileURLToPath(new URL("../..", import.meta.url));

describe("JSON-LD carries the request nonce", () => {
  it("binds every rendered script to the request nonce", async () => {
    // Проверка релиза требует, чтобы каждый <script> в документе нёс nonce из CSP.
    // Скрипты Next размечает сам, а JSON-LD размечает этот компонент.
    const markup = renderToStaticMarkup(await JsonLd({ value: { "@type": "Organization", name: "Аврора" } }));

    expect(markup).toContain(`nonce="${NONCE}"`);
    expect(markup).toContain('type="application/ld+json"');
    expect(markup).toContain('"@type":"Organization"');
  });

  it("still escapes «<» so a value cannot break out of the script block", async () => {
    const markup = renderToStaticMarkup(
      await JsonLd({ value: { "@type": "Thing", name: "</script><script>alert(1)</script>" } }),
    );
    expect(markup).not.toContain("</script><script>alert(1)");
    expect(markup).toContain("\\u003c");
  });

  it("keeps JSON-LD rendering in exactly one place", () => {
    // Прямой <script type="application/ld+json"> в компоненте означал бы скрипт без
    // nonce — именно так релиз aa5a3a4 откатился на проверке
    // deployment_smoke_nonce_binding_failed. Возврат к этому ловится здесь.
    const offenders = readdirSync(SRC, { withFileTypes: true, recursive: true })
      .filter((entry) => entry.isFile() && /\.(ts|tsx)$/u.test(entry.name))
      .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`)
      .filter((path) => !path.endsWith("/components/seo/json-ld.tsx") && !path.endsWith(".test.tsx") && !path.endsWith(".test.ts"))
      .filter((path) => {
        // Комментарии исключены: упоминание тега в пояснении не является его рендером.
        const code = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
          .join("\n");
        return /type="application\/ld\+json"/u.test(code);
      });

    expect(offenders).toEqual([]);
  });
});
