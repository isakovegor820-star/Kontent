import { describe, expect, it } from "vitest";

import {
  classifyLegalOpportunity,
  cleanLegalSourceText,
  isLikelyLegalOpportunity,
  legalOpportunityFingerprint,
} from "./legal-opportunities";

const NOW = Date.parse("2026-08-13T10:00:00.000Z");

describe("legal opportunities", () => {
  it("separates a bill from an enacted rule", () => {
    const result = classifyLegalOpportunity({
      title: "В Госдуму внесли законопроект о новых правилах банкротства",
      summary: "Авторы предлагают изменить порядок работы с должниками.",
      feedTitle: "Юридические новости",
      publishedAt: "2026-08-13T08:00:00.000Z",
      fetchedAt: "2026-08-13T08:10:00.000Z",
    }, NOW);

    expect(result.status).toBe("Законопроект");
    expect(result.practice).toBe("Банкротство");
    expect(result.whyImportant).toContain("ещё могут измениться");
  });

  it("marks a recent deadline-sensitive change as high priority", () => {
    const result = classifyLegalOpportunity({
      title: "Новые налоговые правила вступают в силу",
      summary: "Компаниям нужно проверить срок подачи декларации.",
      feedTitle: "ГАРАНТ.РУ",
      publishedAt: "2026-08-13T07:00:00.000Z",
      fetchedAt: "2026-08-13T07:05:00.000Z",
    }, NOW);

    expect(result.status).toBe("Вступает в силу");
    expect(result.practice).toBe("Налоги");
    expect(result.priority).toBe("high");
  });

  it("recognizes specialist practices from regulator language", () => {
    const result = classifyLegalOpportunity({
      title: "Банк России обновил требования к участникам финансового рынка",
      summary: "Изменения затрагивают кредитные организации и раскрытие информации о ценных бумагах.",
      feedTitle: "Банк России",
      publishedAt: "2026-08-13T07:00:00.000Z",
      fetchedAt: "2026-08-13T07:05:00.000Z",
    }, NOW);

    expect(result.practice).toBe("Финансовое право");
  });

  it("does not treat every court mention of a fine as an urgent deadline", () => {
    const result = classifyLegalOpportunity({
      title: "ВС напомнил, когда штраф по договору можно уменьшить",
      summary: "Суд разъяснил применение статьи 333 ГК РФ.",
      feedTitle: "Право.ru",
      publishedAt: "2026-08-13T07:00:00.000Z",
      fetchedAt: "2026-08-13T07:05:00.000Z",
    }, NOW);

    expect(result.priority).toBe("medium");
  });

  it("removes markup from source summaries", () => {
    expect(cleanLegalSourceText("<p>Важное&nbsp;<strong>изменение</strong></p>"))
      .toBe("Важное изменение");
  });

  it("deduplicates the same legal act from different source descriptions", () => {
    const consultant = legalOpportunityFingerprint({
      title: "Постановление Правительства РФ от 11.08.2026 N 1005",
      summary: "Уточнён перечень товаров.",
    });
    const government = legalOpportunityFingerprint({
      title: "Постановление Правительства Российской Федерации от 11.08.2026 № 1005",
      summary: "О внесении изменения в постановление № 311.",
    });

    expect(consultant).toBe(government);
  });

  it("removes protocol news from broad government feeds", () => {
    expect(isLikelyLegalOpportunity({
      title: "Александр Новак встретился с министром энергетики Таиланда",
      summary: "Стороны обсудили развитие двустороннего сотрудничества.",
      feedTitle: "Правительство России",
    })).toBe(false);
  });

  it("keeps legal documents from broad government feeds", () => {
    expect(isLikelyLegalOpportunity({
      title: "Правительство утвердило новые требования к онлайн-платформам",
      summary: "Постановление вступает в силу с 1 сентября.",
      feedTitle: "Правительство России",
    })).toBe(true);
  });
});
