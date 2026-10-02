import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { CONTACT_DOMAIN_CONFIRMED, CONTACT_EMAIL, LEGAL_EMAIL, SUPPORT_EMAIL } from "./contact";

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Все .ts/.tsx под src/, чтобы сторож видел и новые файлы, а не только известные сегодня. */
function sourceFiles(dir = SRC) {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/u.test(entry.name))
    .map((entry) => `${entry.parentPath ?? entry.path}/${entry.name}`);
}

describe("contact addresses live in exactly one place", () => {
  it("keeps every public address in lib/contact.ts", () => {
    const offenders = sourceFiles()
      // Сам модуль — источник. Тесты вправе знать значение, иначе проверять нечего.
      .filter((path) => !path.endsWith("/lib/contact.ts") && !path.endsWith(".test.ts") && !path.endsWith(".test.tsx"))
      .filter((path) => readFileSync(path, "utf8").includes("@avrora.app"));

    // Адрес, продублированный в компоненте, переживёт смену домена и останется в проде.
    expect(offenders).toEqual([]);
  });

  it("keeps the three addresses distinct and well formed", () => {
    const addresses = [CONTACT_EMAIL, SUPPORT_EMAIL, LEGAL_EMAIL];
    expect(new Set(addresses).size).toBe(3);
    for (const address of addresses) {
      expect(address).toMatch(/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/iu);
    }
  });

  it("does not let the open domain question pass silently", () => {
    // Флаг снимается только вместе с решением владельца о домене контактов.
    // Пока он false, карточка фактов не публикует домен как официальный.
    // Тест фиксирует состояние, а не запрещает изменение: поменяли домен —
    // поменяйте и флаг, и комментарий в lib/contact.ts.
    expect(CONTACT_DOMAIN_CONFIRMED).toBe(false);
  });
});
