import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { LEGAL_LINKS } from "./legal-links";

/** Корень репозитория: файл лежит в src/components/legal. */
const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

/**
 * Сторож: у каждого подвала в проекте должны быть правовые ссылки.
 *
 * Причина теста на исходниках, а не на разметке: подвалов шесть, они живут
 * в разных системах стилей (Tailwind, CSS-модули, v3), и раньше ссылки были
 * только в одном из них — «Политика данных» в сокращённом подвале вообще
 * печаталась текстом без адреса. Проверка на уровне файла ловит и новый подвал,
 * добавленный без ссылок, если его внести в список.
 */
const FOOTER_SOURCES = [
  "src/components/landing/aurora/footer.tsx",
  "src/components/landing/final-cta.tsx",
  "src/components/v3/final-cta.tsx",
  "src/components/v3/production-footer.tsx",
  "src/components/legal/legal-document.tsx",
  "src/components/app/shell.tsx",
  "src/app/admin/layout.tsx",
];

describe("legal links are wired into every footer", () => {
  it("lists the documents the platform must keep reachable", () => {
    const hrefs = LEGAL_LINKS.map((link) => link.href);
    expect(hrefs).toContain("/privacy");
    expect(hrefs).toContain("/consent");
    expect(hrefs).toContain("/cookies");
    expect(hrefs).toContain("/personal-data");
    expect(hrefs).toContain("/terms");
    // Ссылки не дублируются: один документ — одна запись в подвале.
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it.each(FOOTER_SOURCES)("%s uses the shared legal links", (path) => {
    const source = readFileSync(`${ROOT}${path}`, "utf8");
    expect(source).toContain("LegalLinks");
  });

  it("does not keep a hardcoded legal link list in the short footer", () => {
    // Раньше здесь был массив ["Политика данных", "Условия"], который рисовался
    // как <span>: пользователь видел «ссылку», по которой нельзя перейти.
    const source = readFileSync(`${ROOT}src/components/landing/final-cta.tsx`, "utf8");
    expect(source).not.toContain('const LEGAL = ["Политика данных"');
  });
});
