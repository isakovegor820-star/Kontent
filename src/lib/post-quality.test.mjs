import { describe, expect, it } from "vitest";
import {
  buildQualityPrompt,
  fallbackTopicFromSeed,
  normalizePostQuality,
  presetQuality,
  validatePostQuality,
  validateTopicQuality,
} from "./post-quality.mjs";

const legal = presetQuality("legal");

function goodLegalPost() {
  const paragraphs = [
    "Банкротство требует проверки документов",
    "До начала процедуры специалист сопоставляет состав обязательств, сведения о доходах и имущество, потому что одинаковых финансовых ситуаций не бывает и универсальное обещание результата здесь недопустимо.",
    "Проверенные материалы помогают отделить обстоятельства, которые действительно относятся к делу, от предположений и рекламных формулировок, способных создать у читателя ложное ожидание.",
    "Последовательная подготовка снижает риск пропустить значимый документ: сначала собирают исходные сведения, затем проверяют их актуальность и только после этого определяют подходящий порядок дальнейших действий.",
    "Читателю полезно заранее составить полный список обязательств и сохранить подтверждающие документы, чтобы обсуждение с юристом строилось на фактах, а не на приблизительных воспоминаниях.",
    "Если в материалах есть противоречие, его следует прояснить до подачи документов, поскольку уверенный профессиональный ответ начинается с честного анализа ограничений конкретной ситуации.",
    "Такой подход не обещает простого решения, зато даёт понятную основу для взвешенного решения и помогает задавать специалисту предметные вопросы без давления и спешки.",
    "Итог простой: сначала подтверждённые обстоятельства, затем правовая оценка и только после неё решение о дальнейших шагах.",
    legal.disclaimerText,
  ];
  return paragraphs.join("\n\n");
}

describe("post quality contract", () => {
  it("normalizes unsafe input into supported limits", () => {
    const q = normalizePostQuality({ preset: "legal", minChars: 50, maxChars: 99999, retryLimit: 20 });
    expect(q.minChars).toBe(300);
    expect(q.maxChars).toBe(4000);
    expect(q.retryLimit).toBe(3);
    expect(q.factsPolicy).toBe("source_required");
  });

  it("accepts a legal post only when sources and the editorial frame are satisfied", () => {
    const text = goodLegalPost();
    expect(text.length).toBeGreaterThanOrEqual(legal.minChars);
    expect(text.length).toBeLessThanOrEqual(legal.maxChars);
    const result = validatePostQuality(text, legal, { supportCount: 2, citedShare: 0.9 });
    expect(result.passed).toBe(true);
    expect(result.score).toBe(100);
  });

  it("blocks informal address, missing sources and a missing disclaimer", () => {
    const result = validatePostQuality("Ты можешь. Мы спишем все долги прямо сейчас!", legal, {
      supportCount: 0,
    });
    const codes = result.violations.map((x) => x.code);
    expect(result.passed).toBe(false);
    expect(codes).toContain("address");
    expect(codes).toContain("no_sources");
    expect(codes).toContain("disclaimer");
    expect(codes).toContain("forbidden_phrase");
  });

  it("includes a CTA only at the configured cadence", () => {
    expect(buildQualityPrompt(legal, { postIndex: 0 })).toContain("не добавляй продажный призыв");
    expect(buildQualityPrompt(legal, { postIndex: 4 })).toContain("сегодня нужен мягкий призыв");
  });

  it("rejects clickbait and builds a safe useful topic from a fact", () => {
    const source =
      "Внесудебное банкротство через МФЦ доступно при долге от 25 тысяч до 1 миллиона рублей и занимает шесть месяцев.";
    expect(validateTopicQuality("Новый способ банкротства через МФЦ", source).passed).toBe(false);
    const fallback = fallbackTopicFromSeed(source);
    expect(fallback).toBe("Кому доступно внесудебное банкротство через МФЦ");
    expect(validateTopicQuality(fallback, source).passed).toBe(true);
  });
});
