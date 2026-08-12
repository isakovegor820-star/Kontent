import { describe, expect, it } from "vitest";

import {
  analyzeLegalTypography,
  applyTypographySuggestions,
  TYPOGRAPHY_RULES_VERSION,
  typographySnapshotVersion,
} from "./legal-typographer";

describe("legal typographer", () => {
  it("formats safe Russian typography and keeps every protected legal fragment byte-for-byte", () => {
    const source = [
      "Отчёт  --  за 2024-2026 годы и работу в суде.",
      "См. ч. 2 ст. 15.1, дело № А40-12345/2026 от 01-02-2026.",
      "https://example.ru/path?a=1-2 utm@example.ru utm_campaign=law-2026 `const a = 1-2`",
      "«Точная  цитата -- с диапазоном 1-2»",
    ].join("\n");
    const suggestions = analyzeLegalTypography(source);
    const result = applyTypographySuggestions(source, suggestions, "safe");

    expect(result).toContain("Отчёт — за\u00a02024–2026 годы и\u00a0работу в\u00a0суде.");
    for (const exact of [
      "ч. 2 ст. 15.1",
      "дело № А40-12345/2026",
      "01-02-2026",
      "https://example.ru/path?a=1-2",
      "utm@example.ru",
      "utm_campaign=law-2026",
      "`const a = 1-2`",
      "«Точная  цитата -- с диапазоном 1-2»",
    ]) expect(result).toContain(exact);
  });

  it("keeps Russian nested exact quotes protected until explicit quote permission is enabled", () => {
    const source = 'Компания сообщила: "Суд отметил: "довод отклонён"."';
    expect(analyzeLegalTypography(source).some((item) => item.kind === "quotes")).toBe(false);
    expect(applyTypographySuggestions(source, analyzeLegalTypography(source), "safe")).toBe(source);

    const suggestions = analyzeLegalTypography(source, { formatQuotes: true });
    const quote = suggestions.find((item) => item.kind === "quotes");
    expect(quote).toMatchObject({
      before: '"Суд отметил: "довод отклонён"."',
      after: "«Суд отметил: „довод отклонён“.»",
      safe: false,
      rule: "quotes.russian-nested",
    });
    expect(applyTypographySuggestions(source, suggestions, "safe")).toBe(source);
    expect(applyTypographySuggestions(source, suggestions, [quote!.id])).toBe(
      "Компания сообщила: «Суд отметил: „довод отклонён“.»",
    );
  });

  it("supports every project dictionary rule without changing domains or exceptions", () => {
    const source = "legal tech, легалтех, LT и Legal Technology доступны на legal-tech.ru; Исключение  --  дословно";
    const dictionary = [
      { id: 1, kind: "canonical" as const, term: "legal tech", replacement: "LegalTech" },
      { id: 2, kind: "prohibited" as const, term: "легалтех", replacement: "LegalTech" },
      { id: 3, kind: "abbreviation" as const, term: "LT", replacement: "LegalTech", expansion: "Legal technology" },
      { id: 4, kind: "allowed" as const, term: "Legal Technology", replacement: null },
      { id: 5, kind: "exception" as const, term: "Исключение  --  дословно", replacement: null },
    ];
    const suggestions = analyzeLegalTypography(source, { dictionary });
    expect(suggestions.filter((item) => item.kind === "brand_term")).toHaveLength(3);
    expect(suggestions.find((item) => item.dictionaryKind === "prohibited")?.safe).toBe(false);
    expect(suggestions.find((item) => item.dictionaryKind === "abbreviation")?.safe).toBe(false);

    expect(applyTypographySuggestions(source, suggestions, "safe")).toBe(
      "LegalTech, легалтех, LT и\u00a0Legal Technology доступны на\u00a0legal-tech.ru; Исключение  --  дословно",
    );
    expect(applyTypographySuggestions(source, suggestions, suggestions.map((item) => item.id))).toContain(
      "LegalTech, LegalTech, LegalTech и\u00a0Legal Technology доступны на\u00a0legal-tech.ru",
    );
    expect(applyTypographySuggestions(source, suggestions, suggestions.map((item) => item.id))).toContain(
      "Исключение  --  дословно",
    );
  });

  it("fixes only allowlisted hyphens and unambiguous typos", () => {
    const source = "Вообщем, кто - то решил, во - первых, учавствовать.";
    const suggestions = analyzeLegalTypography(source);
    expect(suggestions.map((item) => item.kind)).toEqual(expect.arrayContaining(["typo", "hyphen"]));
    expect(applyTypographySuggestions(source, suggestions, "safe")).toBe(
      "В общем, кто-то решил, во-первых, участвовать.",
    );
  });

  it("does not mistake case numbers, articles, domains, emails or dates for ranges", () => {
    const source = "ст. 15.1; № А40-12345/2026; example.ru; law@example.ru; 01.02.2026; 2026-08-12; срок 3-5 дней";
    const result = applyTypographySuggestions(source, analyzeLegalTypography(source), "safe");
    expect(result).toContain("ст. 15.1");
    expect(result).toContain("№ А40-12345/2026");
    expect(result).toContain("example.ru");
    expect(result).toContain("law@example.ru");
    expect(result).toContain("01.02.2026");
    expect(result).toContain("2026-08-12");
    expect(result).toContain("срок 3–5 дней");
  });

  it("ignores stale suggestion coordinates and emits a stable snapshot version", () => {
    const suggestions = analyzeLegalTypography("1-3 дня");
    expect(applyTypographySuggestions("Изменено: 1-3 дня", suggestions, "safe")).toBe("Изменено: 1-3 дня");
    expect(TYPOGRAPHY_RULES_VERSION).toBe("aurora-ru-typographer-v2");
    expect(typographySnapshotVersion(7)).toBe("aurora-ru-typographer-v2:dictionary-7");
  });
});
