type PublicationOperationFailure = {
  ok?: boolean;
  result?: "operation_not_created" | "partial" | "queued" | "conflict" | "worker_unavailable";
  error?: string;
  operationId?: number;
  destinations?: Array<unknown>;
};

/** A committed operation already has a calendar record even if queue dispatch is pending. */
export function publicationOperationReachedCalendar(result: PublicationOperationFailure) {
  return result.ok === true
    || (
      result.operationId != null
      && (result.result === "partial" || result.result === "worker_unavailable")
    );
}

export function publicationOperationFailureFeedback(result: PublicationOperationFailure) {
  if (result.error === "typography_review_required") {
    return {
      title: "Проверь оформление текста",
      body: "Публикация не создана, черновик сохранён. Открой «Типограф и словарь», примени или явно отклони оставшиеся правки и повтори планирование.",
    };
  }
  if (result.error === "official_access_required") {
    return {
      title: "Нужен официальный доступ площадки",
      body: "Автопубликация не запускалась. Для TenChat скачай пакет в Композиторе и опубликуй его вручную либо запроси официальный партнёрский доступ.",
    };
  }
  if (result.error === "tracking_link_unavailable") {
    return {
      title: "Короткая ссылка больше не работает",
      body: "Публикация не создана, черновик сохранён. Открой раздел «Ссылка и отслеживание», создай новую ссылку и отправь обновлённую версию на согласование.",
    };
  }
  if (result.error === "tracking_snapshot_invalid") {
    return {
      title: "Не удалось проверить ссылку",
      body: "Публикация не создана, черновик сохранён. Пересоздай ссылку в черновике и повтори планирование.",
    };
  }
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
