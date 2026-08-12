export type ClientProjectNotification = Readonly<{
  id: number;
  projectId: number;
  actor: Readonly<{ id: number; name: string }> | null;
  eventType: string;
  entityType: string;
  entityId: string;
  readAt: string | null;
  createdAt: string;
}>;

export type ClientProjectNotificationInbox = Readonly<{
  projectId: number;
  notifications: ClientProjectNotification[];
  unreadCount: number;
  nextCursor: number | null;
  hasMore: boolean;
}>;

export class ProjectNotificationRequestError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
  ) {
    super(code);
    this.name = "ProjectNotificationRequestError";
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function nonNegativeInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function dateString(value: unknown): string | null {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.normalize("NFC").trim();
  if (!normalized || normalized.length > max || /[\u0000-\u001f\u007f]/u.test(normalized)) return null;
  return normalized;
}

function parseActor(value: unknown): ClientProjectNotification["actor"] | undefined {
  if (value == null) return null;
  const source = record(value);
  const id = positiveInteger(source?.id);
  const name = boundedText(source?.name, 120);
  if (!source || id == null || name == null) return undefined;
  return { id, name };
}

function parseNotification(value: unknown): ClientProjectNotification | null {
  const source = record(value);
  const id = positiveInteger(source?.id);
  const projectId = positiveInteger(source?.projectId);
  const actor = parseActor(source?.actor);
  const eventType = boundedText(source?.eventType, 100);
  const entityType = boundedText(source?.entityType, 80);
  const entityId = boundedText(source?.entityId, 120);
  const readAt = source?.readAt == null ? null : dateString(source.readAt);
  const createdAt = dateString(source?.createdAt);
  if (
    !source || id == null || projectId == null || actor === undefined
    || eventType == null || entityType == null || entityId == null
    || (source.readAt != null && readAt == null) || createdAt == null
  ) return null;
  return { id, projectId, actor, eventType, entityType, entityId, readAt, createdAt };
}

export function parseProjectNotificationInboxResponse(
  value: unknown,
): ClientProjectNotificationInbox | null {
  const body = record(value);
  const inbox = record(body?.inbox);
  const projectId = positiveInteger(inbox?.projectId);
  const unreadCount = nonNegativeInteger(inbox?.unreadCount);
  const nextCursor = inbox?.nextCursor == null ? null : positiveInteger(inbox.nextCursor);
  if (
    body?.ok !== true || !inbox || projectId == null || unreadCount == null
    || typeof inbox.hasMore !== "boolean" || !Array.isArray(inbox.notifications)
    || (inbox.nextCursor != null && nextCursor == null)
  ) return null;
  const notifications = inbox.notifications.map(parseNotification);
  if (notifications.some((item) => item == null)) return null;
  if (notifications.some((item) => item!.projectId !== projectId)) return null;
  return {
    projectId,
    notifications: notifications as ClientProjectNotification[],
    unreadCount,
    nextCursor,
    hasMore: inbox.hasMore,
  };
}

async function responseBody(response: Response): Promise<Record<string, unknown> | null> {
  return record(await response.json().catch(() => null));
}

function responseError(response: Response, body: Record<string, unknown> | null): never {
  const code = typeof body?.error === "string" ? body.error : "server";
  throw new ProjectNotificationRequestError(code, response.status);
}

export async function loadProjectNotifications(options: {
  limit?: number;
  beforeId?: number | null;
  unreadOnly?: boolean;
  signal?: AbortSignal;
} = {}): Promise<ClientProjectNotificationInbox> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set("limit", String(options.limit));
  if (options.beforeId != null) params.set("before", String(options.beforeId));
  if (options.unreadOnly) params.set("unread", "true");
  const query = params.size > 0 ? `?${params.toString()}` : "";
  const response = await fetch(`/api/project-notifications${query}`, {
    cache: "no-store",
    signal: options.signal,
  });
  const body = await responseBody(response);
  if (!response.ok) responseError(response, body);
  const parsed = parseProjectNotificationInboxResponse(body);
  if (!parsed) throw new ProjectNotificationRequestError("invalid_response", 502);
  return parsed;
}

