// Контракт языка промпта: значения настроек уходят модели по-русски.
//
// Раньше часть полей подставлялась машинными слагами: в русском контракте появлялись
// «угол подачи: personal_story», «сленг high», «провокация low». Одинаковые слаги
// (none/low/medium/high) у разных полей без подписи неразличимы, а англоязычная
// инструкция внутри русского промпта повышает шанс, что модель проигнорирует настройку.
// Тест падает, если слаг снова просочится в текст промпта.

import { describe, expect, it } from "vitest";

import { buildPostSettingsPrompt } from "@/lib/post-settings";

const RU = { network: "vk" } as const;

describe("язык промпта настроек публикации", () => {
  it("подставляет человеческие подписи вместо машинных слагов", () => {
    const prompt = buildPostSettingsPrompt(
      {
        salesAngle: "personal_story",
        persuasionFormula: "problem_consequence_solution",
        riskReducer: "consultation",
        seriesStage: "finish",
        trafficType: "paid",
        audienceTemperature: "hot",
        funnelStage: "objection",
        touchType: "final",
        relevance: "news",
        emojiPlacement: "line_end",
        styleMatch: "maximum",
        sentenceLength: "mixed",
        slangLevel: "high",
        metaphorLevel: "medium",
        anglicisms: "none",
        rhetoricalQuestions: "medium",
        provocationLevel: "high",
        originalityDepth: "all",
        similarityLevel: "strict",
        variantChange: "sales_angle",
        urgency: "price_increase",
        urgencyReason: "цена вырастет 1 октября",
        salesAngleNote: undefined,
      },
      RU,
    );

    expect(prompt).toContain("угол подачи: через личную историю");
    expect(prompt).toContain("формула убеждения: проблема → последствия → решение");
    expect(prompt).toContain("снижение риска: бесплатная консультация");
    expect(prompt).toContain("серия: завершение серии");
    expect(prompt).toContain("трафик: рекламный");
    expect(prompt).toContain("температура аудитории: горячая");
    expect(prompt).toContain("этап воронки: возражение");
    expect(prompt).toContain("тип касания: финальное касание");
    expect(prompt).toContain("актуальность: новостная");
    expect(prompt).toContain("расположение: в конце строк");
    expect(prompt).toContain("сходство с голосом: максимально близко к образцам");
    expect(prompt).toContain("длина предложений: разный ритм");
    expect(prompt).toContain("сленг: высокий");
    expect(prompt).toContain("метафоры: средний");
    expect(prompt).toContain("англицизмы: не использовать");
    expect(prompt).toContain("риторические вопросы: умеренно");
    expect(prompt).toContain("провокация: высокий, без хамства");
    expect(prompt).toContain("допустимая похожесть: строгая");
    expect(prompt).toContain("сравни с всеми доступными публикациями");
    expect(prompt).toContain("измени его так: новый угол продажи");
    expect(prompt).toContain("срочность: повышение цены");
  });

  it("не оставляет в промпте машинных слагов перечисленных полей", () => {
    const prompt = buildPostSettingsPrompt(
      {
        salesAngle: "personal_story",
        persuasionFormula: "problem_consequence_solution",
        riskReducer: "consultation",
        seriesStage: "finish",
        funnelStage: "objection",
        emojiPlacement: "line_end",
        styleMatch: "maximum",
        sentenceLength: "mixed",
        anglicisms: "none",
        provocationLevel: "high",
        originalityDepth: "100",
        similarityLevel: "moderate",
        variantChange: "sales_angle",
        urgency: "price_increase",
        urgencyReason: "цена вырастет 1 октября",
        avoidRepetitions: ["hooks", "structure"],
        proofs: [
          {
            id: "p1",
            type: "product_fact",
            text: "12 клиентов за год",
            source: "CRM",
            validAt: "2026",
            required: true,
            allowClientName: false,
            allowParaphrase: true,
          },
        ],
      },
      RU,
    );

    for (const slug of [
      "personal_story",
      "problem_consequence_solution",
      "sales_angle",
      "price_increase",
      "line_end",
      "lost_opportunity",
      "creative_no_new_facts",
      "product_fact",
      "rhetoricalQuestions",
      "provocationLevel",
      "slangLevel",
      "metaphorLevel",
      "styleMatch",
      "sentenceLength",
      "originalityDepth",
      "similarityLevel",
      "variantChange",
      "audienceTemperature",
      "funnelStage",
      "touchType",
    ]) {
      expect(prompt, `слаг ${slug} не должен попадать в промпт`).not.toContain(slug);
    }
  });

  it("называет состав доказательства и повторов по-русски", () => {
    const prompt = buildPostSettingsPrompt(
      {
        proofs: [
          {
            id: "p1",
            type: "research",
            text: "исследование рынка 2026",
            source: "отчёт",
            validAt: "",
            required: false,
            allowClientName: false,
            allowParaphrase: false,
          },
        ],
        avoidRepetitions: ["hooks", "stories", "phrases"],
      },
      RU,
    );
    expect(prompt).toContain("[исследование]");
    expect(prompt).toContain("не повторяй начала постов, истории, ключевые формулировки");
  });
});
