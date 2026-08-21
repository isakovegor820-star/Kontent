import { describe, expect, it } from "vitest";

import {
  autopilotCandidateCount,
  selectAutopilotCandidates,
} from "./autopilot-candidate-selection.mjs";

describe("Autopilot candidate selection", () => {
  it("computes a small proportional reserve without changing publication count", () => {
    expect(autopilotCandidateCount(5)).toBe(7);
    expect(autopilotCandidateCount(3)).toBe(5);
    expect(autopilotCandidateCount(10)).toBe(14);
  });

  it("keeps the news quota, quality order, source confirmation, and diversity", () => {
    const result = selectAutopilotCandidates([
      { i: 0, topic: "Новое правило для бизнеса", draft: "Первый новостной разбор.", news: true, sourceConfirmed: true, qualityScore: 94 },
      { i: 1, topic: "Исследование рынка", draft: "Второй новостной разбор.", news: true, sourceConfirmed: true, qualityScore: 91 },
      { i: 2, topic: "Новое правило для бизнеса", draft: "Первый новостной разбор.", news: true, sourceConfirmed: true, qualityScore: 93 },
      { i: 3, topic: "Чек-лист запуска", draft: "Пять шагов перед запуском.", qualityScore: 92 },
      { i: 4, topic: "Ошибка в договоре", draft: "Как проверить один важный пункт.", sourceConfirmed: true, qualityScore: 90 },
      { i: 5, topic: "Вопрос клиента", draft: "Спокойный ответ на частый вопрос.", qualityScore: 89 },
      { i: 6, topic: "Итоги недели", draft: "Короткий вывод и следующий шаг.", qualityScore: 88 },
    ], { targetCount: 5, newsQuota: 2 });

    expect(result.selected).toHaveLength(5);
    expect(result.selectedNewsCount).toBe(2);
    expect(result.selected.map((candidate) => candidate.i)).toContain(0);
    expect(result.selected.map((candidate) => candidate.i)).not.toContain(2);
    expect(result.reserve).toHaveLength(2);
    expect(result).toMatchObject({
      newsQuota: 2,
      selectedNewsCount: 2,
      newsQuotaSatisfied: true,
      complete: true,
    });
  });

  it("does not call a pool complete when the requested news quota is missing", () => {
    const result = selectAutopilotCandidates([
      { i: 0, topic: "Разбор A", draft: "Уникальный разбор A.", qualityScore: 96 },
      { i: 1, topic: "Разбор B", draft: "Уникальный разбор B.", qualityScore: 95 },
      { i: 2, topic: "Новость", draft: "Подтверждённая новость.", news: true, qualityScore: 94 },
    ], { targetCount: 2, newsQuota: 2 });

    expect(result.selected).toHaveLength(2);
    expect(result.selectedNewsCount).toBe(1);
    expect(result.newsQuotaSatisfied).toBe(false);
    expect(result.complete).toBe(false);
  });

  it("finalizes five publications from six ready candidates and keeps one reserve", () => {
    const result = selectAutopilotCandidates([
      { i: 0, topic: "Налоговый календарь", draft: "Как не пропустить обязательную дату.", qualityScore: 95 },
      { i: 1, topic: "Проверка договора", draft: "Какие условия прочитать до подписи.", qualityScore: 94 },
      { i: 2, topic: "Переговоры с клиентом", draft: "Как письменно закрепить итог встречи.", qualityScore: 93 },
      { i: 3, topic: "Защита бренда", draft: "Когда регистрировать товарный знак.", qualityScore: 92 },
      { i: 4, topic: "Работа с подрядчиком", draft: "Как принимать результат по этапам.", qualityScore: 91 },
      { i: 5, topic: "Архив документов", draft: "Что хранить после закрытия проекта.", qualityScore: 90 },
    ], { targetCount: 5, newsQuota: 0 });

    expect(result.complete).toBe(true);
    expect(result.selected).toHaveLength(5);
    expect(result.reserve.map((candidate) => candidate.i)).toEqual([5]);
  });
});
