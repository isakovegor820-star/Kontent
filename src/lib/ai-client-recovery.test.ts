import { describe, expect, it } from "vitest";
import { aiFailureRecoveryRu, aiTerminalRestartAllowed } from "./ai-client-recovery";

describe("AI client recovery copy", () => {
  it("does not blame the model when the internal operation budget is exhausted", () => {
    expect(aiFailureRecoveryRu({
      error: "ai_operation_budget_exhausted",
      label: "GPT-5.4 (NavyAI)",
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
});


describe("N48 terminal cancellation recovery", () => {
  it.each(["ai_generation_cancelled", "ai_generation_interrupted"])("requires a deliberate new operation for %s", (error) => {
    expect(aiTerminalRestartAllowed({ error, retryable: false })).toBe(true);
    expect(aiFailureRecoveryRu({ error }, 422)).toContain("Автоматический повтор остановлен");
    expect(aiFailureRecoveryRu({ error }, 422)).toContain("Новый запуск будет учтён в лимитах");
  });
  it.each(["request_in_progress", "provider_timeout", "request_result_unavailable", "channel_forbidden", "idempotency_key_conflict"])("does not propose a new operation for %s", (error) => {
    expect(aiTerminalRestartAllowed({ error })).toBe(false);
  });
});


describe("N50 truthful spend policy recovery", () => {
  it.each([
    ["ai_spend_cap_exceeded", "Лимит расходов на ИИ исчерпан"],
    ["ai_spend_concurrency_exceeded", "слишком много запросов ИИ"],
    ["ai_spend_configuration_required", "Настройки расходов на ИИ не готовы"],
    ["ai_spend_scope_forbidden", "Нет доступа к запуску ИИ"],
  ])("describes %s without blaming the provider or inventing a price", (error, copy) => {
    expect(aiFailureRecoveryRu({ error })).toContain(copy);
    expect(aiFailureRecoveryRu({ error })).not.toContain("модель не отвечает");
    expect(aiTerminalRestartAllowed({ error })).toBe(false);
  });
});
