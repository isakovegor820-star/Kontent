import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  PRODUCT_ALTERNATE_NAMES,
  PRODUCT_DESCRIPTION,
  PRODUCT_DISCLAIMER,
  PRODUCT_FEATURES,
  PRODUCT_NAME,
  PRODUCT_SUMMARY,
  PRODUCT_TAGLINE,
  PRODUCT_TITLE,
} from "./product";

const SRC = fileURLToPath(new URL("..", import.meta.url));

function sourceFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/u.test(entry.name))
    .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`);
}

describe("product facts have exactly one source", () => {
  it("keeps the title and description inside search-engine limits", () => {
    expect(PRODUCT_TITLE.length).toBeLessThanOrEqual(60);
    expect(PRODUCT_DESCRIPTION.length).toBeGreaterThanOrEqual(120);
    expect(PRODUCT_DESCRIPTION.length).toBeLessThanOrEqual(160);
    expect(PRODUCT_TAGLINE.length).toBeLessThanOrEqual(70);
    expect(PRODUCT_TITLE.startsWith(PRODUCT_NAME)).toBe(true);
  });

  it("describes the product the same way in title, description and summary", () => {
    // Все три текста говорят об одном: юридический контент, источники, согласование,
    // Telegram. Если разойдутся — движок получит три разные сущности вместо одной.
    for (const text of [PRODUCT_TAGLINE, PRODUCT_DESCRIPTION, PRODUCT_SUMMARY]) {
      expect(text.toLowerCase()).toContain("юридическ");
    }
    expect(PRODUCT_DESCRIPTION).toContain("Telegram");
    expect(PRODUCT_SUMMARY).toContain("Telegram");
  });

  it("has an alternate name for every script the brand is written in", () => {
    expect(PRODUCT_ALTERNATE_NAMES).toContain("Аврора");
    expect(PRODUCT_ALTERNATE_NAMES).toContain("Aurora");
  });

  it("lists features without duplicates and without promises", () => {
    expect(new Set(PRODUCT_FEATURES).size).toBe(PRODUCT_FEATURES.length);
    expect(PRODUCT_FEATURES.length).toBeGreaterThanOrEqual(5);
    for (const feature of PRODUCT_FEATURES) {
      // Список уходит в featureList разметки: обещания и превосходные степени
      // в структурированных данных читаются как недостоверная реклама.
      expect(feature).not.toMatch(/лучш|самый|№1|номер 1|гарант|100%/iu);
    }
  });

  it("carries the disclaimer that content is not legal advice", () => {
    expect(PRODUCT_DISCLAIMER).toContain("не являются юридической консультацией");
  });

  it("does not inflect the product name by concatenation", () => {
    // «с Аврора» и «командой Аврора» — грамматические ошибки, которые появляются
    // ровно там, где имя подставляется в шаблон. Для таких мест есть
    // PRODUCT_NAME_QUOTED; тест ловит возврат к склейке.
    const broken = sourceFiles()
      .filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => {
        const code = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
          .join("\n");
        return /(с|командой|для|о|от|к)\s*\$\{PRODUCT_NAME\}/u.test(code);
      });

    expect(broken).toEqual([]);
  });

  it("does not let a second product description appear in the app shell", () => {
    // Ловим возврат к прежнему расхождению: четыре описания в четырёх файлах.
    // Модуль product.ts — источник; тесты вправе знать строки, иначе проверять нечего.
    // Комментарии из проверки исключены: пояснение «раньше здесь был другой слоган»
    // полезно и не должно ронять сборку.
    const offenders = sourceFiles()
      .filter((path) => !path.endsWith("/lib/product.ts") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => {
        const code = readFileSync(path, "utf8")
          .split("\n")
          .filter((line) => !/^\s*(\/\/|\/\*|\*)/u.test(line))
          .join("\n");
        return /Content Intelligence|SMM для юридического бизнеса|SMM-платформа для юридического/u.test(code);
      });

    expect(offenders).toEqual([]);
  });
});
