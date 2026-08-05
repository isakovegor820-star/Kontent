import { describe, expect, it } from "vitest";

import { briefContext, normalizeBrief } from "./brief";

describe("content brief profile fields", () => {
  it("normalizes formats and the author role in the existing content_brief contract", () => {
    const brief = normalizeBrief({
      niche: "Право",
      audience: "Бизнес",
      rubrics: ["Практика", "Практика"],
      formats: ["Видео", "Текст", "Видео"],
      author_role: "Управляющий партнёр",
      ready: true,
      source: "manual",
    });
    expect(brief.formats).toEqual(["Видео", "Текст"]);
    expect(brief.authorRole).toBe("Управляющий партнёр");
    expect(briefContext(brief)).toContain("— роль автора: Управляющий партнёр");
    expect(briefContext(brief)).toContain("— форматы публикаций: Видео, Текст");
  });
});
