import { describe, expect, it } from "vitest";

import type { ServerDraft } from "./draft-types";
import {
  buildReferenceAdaptationTask,
  referenceAdaptationContextFromDraft,
  sanitizeSemanticIntent,
  validateTopicAlignment,
} from "./reference-adaptation";

function draft(overrides: Partial<ServerDraft> = {}): ServerDraft {
  return {
    id: 71,
    text: "Исполнительский иммунитет защищает необходимое имущество должника.",
    media: null,
    scheduled_at: null,
    origin: "trend",
    purpose: "source_context",
    source_ref: { kind: "trend", id: "9", label: "Юридический тренд" },
    generation_result_id: null,
    generation_binding_valid: false,
    client_key: "draft_reference_adaptation_71",
    version: 3,
    review_policy_version: 1,
    ai_validation: null,
    human_review: null,
    created_at: "2026-08-05T10:00:00.000Z",
    updated_at: "2026-08-05T10:00:00.000Z",
    destinations: [{
      channel_id: 42,
      network: "tg",
      title: "Технологии Права",
      handle: "legal",
      is_active: true,
    }],
    ...overrides,
  };
}

describe("reference adaptation context", () => {
  it("keeps a trend topic as semantic intent and rejects an unrelated conference post", () => {
    const context = referenceAdaptationContextFromDraft(draft())!;
    const task = buildReferenceAdaptationTask(context, "Технологии Права");

    expect(context).toMatchObject({
      draftId: 71,
      version: 3,
      kind: "trend",
      topic: expect.stringContaining("Исполнительский иммунитет"),
      mode: "same_topic_original_post",
    });
    expect(task).toContain("Исполнительский иммунитет");
    expect(validateTopicAlignment(
      "Исполнительский иммунитет помогает отделить необходимое имущество от остальной конкурсной массы.",
      context,
    ).status).toBe("passed");
    expect(validateTopicAlignment(
      "Открываем продажи билетов на ежегодную конференцию о технологиях права.",
      context,
    ).status).toBe("failed");
  });

  it("preserves an idea as idea with explicit topic and separate provenance/mechanics", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      origin: "idea",
      text: "Ошибки в договоре поставки\n\nНачните с вопроса\n\nПроблема → решение",
      source_ref: {
        kind: "idea",
        id: "81",
        label: "Идея Авроры",
        topic: "Ошибки в договоре поставки",
        hook: "Начните с вопроса",
        structure: "Проблема → решение",
        whyItWorked: "Читатель узнаёт риск",
        provenance: { kind: "content_idea", id: "competitor:9", label: "Источник идеи" },
      },
    }))!;

    expect(context.kind).toBe("idea");
    expect(context.topic).toBe("Ошибки в договоре поставки");
    expect(context.mechanics).toEqual({
      hook: "Начните с вопроса",
      structure: "Проблема → решение",
      whyItWorked: "Читатель узнаёт риск",
    });
  });

  it("does not promote a reference date, name or number into the sanitized topic", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      origin: "competitor",
      text: "15.09.2026 Иван Петров назвал 136 ошибок в договоре поставки. Полный разбор по ссылке https://example.com/source",
      source_ref: { kind: "reference", id: "91", label: "Открытый источник" },
    }))!;

    expect(context.kind).toBe("reference");
    expect(context.sourceText).toContain("Иван Петров");
    expect(context.topic).toContain("договоре поставки");
    expect(context.topic).not.toMatch(/15|2026|136|Иван|Петров|https/u);
    expect(sanitizeSemanticIntent(context.sourceText)).not.toMatch(/136|Иван Петров|https/u);
  });

  it("promotes only a server-curated legal RSS source into factual grounding", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      origin: "rss",
      text: "Суд разъяснил порядок применения обеспечительных мер.",
      source_ref: {
        kind: "rss",
        id: "108",
        label: "Официальные правовые новости",
        topic: "Обеспечительные меры",
        factualGrounding: "curated_legal_source",
        provenance: {
          kind: "rss_item",
          id: "108",
          label: "Официальные правовые новости",
          url: "https://example.test/legal/108",
        },
      },
    }))!;

    expect(context.factualGrounding).toEqual({
      id: "108",
      label: "Официальные правовые новости",
      text: "Суд разъяснил порядок применения обеспечительных мер.",
      url: "https://example.test/legal/108",
    });
    expect(buildReferenceAdaptationTask(context)).toContain("Используй только факты, прямо указанные");
  });

  it("does not mistake a generic hook for the source subject", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      text: "Вы тоже это делаете?\n\nИсполнительский иммунитет защищает необходимое для жизни имущество должника.",
      source_ref: { kind: "trend", id: "92", label: "Тренд" },
    }))!;

    expect(context.topic).toContain("Исполнительский иммунитет");
    expect(context.topic).not.toBe("Вы тоже это делаете?");
  });

  it("accepts Russian legal synonyms but rejects exact-topic token stuffing", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      source_ref: {
        kind: "trend",
        id: "93",
        label: "Юридическая тема",
        topic: "Исполнительский иммунитет единственного жилья",
        readerProblem: "Владелец боится потерять единственное жильё из-за долга",
        semanticGoal: "Объяснить общий принцип без юридических обещаний",
      },
    }))!;

    expect(validateTopicAlignment(
      "Защита единственной квартиры должника от обращения взыскания сохраняет необходимое жильё, хотя границы правила зависят от обстоятельств.",
      context,
    ).status).toBe("passed");
    expect(validateTopicAlignment(
      "Как выбрать обжарку кофе и настроить кофемолку. Исполнительский иммунитет единственного жилья — важная тема.",
      context,
    ).status).toBe("failed");
    expect(validateTopicAlignment(
      "Конференция по искусственному интеллекту открывает регистрацию для участников.",
      context,
    ).status).toBe("failed");
  });
});
