import { describe, expect, it } from "vitest";

import {
  audienceQuestionFingerprint,
  buildAudienceQuestionPrompt,
  normalizeAudienceQuestion,
  type AudienceQuestionRecord,
} from "./audience-questions";

const QUESTION: AudienceQuestionRecord = {
  id: 12,
  question: "Как подготовиться к проверке, если уведомление уже пришло?",
  topic: "Проверки",
  priority: 3,
  occurrences: 4,
  status: "new",
  version: 1,
  sourceType: "comment",
  sourceLabel: "Комментарии под постом",
  sourceUrl: "https://example.com/post/1",
  context: "Вопрос задали после разбора нового требования.",
  answerDraftId: null,
  generationRequestKey: null,
  draftClientKey: null,
  firstSeenAt: "2026-08-14T08:00:00.000Z",
  lastSeenAt: "2026-08-14T10:00:00.000Z",
  answeredAt: null,
  createdAt: "2026-08-14T08:00:00.000Z",
  updatedAt: "2026-08-14T10:00:00.000Z",
};

describe("audience questions", () => {
  it("aggregates the same question despite case and spacing differences", () => {
    expect(audienceQuestionFingerprint("  КАК  подготовиться\nк проверке? "))
      .toBe(audienceQuestionFingerprint("как подготовиться к проверке?"));
  });

  it("normalizes whitespace without changing the reader's wording", () => {
    expect(normalizeAudienceQuestion(" Как   это работает?\r\n  Правда? "))
      .toBe("Как это работает?\nПравда?");
  });

  it("builds a post task around the real question and blocks invented facts", () => {
    const prompt = buildAudienceQuestionPrompt(QUESTION);

    expect(prompt).toContain(`Вопрос аудитории: «${QUESTION.question}»`);
    expect(prompt).toContain("Число зафиксированных обращений с этим вопросом: 4");
    expect(prompt).toContain(QUESTION.context);
    expect(prompt).toContain("Не придумывай цифры, даты, имена, нормы или ссылки");
    expect(prompt).toContain("не заменяй его другой темой");
  });
});
