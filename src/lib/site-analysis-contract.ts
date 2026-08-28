export type SiteAnalysisStatus =
  | "queued"
  | "crawling"
  | "analyzing"
  | "planning"
  | "saving"
  | "ready"
  | "failed";

const RETRYABLE_SITE_ANALYSIS_ERRORS = new Set([
  "queue_unconfirmed",
  "robots_unavailable",
  "timeout",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "provider_timeout",
  "network_error",
  "rate_limited",
  "stream_truncated",
  "empty_generation",
  "analysis_in_progress",
  "quota_commit_failed",
  "worker_failed",
]);

export function siteAnalysisErrorRetryable(code: string): boolean {
  return RETRYABLE_SITE_ANALYSIS_ERRORS.has(code);
}

/** Безопасные для клиента сообщения без серверных зависимостей. */
export function siteAnalysisErrorMessage(code: string): string {
  switch (code) {
    case "consent_required":
      return "Подтверди право анализировать этот публичный сайт.";
    case "domain_mismatch":
      return "Адрес сайта и подтверждённый домен не совпадают.";
    case "port_forbidden":
      return "Для анализа разрешены только стандартные веб-порты.";
    case "private_address":
      return "Этот адрес ведёт во внутреннюю или служебную сеть.";
    case "robots_denied":
      return "Правила сайта запрещают анализ указанной страницы.";
    case "robots_unavailable":
      return "Не удалось безопасно проверить правила доступа сайта. Попробуй позже.";
    case "crawl_too_large":
      return "Сайт превысил безопасный лимит анализа.";
    case "no_pages":
      return "Не удалось получить ни одной открытой страницы сайта.";
    case "redirect_forbidden":
      return "Сайт перенаправил анализ за пределы подтверждённого домена.";
    case "timeout":
      return "Сайт не ответил в пределах безопасного времени.";
    case "ENOTFOUND":
      return "DNS не нашёл указанный домен. Проверь адрес сайта и повтори позже.";
    case "EAI_AGAIN":
      return "DNS сайта временно не ответил. Повтори анализ позже.";
    case "ECONNREFUSED":
      return "Сайт отклонил подключение crawler. Проверь доступность HTTPS с сервера.";
    case "ECONNRESET":
      return "Сайт разорвал соединение во время проверки. Повтори анализ позже.";
    case "tls_invalid":
      return "Не удалось подтвердить TLS-сертификат сайта. Небезопасное соединение не анализируется.";
    case "queue_unconfirmed":
      return "Фоновая очередь не подтвердила запуск анализа. Повтори действие.";
    case "ai_usage_limit":
      return "Лимит ИИ на сегодня исчерпан. Незавершённый анализ не был списан.";
    case "provider_timeout":
      return "Аналитическая модель не ответила вовремя. Лимит ИИ не списан.";
    case "network_error":
      return "Связь с аналитической моделью оборвалась. Лимит ИИ не списан.";
    case "rate_limited":
      return "Провайдер временно ограничил запросы. Повтори анализ позже без повторного списания.";
    case "stream_truncated":
      return "Ответ аналитической модели оборвался до завершения. Лимит ИИ не списан.";
    case "schema_invalid":
      return "Ответ аналитика не прошёл проверку доказательств. Лимит ИИ не списан.";
    case "engine_not_connected":
      return "Аналитическая модель не подключена. Лимит ИИ не списан.";
    case "engine_unsupported":
      return "Выбранная аналитическая модель не поддерживается. Лимит ИИ не списан.";
    case "empty_generation":
      return "Аналитическая модель не вернула результат. Лимит ИИ не списан.";
    case "analysis_in_progress":
      return "Этот анализ уже выполняется другим worker. Обнови статус через несколько секунд.";
    case "quota_commit_failed":
      return "Готовый отчёт и списание лимита не удалось подтвердить одной операцией. Лимит ИИ не списан.";
    default:
      return "Не удалось завершить анализ сайта.";
  }
}
