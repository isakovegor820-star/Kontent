import { describe, expect, it } from "vitest";

import {
  publicationOperationFailureFeedback,
  publicationOperationReachedCalendar,
} from "./publication-operation-feedback";

describe("publication operation failure feedback", () => {
  it("returns to the calendar when the operation committed before queue dispatch degraded", () => {
    expect(publicationOperationReachedCalendar({
      ok: false,
      result: "partial",
      operationId: 81,
    })).toBe(true);
    expect(publicationOperationReachedCalendar({
      ok: false,
      result: "worker_unavailable",
    })).toBe(false);
  });

  it("points a failed publication recheck back to the contextual typographer", () => {
    expect(publicationOperationFailureFeedback({ error: "typography_review_required" })).toEqual({
      title: "Проверь оформление текста",
      body: "Публикация не создана, черновик сохранён. Открой «Типограф и словарь», примени или явно отклони оставшиеся правки и повтори планирование.",
    });
  });

  it("never presents an operation-less server failure as partial", () => {
    expect(publicationOperationFailureFeedback({
      result: "operation_not_created",
      error: "operation_not_created",
    }).title).toBe("Публикация не создана");
  });

  it("uses partial copy only for a persisted operation with destinations", () => {
    expect(publicationOperationFailureFeedback({
      result: "partial",
      operationId: 17,
      destinations: [{ postId: 1 }],
    }).title).toBe("Не все назначения поставлены в очередь");
    expect(publicationOperationFailureFeedback({ result: "partial" }).title)
      .toBe("Публикация не создана");
  });

  it("distinguishes a durable operation from a pre-creation worker outage", () => {
    expect(publicationOperationFailureFeedback({
      result: "worker_unavailable",
      operationId: 22,
    }).title).toBe("Операция сохранена, очередь недоступна");
    expect(publicationOperationFailureFeedback({
      result: "worker_unavailable",
    }).title).toBe("Публикация временно недоступна");
  });

  it("explains how to recover when an approved short link was revoked", () => {
    expect(publicationOperationFailureFeedback({
      result: "operation_not_created",
      error: "tracking_link_unavailable",
    })).toEqual({
      title: "Короткая ссылка больше не работает",
      body: expect.stringContaining("создай новую ссылку"),
    });
  });

  it("maps official-access denial to export guidance without claiming a queued operation", () => {
    expect(publicationOperationFailureFeedback({
      result: "operation_not_created",
      error: "official_access_required",
    })).toEqual({
      title: "Нужен официальный доступ площадки",
      body: expect.stringContaining("Автопубликация не запускалась"),
    });
  });
});
