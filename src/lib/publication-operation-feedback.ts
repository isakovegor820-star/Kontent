type PublicationOperationFailure = {
  result?: "operation_not_created" | "partial" | "queued" | "conflict" | "worker_unavailable";
  error?: string;
  operationId?: number;
  destinations?: Array<unknown>;
};

export function publicationOperationFailureFeedback(result: PublicationOperationFailure) {
  if (result.result === "worker_unavailable") {
    return result.operationId != null
      ? {
          title: "Операция сохранена, очередь недоступна",
          body: "Сервер сохранил публикацию, но не подтвердил постановку в очередь. Черновик оставлен; повтор продолжит эту же операцию без дубля.",
        }
      : {
          title: "Публикация временно недоступна",
          body: "Фоновый обработчик не отвечает. Операция не создана, черновик сохранён — повтори планирование позже.",
        };
  }
  if (result.result === "conflict" || result.error?.includes("conflict")) {
    return {
      title: "Версия операции изменилась",
      body: "Повтор не смешал новый текст со старой отправкой. Черновик сохранён; обнови данные и повтори планирование.",
    };
  }
  if (
    result.result === "partial"
    && result.operationId != null
    && (result.destinations?.length ?? 0) > 0
  ) {
    return {
      title: "Не все назначения поставлены в очередь",
      body: "Операция и назначения сохранены. Черновик не удалён; состояние каждого канала показано в календаре.",
    };
  }
  return {
    title: "Публикация не создана",
    body: "Сервер не подтвердил создание операции. Черновик сохранён — проверь данные и повтори планирование.",
  };
}
