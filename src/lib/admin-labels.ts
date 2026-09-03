import { APP_ROUTES, type AppRouteId } from "./app-routes";
import { fmtNum } from "./utils";

/** Human labels for `audit_events.action`. Unknown keys fall back to a readable form. */
export const ADMIN_AUDIT_ACTION_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "audience.reply.sent": "Ответ клиенту отправлен",
  "audience.reply.delivery_resolved": "Доставка ответа подтверждена",
  "audience.reply.delivery_failed": "Ответ клиенту не доставлен",
  "brand_dictionary.entry.created": "Термин бренда добавлен",
  "brand_dictionary.entry.updated": "Термин бренда изменён",
  "brand_dictionary.entry.deleted": "Термин бренда удалён",
  "draft.approved": "Черновик согласован",
  "draft.changes_requested": "По черновику запрошены правки",
  "draft.deleted": "Черновик удалён",
  "draft.human_review_attested": "Подтверждена ручная проверка",
  "draft.recovered_as_manual": "Черновик восстановлен вручную",
  "draft.review_submitted": "Черновик отправлен на согласование",
  "draft.revision_created": "Создана новая версия черновика",
  "draft.comment_added": "Комментарий к черновику",
  "growth.artifact.created": "Материал развития создан",
  "growth.artifact.published": "Материал развития опубликован",
  "growth.move.skipped": "Шаг развития пропущен",
  "growth.outcome.measured": "Результат шага развития измерен",
  "monthly_campaign.created": "Месячная кампания создана",
  "monthly_campaign.updated": "Месячная кампания изменена",
  "monthly_campaign.item_linked": "Материал привязан к кампании",
  "monthly_campaign.item_moved": "Материал кампании перенесён",
  "monthly_campaign.plan_created": "План кампании создан",
  "monthly_campaign.plan_profile_refreshed": "Профиль кампании обновлён",
  "monthly_campaign.regeneration_requested": "Запрошена регенерация кампании",
  "monthly_campaign.regeneration_completed": "Регенерация кампании завершена",
  "project.created": "Проект создан",
  "project.export.requested": "Запрошен экспорт проекта",
  "project.export.revoked": "Экспорт проекта отозван",
  "project.invitation.created": "Приглашение в проект создано",
  "project.invitation.accepted": "Приглашение принято",
  "project.invitation.revoked": "Приглашение отозвано",
  "project.member.revoked": "Участник исключён из проекта",
  "project.member.role_changed": "Роль участника изменена",
  "publication.block.created": "Блок публикации создан",
  "publication.block.updated": "Блок публикации изменён",
  "publication.extra.created": "Дополнительная операция создана",
  "publication.extra.retry_requested": "Запрошен повтор дополнительной операции",
  "publication.extra.succeeded": "Дополнительная операция выполнена",
  "publication.preferences.updated": "Настройки публикации изменены",
  "publication.review.scheduled": "Проверка публикации запланирована",
  "publication.review.due": "Наступил срок проверки публикации",
  "publication.review.decided": "Решение по проверке публикации",
  "publication.scheduled": "Публикация запланирована",
  "tenchat.export.created": "Экспорт в TenChat создан",
  "tracking.link.created": "Ссылка отслеживания создана",
  "tracking.link.revoked": "Ссылка отслеживания отозвана",
  "tracking.settings.updated": "Настройки отслеживания изменены",
  "tracking.template.created": "Шаблон отслеживания создан",
  "tracking.template.updated": "Шаблон отслеживания изменён",
  "tracking.template.archived": "Шаблон отслеживания архивирован",
  "typography.run.completed": "Типографика применена",
  "typography.run.undone": "Типографика отменена",
});

export const ADMIN_AUDIT_ENTITY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  post: "публикация",
  draft: "черновик",
  project: "проект",
  project_member: "участник",
  project_invitation: "приглашение",
  project_export: "экспорт",
  channel: "канал",
  monthly_campaign: "кампания",
  monthly_campaign_plan: "план кампании",
  publication_block: "блок",
  publication_extra_operation: "доп. операция",
  publication_review_task: "проверка",
  tracking_link: "ссылка",
  tracking_template: "шаблон",
  brand_dictionary_entry: "термин",
  growth_move: "шаг развития",
  growth_artifact: "материал",
  typography_run: "типографика",
  audience_reply: "ответ клиенту",
});

export function adminAuditActionLabel(action: string): string {
  return ADMIN_AUDIT_ACTION_LABELS[action] ?? action.replace(/[._]+/gu, " ");
}

export function adminAuditEntityLabel(entityType: string): string {
  return ADMIN_AUDIT_ENTITY_LABELS[entityType] ?? entityType.replace(/_+/gu, " ");
}

