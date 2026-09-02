export async function requestJson<T>(input: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const response = await fetch(input, {
    ...init,
    headers: { "content-type": "application/json", accept: "application/json", ...(init?.headers || {}) },
    credentials: "same-origin",
    cache: "no-store",
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

export function formatDate(value: string | null | undefined, withTime = false) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("ru-RU", withTime
    ? { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "long", year: "numeric" });
}

export function errorMessage(code: string | undefined, fallback: string) {
  switch (code) {
    case "consent_required": return "Подтверди, что у тебя есть право анализировать этот сайт.";
    case "bad_url":
    case "domain_mismatch": return "Укажи адрес сайта вместе с протоколом, например https://example.ru.";
    case "private_address": return "Адрес ведёт во внутреннюю сеть — подключить можно только публичный сайт.";
    case "worker_unavailable": return "Фоновый обработчик недоступен. Попробуй через минуту.";
    case "analysis_in_progress": return "Анализ этого сайта уже выполняется.";
    case "access_denied": return "Недостаточно прав в проекте.";
    case "idempotency_conflict": return "Похожий запрос уже обрабатывается с другими параметрами. Обнови страницу.";
    case "domain_unverified": return "Сначала подтверди владение доменом.";
    case "profile_required": return "Сначала дождись завершения аудита сайта.";
    case "no_active_destination": return "Не настроено ни одного назначения для публикации.";
    case "auto_mode_locked": return "Автоматический режим откроется после серии одобренных без правок материалов.";
    case "credentials_invalid": return "Укажи логин WordPress и пароль приложения (не обычный пароль).";
    case "base_url_invalid": return "Адрес WordPress должен начинаться с https://.";
    case "auth_failed": return "WordPress не принял логин или пароль приложения.";
    case "publish_posts_capability_missing": return "У этого пользователя WordPress нет права публиковать записи.";
    case "hosted_domain_not_configured": return "Служебный домен для хостируемого раздела не настроен на сервере.";
    case "article_not_editable": return "Этот материал сейчас нельзя редактировать.";
    case "article_not_approvable": return "Материал не в статусе, который можно одобрить.";
    case "article_not_approved": return "Сначала одобри материал.";
    case "brief_too_short": return "Опиши задачу подробнее — минимум 10 символов.";
    default: return fallback;
  }
}

export const ARTICLE_STATUS_LABEL: Record<string, string> = {
  draft: "В очереди на генерацию",
  generating: "Генерируется",
  needs_review: "Ждёт одобрения",
  approved: "Одобрен",
  scheduled: "Запланирован",
  publishing: "Публикуется",
  published: "Опубликован",
  failed: "Ошибка",
  rejected: "Отклонён",
  retired: "Снят",
};
