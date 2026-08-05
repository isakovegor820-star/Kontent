export type SiteAnalysisStatus =
  | "queued"
  | "crawling"
  | "analyzing"
  | "planning"
  | "saving"
  | "ready"
  | "failed";

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
    case "quota_commit_failed":
      return "Готовый отчёт и списание лимита не удалось подтвердить одной операцией. Лимит ИИ не списан.";
    default:
      return "Не удалось завершить анализ сайта.";
  }
}
