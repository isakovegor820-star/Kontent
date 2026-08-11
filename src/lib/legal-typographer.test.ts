import { describe, expect, it } from "vitest";

import {
  analyzeLegalTypography,
  applyTypographySuggestions,
  typographySnapshotVersion,
} from "./legal-typographer";

describe("legal typographer", () => {
  it("formats safe Russian typography and keeps every protected legal fragment byte-for-byte", () => {
    const source = [
      "Отчёт  --  за 2024-2026 годы и работу в суде.",
      "См. ст. 15.1, дело № А40-12345/2026 от 01-02-2026.",
      "https://example.ru/path?a=1-2 utm@example.ru `const a = 1-2`",
      "«Точная  цитата -- без правок»",
    ].join("\n");
    const suggestions = analyzeLegalTypography(source);
    const result = applyTypographySuggestions(source, suggestions, "safe");

    expect(result).toContain("Отчёт — за 2024–2026 годы и\u00a0работу в\u00a0суде.");
    for (const exact of [
      "ст. 15.1",
      "№ А40-12345/2026",
      "01-02-2026",
      "https://example.ru/path?a=1-2",
      "utm@example.ru",
      "`const a = 1-2`",
      "«Точная  цитата -- без правок»",
    ]) expect(result).toContain(exact);
  });

  it("makes quotation changes explicit and keeps them out of safe auto-apply", () => {
    const source = 'Компания "ТехнологИИ Права" сообщила о событии.';
    expect(analyzeLegalTypography(source).some((item) => item.kind === "quotes")).toBe(false);
    expect(applyTypographySuggestions(source, analyzeLegalTypography(source), "safe")).toContain(
      '"ТехнологИИ Права"',
    );
    const suggestions = analyzeLegalTypography(source, { formatQuotes: true });
    const quote = suggestions.find((item) => item.kind === "quotes");
    expect(quote).toMatchObject({ before: '"ТехнологИИ Права"', after: "«ТехнологИИ Права»", safe: false });
    expect(applyTypographySuggestions(source, suggestions, "safe")).toBe(
      'Компания "ТехнологИИ Права" сообщила о\u00a0событии.',
    );
    expect(applyTypographySuggestions(source, suggestions, [quote!.id])).toBe(
      "Компания «ТехнологИИ Права» сообщила о событии.",
    );
  });

  it("supports canonical and prohibited brand terms without changing domains", () => {
    const source = "legal tech и легалтех доступны на legal-tech.ru";
    const suggestions = analyzeLegalTypography(source, {
      dictionary: [
        { term: "legal tech", canonical: "LegalTech" },
        { term: "легалтех", canonical: "LegalTech", prohibited: true },
      ],
    });
    expect(suggestions.filter((item) => item.kind === "brand_term")).toHaveLength(2);
    expect(applyTypographySuggestions(source, suggestions, "safe")).toBe(
      "LegalTech и\u00a0легалтех доступны на legal-tech.ru",
    );
    expect(applyTypographySuggestions(source, suggestions, suggestions.map((item) => item.id))).toBe(
      "LegalTech и\u00a0LegalTech доступны на legal-tech.ru",
    );
  });

  it("ignores stale suggestion coordinates and emits a stable snapshot version", () => {
    const suggestions = analyzeLegalTypography("1-3 дня");
    expect(applyTypographySuggestions("Изменено: 1-3 дня", suggestions, "safe")).toBe("Изменено: 1-3 дня");
    expect(typographySnapshotVersion(7)).toBe("aurora-ru-typographer-v1:dictionary-7");
  });
});
