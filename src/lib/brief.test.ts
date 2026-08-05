import { describe, expect, it } from "vitest";

import {
  AUTHOR_PROFILE_QUESTION_COUNT,
  AUTHOR_PROFILE_SECTIONS,
  briefContext,
  normalizeBrief,
} from "./brief";

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

  it("keeps exactly 26 known questionnaire answers and adds filled answers to the AI context", () => {
    expect(AUTHOR_PROFILE_QUESTION_COUNT).toBe(26);
    expect(AUTHOR_PROFILE_SECTIONS.flatMap((section) => section.questions)).toHaveLength(26);

    const brief = normalizeBrief({
      niche: "Право",
      audience: "Бизнес",
      profile_answers: {
        q1: "Практическое право для предпринимателей",
        q26: "Можно рассказывать о десяти годах судебной практики",
        q27: "Это поле не существует",
      },
    });

    expect(brief.profileAnswers).toEqual({
      q1: "Практическое право для предпринимателей",
      q26: "Можно рассказывать о десяти годах судебной практики",
    });
    expect(briefContext(brief)).toContain("1. О чём ваш канал одним простым предложением?");
    expect(briefContext(brief)).toContain("26. Какие факты из вашей биографии можно использовать в публикациях?");
    expect(briefContext(brief)).not.toContain("Это поле не существует");
  });
});
