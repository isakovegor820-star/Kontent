export type SiteAnalysisStatus =
  | "queued"
  | "crawling"
  | "analyzing"
  | "planning"
  | "ready"
  | "failed";

/** Client-safe copy: this module deliberately has no node:crypto or crawler imports. */
export function siteAnalysisErrorMessage(code: string): string {
  switch (code) {
    case "consent_required":
      return "Подтверди право анализировать этот публичный сайт.";
    case "domain_mismatch":
      return "URL и подтверждённый домен не совпадают.";
    case "port_forbidden":
      return "Для анализа разрешены только стандартные HTTP/HTTPS-порты.";
    case "private_address":
      return "Этот адрес ведёт во внутреннюю или служебную сеть.";
    case "robots_denied":
      return "robots.txt запрещает анализ указанной страницы.";
    case "robots_unavailable":
      return "Не удалось безопасно проверить robots.txt. Попробуй позже.";
    case "crawl_too_large":
      return "Сайт превысил безопасный лимит анализа.";
    case "no_pages":
      return "Не удалось получить ни одной публичной HTML-страницы.";
    case "redirect_forbidden":
      return "Сайт перенаправил crawler за подтверждённый домен.";
    default:
      return "Не удалось завершить анализ сайта.";
  }
}
