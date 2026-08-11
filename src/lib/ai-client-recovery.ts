export interface AiFailureInfo {
  error?: string;
  label?: string;
  needs?: string;
  requestId?: string;
  retryable?: boolean;
  code?: string;
  issues?: string[];
  suggestedEngine?: { id?: string; label?: string } | null;
}

/** Calm, concrete Russian recovery copy for both HTTP preflight and stream failures. */
export function aiFailureRecoveryRu(info: AiFailureInfo | null, status?: number): string {
  if (status === 400) return "Запрос не принят. Проверь текст и повтори отправку.";
  if (status === 401) return "Сессия завершилась. Обнови страницу, войди снова и повтори запрос.";
  if (status === 403) return "Запрос отклонён проверкой безопасности. Обнови страницу и повтори действие из этого чата.";
  if (info?.error === "request_in_progress") {
    return "Этот запрос ещё выполняется. Подожди пару секунд и нажми «Повторить запрос» — второй вызов модели не запустится.";
  }
  if (info?.error === "idempotency_key_conflict") {
    return "Ключ запроса уже относится к другому тексту. Создай новый вариант, чтобы отправить этот бриф отдельно.";
  }
  if (info?.error === "request_result_unavailable") {
    return "Запрос был списан раньше, но его сохранённый результат недоступен. Не повторяй его с новым ключом; передай номер запроса в поддержку.";
  }
  if (info?.error === "engine_unsupported") {
    return `Модель ${info.label ?? "выбранная модель"} пока не поддерживается. Выбор сохранён; подтвердить переход на доступную модель можно ниже.`;
  }
  if (info?.error === "engine_not_connected") {
    return `Модель ${info.label ?? "выбранная модель"} не подключена${info.needs ? `: нужен ${info.needs}` : ""}. Выбор сохранён.`;
  }
  if (info?.error === "engine_offline") {
    return `${info.label ?? "Выбранная модель"} сейчас не отвечает. Квота не резервировалась; можно повторить проверку или подтвердить переход на предложенную модель.`;
  }
  if (info?.error === "provider_rate_limited") {
    return `${info.label ?? "Выбранная модель"} временно ограничила запросы. Подожди немного и попробуй снова.`;
  }
  if (info?.error === "provider_timeout") {
    return `${info.label ?? "Выбранная модель"} не успела ответить. Запрос остановлен; повтори его с сохранённым ключом.`;
  }
  if (info?.error === "empty_generation") {
    return `${info.label ?? "Выбранная модель"} завершила обработку без готового текста. Повтори запрос или выбери другую готовую модель.`;
  }
  if (info?.error === "stream_truncated") {
    return "Ответ оборвался до подтверждения завершения. Повтори тот же запрос: сервер вернёт сохранённый результат или безопасно запустит его заново без двойного списания.";
  }
  if (info?.error === "post_validation_failed") {
    const details = info.issues?.slice(0, 3).join("; ");
    return details
      ? `Аврора не показала пост, потому что он не прошёл выбранные настройки: ${details}. Повтори запрос — настройки сохранены.`
      : "Аврора не показала пост, потому что он не прошёл выбранные настройки. Повтори запрос — настройки сохранены.";
  }
  if (info?.error === "factual_validation_failed") {
    return "Проверка нашла неподтверждённые факты или искажённые реквизиты. Уточни бриф или добавь проверенные источники и повтори запрос.";
  }
  if (info?.error === "topic_alignment_failed") {
    return "Аврора дважды ушла от темы выбранного материала. Результат заблокирован и не открыт в редакторе; исходный контекст сохранён, можно безопасно повторить запрос.";
  }
  if (info?.error === "provider_authentication_failed" || info?.error === "provider_access_denied") {
    return `${info.label ?? "Провайдер"} отклонил доступ. Проверь ключ, тариф и права модели, затем повтори запрос.`;
  }
  if (info?.error === "provider_bad_request" || info?.error === "provider_rejected") {
    return `${info.label ?? "Провайдер"} не принял параметры генерации. Смягчи ограничения брифа или выбери другую готовую модель.`;
  }
  if (info?.error === "provider_conflict") {
    return `${info.label ?? "Провайдер"} занят конфликтующей операцией. Подожди немного и повтори запрос.`;
  }
  if (info?.error === "provider_network_error") {
    return "Связь с моделью прервалась. Проверь соединение и повтори тот же запрос — текст и ключ сохранены.";
  }
  if (status === 422) return "Исправь тему или конфликтующие настройки брифа и повтори запрос.";
  if (status === 429) return "Дневной лимит исчерпан. Текст запроса сохранён; повтори его после обновления лимита.";
  return `${info?.label ?? "ИИ-движок"} сейчас недоступен. Повтори запрос или выбери другую готовую модель.`;
}
