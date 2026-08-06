import { describe, expect, it } from "vitest";

import { publicationOperationFailureFeedback } from "./publication-operation-feedback";

describe("publication operation failure feedback", () => {
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
});