export async function markClientProjectNotificationRead(notificationId: number): Promise<{
  projectId: number;
  notificationId: number;
  readAt: string;
  unreadCount: number;
}> {
  const response = await fetch(`/api/project-notifications/${notificationId}/read`, {
    method: "POST",
    cache: "no-store",
  });
  const body = await responseBody(response);
  if (!response.ok) responseError(response, body);
  const projectId = positiveInteger(body?.projectId);
  const returnedId = positiveInteger(body?.notificationId);
  const readAt = dateString(body?.readAt);
  const unreadCount = nonNegativeInteger(body?.unreadCount);
  if (body?.ok !== true || projectId == null || returnedId == null || readAt == null || unreadCount == null) {
    throw new ProjectNotificationRequestError("invalid_response", 502);
  }
  return { projectId, notificationId: returnedId, readAt, unreadCount };
}

export async function markAllClientProjectNotificationsRead(): Promise<{
  projectId: number;
  markedCount: number;
  unreadCount: 0;
}> {
  const response = await fetch("/api/project-notifications/read-all", {
    method: "POST",
    cache: "no-store",
  });
  const body = await responseBody(response);
  if (!response.ok) responseError(response, body);
  const projectId = positiveInteger(body?.projectId);
  const markedCount = nonNegativeInteger(body?.markedCount);
  if (body?.ok !== true || projectId == null || markedCount == null || body.unreadCount !== 0) {
    throw new ProjectNotificationRequestError("invalid_response", 502);
  }
  return { projectId, markedCount, unreadCount: 0 };
}

export function projectNotificationErrorMessage(error: unknown): string {
  const code = error instanceof ProjectNotificationRequestError ? error.code : "network";
  if (code === "unauthorized") return "Сессия завершилась. Обновите страницу и войдите снова.";
  if (code === "access_denied") return "У вас больше нет доступа к этому проекту.";
  if (code === "rate_limited") return "Слишком много запросов. Подождите немного и повторите.";
  if (code === "rate_limit_unavailable") return "Проверка запросов временно недоступна. Повторите позже.";
  if (code === "notification_not_found") return "Уведомление уже недоступно. Обновите список.";
  return "Не удалось загрузить уведомления. Проверьте соединение и повторите.";
}

export function projectNotificationDestination(
  notification: ClientProjectNotification,
): string | null {
  const entityId = positiveInteger(notification.entityId);
  if (notification.entityType === "draft" && entityId != null) {
    return `/app/composer?draft=${entityId}`;
  }
  if (notification.entityType === "publication_review_task") return "/app/calendar";
  return null;
}

export function projectNotificationCopy(notification: ClientProjectNotification): {
  title: string;
  description: string;
} {
  const actor = notification.actor?.name;
  const byActor = (detail: string, fallback: string) => actor ? `${actor}: ${detail}` : fallback;
  switch (notification.eventType) {
    case "draft_review_requested":
      return {
        title: "Материал ждёт согласования",
        description: byActor("материал отправлен на проверку.", "Откройте сохранённую версию и примите решение."),
      };
    case "draft_comment_added":
      return {
        title: "Новый комментарий к материалу",
        description: byActor("добавлен комментарий к сохранённой версии.", "К сохранённой версии добавили комментарий."),
      };
    case "draft_approved":
      return {
        title: "Материал согласован",
        description: byActor("сохранённая версия согласована.", "Сохранённая версия прошла согласование."),
      };
    case "draft_changes_requested":
      return {
        title: "Нужны правки",
        description: byActor("материал возвращён с замечаниями.", "Откройте замечания и подготовьте новую версию."),
      };
    case "draft_ready_to_publish":
      return {
        title: "Материал готов к публикации",
        description: "Согласованная версия ждёт публикации.",
      };
    case "publication_review_due":
      return {
        title: "Пора проверить публикацию",
        description: "Проверьте, остаётся ли публикация актуальной.",
      };
    default:
      return {
        title: "Событие проекта",
        description: "Откройте связанный материал, чтобы посмотреть детали.",
      };
  }
}