/** Labels for `metrics` keys returned by system diagnostics. */
export const ADMIN_METRIC_LABELS: Readonly<Record<string, string>> = Object.freeze({
  latencyMs: "Задержка запроса",
  pingLatencyMs: "PING",
  usedMemoryBytes: "Занятая память",
  uptimeSeconds: "Uptime",
  connectedClients: "Подключения",
  eventLoopLagMs: "Задержка event loop",
  processUptimeSeconds: "Uptime процесса",
  rssBytes: "Память RSS",
  heapUsedBytes: "Heap занято",
  heapTotalBytes: "Heap выделено",
  max: "Лимит пула",
  total: "Соединений всего",
  idle: "Свободных соединений",
  active: "Активных соединений",
  waiting: "Ожидают соединение",
  acquireWaitP95Ms: "Ожидание соединения p95",
  acquireSamples: "Замеров ожидания",
  acquireTimeouts: "Таймауты получения соединения",
  acquireErrors: "Ошибки получения соединения",
  connectionTimeoutMillis: "Таймаут подключения",
  queryTimeoutMillis: "Таймаут запроса",
  statementTimeoutMillis: "Таймаут statement",
  idleInTransactionTimeoutMillis: "Таймаут idle in transaction",
  schemaVersion: "Версия снимка",
  role: "Роль процесса",
  expectedVersion: "Ожидаемая версия схемы",
  actualVersion: "Текущая версия схемы",
  appliedMigrations: "Применённые миграции",
  expectedMigrations: "Ожидаемые миграции",
  heartbeatAgeMs: "Возраст heartbeat",
  heartbeatIntervalMs: "Интервал heartbeat",
  heartbeatMaxAgeMs: "Допустимый возраст heartbeat",
  overdue: "Просроченные публикации",
  failures: "Ошибки за сутки",
  successes: "Успехи за сутки",
  lastSuccessAt: "Последний успех",
  lastErrorCode: "Последний код ошибки",
  running: "В работе",
  failed: "С ошибкой",
  recentSuccesses: "Успешных вызовов за 15 мин",
  recentFailures: "Ошибок за 15 мин",
  usageToday: "Использований сегодня",
  usagePeriod: "Использований за 30 дней",
  sent: "Отправлено",
  release: "Релиз",
  commitSha: "Commit",
  deployedAt: "Развёрнут",
});

export function adminMetricLabel(key: string): string {
  return ADMIN_METRIC_LABELS[key] ?? key
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .replace(/_+/gu, " ")
    .toLowerCase();
}

export function formatAdminBytes(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_024) return `${fmtNum(value)} Б`;
  if (value < 1_048_576) return `${(value / 1_024).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} КБ`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} МБ`;
  return `${(value / 1_073_741_824).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} ГБ`;
}

export function formatAdminDuration(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value < 1_000) return `${fmtNum(Math.round(value))} мс`;
  if (value < 60_000) return `${(value / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} с`;
  if (value < 3_600_000) return `${Math.floor(value / 60_000)} мин ${Math.round((value % 60_000) / 1_000)} с`;
  return formatAdminSeconds(Math.round(value / 1_000));
}

export function formatAdminSeconds(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return "—";
  const total = Math.max(0, Math.round(value));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${days} д ${hours} ч`;
  if (hours > 0) return `${hours} ч ${minutes} мин`;
  if (minutes > 0) return `${minutes} мин`;
  return `${total} с`;
}

/**
 * Formats a diagnostics metric by key convention: `*Bytes` → size, `*Seconds` → duration,
 * `*Ms` → milliseconds, `*At` → timestamp; everything else is shown verbatim.
 */
export function formatAdminMetric(key: string, value: unknown): string | null {
  if (value == null) return "—";
  if (typeof value === "boolean") return value ? "Да" : "Нет";
  if (typeof value === "number") {
    if (/bytes$/iu.test(key) || /memory/iu.test(key)) return formatAdminBytes(value);
    if (/seconds$/iu.test(key)) return formatAdminSeconds(value);
    if (/(ms|millis)$/iu.test(key)) return formatAdminDuration(value);
    return fmtNum(value);
  }
  if (typeof value === "string") {
    if (/at$/iu.test(key) && Number.isFinite(Date.parse(value))) {
      return new Date(value).toLocaleString("ru-RU", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
    }
    return value;
  }
  return null;
}

/** Label of an application section by its route id; unknown ids are returned as-is. */
export function adminSectionLabel(sectionId: string): string {
  return sectionId in APP_ROUTES ? APP_ROUTES[sectionId as AppRouteId].label : sectionId;
}
