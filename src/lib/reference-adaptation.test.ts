import { describe, expect, it } from "vitest";

import type { ServerDraft } from "./draft-types";
import {
  buildReferenceAdaptationTask,
  referenceAdaptationContextFromDraft,
  sanitizeSemanticIntent,
  validateTopicAlignment,
  type TopicAlignmentAdapter,
} from "./reference-adaptation";

const semanticAdapter: TopicAlignmentAdapter = {
  id: "test-topic-semantic-v1",
  async checkTopicAlignment({ text }) {
    const unrelated = /(?:конференц|кофе|рыбалк)/iu.test(text);
    return unrelated
      ? { verdict: "misaligned", confidence: 0.99, reasonCode: "unrelated_subject" }
      : { verdict: "aligned", confidence: 0.95, reasonCode: "subject_developed" };
  },
};

function draft(overrides: Partial<ServerDraft> = {}): ServerDraft {
  return {
    id: 71,
    text: "Исполнительский иммунитет защищает необходимое имущество должника.",
    media: null,
    scheduled_at: null,
    origin: "trend",
    purpose: "source_context",
    source_ref: {
      kind: "trend",
      id: "9",
      label: "Юридический тренд",
      topic: "Исполнительский иммунитет необходимого имущества должника",
    },
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
  it("keeps a server-owned trend topic and rejects an unrelated conference post", async () => {
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
    await expect(validateTopicAlignment(
      "Исполнительский иммунитет помогает отделить необходимое имущество от остальной конкурсной массы.",
      context,
      { adapter: semanticAdapter },
    )).resolves.toMatchObject({ status: "passed", semanticAdapter: "test-topic-semantic-v1" });
    await expect(validateTopicAlignment(
      "Открываем продажи билетов на ежегодную конференцию о технологиях права.",
      context,
      { adapter: semanticAdapter },
    )).resolves.toMatchObject({ status: "failed", reasonCode: "unrelated_subject" });
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
      source_ref: {
        kind: "reference",
        id: "91",
        label: "Открытый источник",
        topic: "Ошибки в договоре поставки",
      },
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

  it("does not infer a replacement topic from a generic hook or later body sentence", () => {
    const context = referenceAdaptationContextFromDraft(draft({
      text: "Вы тоже это делаете?\n\nИсполнительский иммунитет защищает необходимое для жизни имущество должника.",
      source_ref: {
        kind: "trend",
        id: "92",
        label: "Тренд",
        topic: "Защита необходимого имущества должника",
      },
    }))!;

    expect(context.topic).toBe("Защита необходимого имущества должника");
    expect(context.topic).not.toBe("Вы тоже это делаете?");
  });

  it("delegates legal synonyms and token stuffing to a semantic classifier", async () => {
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

    await expect(validateTopicAlignment(
      "Защита единственной квартиры должника от обращения взыскания сохраняет необходимое жильё, хотя границы правила зависят от обстоятельств.",
      context,
      { adapter: semanticAdapter },
    )).resolves.toMatchObject({ status: "passed" });
    await expect(validateTopicAlignment(
      "Как выбрать обжарку кофе и настроить кофемолку. Исполнительский иммунитет единственного жилья — важная тема.",
      context,
      { adapter: semanticAdapter },
    )).resolves.toMatchObject({ status: "failed" });
    await expect(validateTopicAlignment(
      "Конференция по искусственному интеллекту открывает регистрацию для участников.",
      context,
      { adapter: semanticAdapter },
    )).resolves.toMatchObject({ status: "failed" });
  });

  it("fails closed when semantic alignment is unavailable", async () => {
    const context = referenceAdaptationContextFromDraft(draft())!;
    await expect(validateTopicAlignment("Текст на нужную тему", context)).resolves.toMatchObject({
      status: "failed",
      score: 0,
      semanticAdapter: "unavailable",
      reasonCode: "semantic_check_unavailable",
    });
  });

  it("refuses an ambiguous body without explicit server-owned topic metadata", () => {
    expect(referenceAdaptationContextFromDraft(draft({
      text: "Вы тоже это делаете? Второе предложение внезапно говорит о банкротстве. Третье — о конференции.",
      source_ref: { kind: "trend", id: "ambiguous", label: "Тренд" },
    }))).toBeNull();
  });
});
