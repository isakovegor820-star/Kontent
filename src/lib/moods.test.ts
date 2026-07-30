import { describe, expect, it } from "vitest";
import {
  DEFAULT_MOOD,
  isMoodSelection,
  moodPrompt,
  moodTemp,
  normalizeMoodSelection,
} from "./moods";

describe("редакторские связки настроения", () => {
  it("читает старый одиночный ключ и новый JSON-массив", () => {
    expect(normalizeMoodSelection("bold")).toEqual(["bold"]);
    expect(normalizeMoodSelection('["bold","expert"]')).toEqual(["bold", "expert"]);
  });

  it("удаляет повторы, ограничивает связку тремя и даёт безопасный профиль по умолчанию", () => {
    expect(normalizeMoodSelection(["bold", "expert", "bold", "friendly", "calm"])).toEqual([
      "bold",
      "expert",
      "friendly",
    ]);
    expect(normalizeMoodSelection(["unknown"])).toEqual([DEFAULT_MOOD]);
  });

  it("строго валидирует вход API", () => {
    expect(isMoodSelection(["bold", "expert", "friendly"])).toBe(true);
    expect(isMoodSelection(["bold", "expert", "friendly", "calm"])).toBe(false);
    expect(isMoodSelection(["bold", "bold"])).toBe(false);
    expect(isMoodSelection([])).toBe(false);
  });

  it("объединяет инструкции профилей и усредняет температуру", () => {
    const prompt = moodPrompt(["bold", "expert"]);

    expect(prompt).toContain("Дерзкий + Экспертный");
    expect(prompt).toContain("Редакторский профиль — дерзкий");
    expect(prompt).toContain("Редакторский профиль — экспертный");
    expect(moodTemp(["bold", "expert"])).toBe(0.56);
  });
});
