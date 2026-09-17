import { describe, expect, it } from "vitest";

import { DEFAULT_POST_SETTINGS } from "./post-settings";
import { inferContentLanguage, postSettingsForSourceLanguage } from "./content-language";

describe("content language", () => {
  it("detects substantial English and Russian prose", () => {
    expect(inferContentLanguage("Build your first working product without waiting for perfect conditions.")).toBe("en");
    expect(inferContentLanguage("Собери первый рабочий продукт, не дожидаясь идеальных условий.")).toBe("ru");
  });

  it("keeps saved settings for short or genuinely mixed text", () => {
    expect(inferContentLanguage("Aurora AI")).toBeNull();
    expect(inferContentLanguage("Аврора makes content быстрее")).toBeNull();
    expect(postSettingsForSourceLanguage(
      { ...DEFAULT_POST_SETTINGS, language: "ru" },
      "Aurora AI",
    ).language).toBe("ru");
  });

  it("does not let URLs or email addresses override the prose language", () => {
    expect(inferContentLanguage(
      "Подробности и регистрация: https://english-product.example.com/launch/very-long-campaign",
    )).toBe("ru");
    expect(inferContentLanguage(
      "Напишите нам на international-partnerships@example.com, и мы ответим сегодня.",
    )).toBe("ru");
  });

  it("makes every editor action follow the current post language", () => {
    const settings = postSettingsForSourceLanguage(
      { ...DEFAULT_POST_SETTINGS, language: "auto" },
      "This post is already written in English, so every transformation must stay in English.",
    );
    expect(settings.language).toBe("en");
  });
});
