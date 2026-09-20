import { describe, expect, it } from "vitest";
import {
  AI_TERMINAL_ACK_RECOVERY_RU,
  AI_USAGE_FINALIZATION_RECOVERY_RU,
  aiFailureRecoveryRu,
  visibleStudioAiErrorRu,
} from "./ai-client-recovery";

describe("AI client recovery copy", () => {
  it("does not blame the model when the internal operation budget is exhausted", () => {
    expect(aiFailureRecoveryRu({
      error: "ai_operation_budget_exhausted",
      label: "GPT-5.6 Terra (NavyAI)",
      dimension: "tokens",
    }, 422)).toBe("Запрос слишком объёмный для одного запуска. Сократи исходный текст и отправь его снова.");
  });

  it.each([
    [400, "bad_request", "Проверь текст"],
    [401, "unauthorized", "войди снова"],
    [403, "forbidden_origin", "проверкой безопасности"],
    [409, "request_in_progress", "второй вызов модели не запустится"],
    [422, "bad_post_settings", "настройки брифа"],
    [429, "limit", "лимит исчерпан"],
    [503, "engine_offline", "Квота не резервировалась"],
  ])("maps HTTP %i/%s to a concrete recovery", (status, error, expected) => {
    expect(aiFailureRecoveryRu({ error, label: "Hermes 3" }, status)).toContain(expected);
  });

  it.each([
    ["provider_timeout", "не успела ответить"],
    ["provider_rate_limited", "ограничила запросы"],
    ["provider_network_error", "Проверь соединение"],
    ["provider_authentication_failed", "Проверь ключ"],
    ["stream_truncated", "без двойного списания"],
  ])("maps %s stream failures without losing the recovery action", (error, expected) => {
    expect(aiFailureRecoveryRu({ error, label: "Модель" })).toContain(expected);
  });

  it.each([
    ["usage_finalization_unavailable", "Черновик оставлен в чате"],
    ["usage_unavailable", "Запрос не отправлен модели"],
    ["generation_result_pending_ack", "без нового вызова модели"],
    ["generation_operation_unavailable", "защищённое сохранение"],
  ])("does not blame the selected model for internal failure %s", (error, expected) => {
    const recovery = aiFailureRecoveryRu({ error, label: "Аврора Искра (NavyAI)" }, 503);
    expect(recovery).toContain(expected);
    expect(recovery).not.toContain("Аврора Искра");
    expect(recovery).not.toContain("сейчас недоступен");
  });

  it("hides only the technical persistence card after a visible Studio draft", () => {
    expect(visibleStudioAiErrorRu(AI_USAGE_FINALIZATION_RECOVERY_RU)).toBeNull();
    expect(visibleStudioAiErrorRu(AI_TERMINAL_ACK_RECOVERY_RU)).toBeNull();
    expect(visibleStudioAiErrorRu("Модель не успела ответить.")).toBe("Модель не успела ответить.");
  });
});
