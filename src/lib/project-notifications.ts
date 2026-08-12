import type { PoolClient } from "pg";

import {
  requireSelectedProjectPermission,
  type ProjectRole,
} from "./project-permissions";

type Queryable = Pick<PoolClient, "query">;

const DEFAULT_PAGE_SIZE = 20;
export const MAX_PROJECT_NOTIFICATION_PAGE_SIZE = 50;
export const MAX_PROJECT_NOTIFICATION_QUERY_LENGTH = 512;

export type ProjectNotificationScope = Readonly<{
  projectId: number;
  userId: number;
  role: ProjectRole;
}>;

export type ProjectNotificationListInput = Readonly<{
  limit: number;
  beforeId: number | null;
  unreadOnly: boolean;
}>;

export type ProjectNotification = Readonly<{
  id: number;
  projectId: number;
  actor: Readonly<{ id: number; name: string }> | null;
  eventType: string;
  entityType: string;
  entityId: string;
  readAt: string | null;
  createdAt: string;
}>;

export type ProjectNotificationInbox = Readonly<{
  projectId: number;
  notifications: ProjectNotification[];
  unreadCount: number;
  nextCursor: number | null;
  hasMore: boolean;
}>;

export class ProjectNotificationError extends Error {
  readonly code: "invalid_query" | "invalid_notification_id" | "notification_not_found";

  constructor(code: ProjectNotificationError["code"]) {
    super(code);
    this.name = "ProjectNotificationError";
    this.code = code;
  }
}

function positiveInteger(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function boundedString(value: unknown, max: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value.normalize("NFC").trim().replace(/[\u0000-\u001f\u007f]/gu, "");
  return normalized.slice(0, max) || fallback;
}

function iso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error("invalid_notification_date");
  return date.toISOString();
}

function safeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.floor(count));
}

export function parseProjectNotificationId(value: unknown): number {
  if (typeof value === "string" && (value.length > 20 || !/^\d+$/u.test(value))) {
    throw new ProjectNotificationError("invalid_notification_id");
  }
  const id = positiveInteger(value);
  if (id == null) throw new ProjectNotificationError("invalid_notification_id");
  return id;
}

export function parseProjectNotificationListQuery(
  params: URLSearchParams,
): ProjectNotificationListInput {
  const allowed = new Set(["limit", "before", "unread"]);
  for (const key of params.keys()) {
    if (!allowed.has(key) || params.getAll(key).length !== 1) {
      throw new ProjectNotificationError("invalid_query");
    }
  }

  const rawLimit = params.get("limit");
  const limit = rawLimit == null ? DEFAULT_PAGE_SIZE : positiveInteger(rawLimit);
  if (limit == null || limit > MAX_PROJECT_NOTIFICATION_PAGE_SIZE) {
    throw new ProjectNotificationError("invalid_query");
  }

  const rawBefore = params.get("before");
  const beforeId = rawBefore == null ? null : positiveInteger(rawBefore);
  if (rawBefore != null && beforeId == null) {
    throw new ProjectNotificationError("invalid_query");
  }

  const rawUnread = params.get("unread");
  if (rawUnread != null && rawUnread !== "true" && rawUnread !== "false") {
    throw new ProjectNotificationError("invalid_query");
  }

  return { limit, beforeId, unreadOnly: rawUnread === "true" };
}

/**
 * Resolves the project exclusively from the server-owned selected-project preference.
 * No route or client payload may supply a project id for the inbox.
 */
export async function authorizeProjectNotificationScope(
  db: Queryable,
  actorUserId: number,
): Promise<ProjectNotificationScope> {
  const membership = await requireSelectedProjectPermission(db, actorUserId, "project.read");
  return Object.freeze({
    projectId: membership.projectId,
    userId: membership.userId,
    role: membership.role,
  });
}

function notificationView(row: Record<string, unknown>): ProjectNotification {
  const id = parseProjectNotificationId(row.id);
  const projectId = parseProjectNotificationId(row.project_id);
  const actorId = row.actor_user_id == null ? null : positiveInteger(row.actor_user_id);
  const actor = actorId == null
    ? null
    : {
        id: actorId,
        name: boundedString(row.actor_name, 120, `Участник ${actorId}`),
      };
  return {
    id,
    projectId,
    actor,
    eventType: boundedString(row.event_type, 100, "project_event"),
    entityType: boundedString(row.entity_type, 80, "project"),
    entityId: boundedString(row.entity_id, 120, "unknown"),
    readAt: row.read_at == null ? null : iso(row.read_at),
    createdAt: iso(row.created_at),
  };
}

export async function listProjectNotifications(
  db: Queryable,
  scope: ProjectNotificationScope,
  input: ProjectNotificationListInput,
): Promise<ProjectNotificationInbox> {
  const limit = positiveInteger(input.limit);
  if (limit == null || limit > MAX_PROJECT_NOTIFICATION_PAGE_SIZE) {
    throw new ProjectNotificationError("invalid_query");
  }
  if (input.beforeId != null && positiveInteger(input.beforeId) == null) {
    throw new ProjectNotificationError("invalid_query");
  }

  const [pageResult, unreadResult] = await Promise.all([
    db.query(
      `select notification.id, notification.project_id, notification.actor_user_id,
              coalesce(nullif(btrim(actor.name), ''),
                       nullif(split_part(actor.email, '@', 1), '')) as actor_name,
              notification.event_type, notification.entity_type, notification.entity_id,
              notification.read_at, notification.created_at
         from project_notifications notification
         left join users actor on actor.id = notification.actor_user_id
        where notification.project_id = $1
          and notification.recipient_user_id = $2
          and ($3::bigint is null or notification.id < $3)
          and ($4::boolean = false or notification.read_at is null)
        order by notification.id desc
        limit $5`,
      [scope.projectId, scope.userId, input.beforeId, input.unreadOnly, limit + 1],
    ),
    db.query<{ unread_count: number | string }>(
      `select count(*)::bigint as unread_count
         from project_notifications notification
        where notification.project_id = $1
          and notification.recipient_user_id = $2
          and notification.read_at is null`,
      [scope.projectId, scope.userId],
    ),
  ]);

  const hasMore = pageResult.rows.length > limit;
  const visibleRows = hasMore ? pageResult.rows.slice(0, limit) : pageResult.rows;
  const notifications = visibleRows.map((row) => notificationView(row as Record<string, unknown>));
  return {
    projectId: scope.projectId,
    notifications,
    unreadCount: safeCount(unreadResult.rows[0]?.unread_count),
    nextCursor: hasMore && notifications.length > 0
      ? notifications[notifications.length - 1].id
      : null,
    hasMore,
  };
}

export async function markProjectNotificationRead(
  db: Queryable,
  scope: ProjectNotificationScope,
  notificationIdValue: unknown,
): Promise<{ projectId: number; notificationId: number; readAt: string; unreadCount: number }> {
  const notificationId = parseProjectNotificationId(notificationIdValue);
  const updated = await db.query<{ read_at: Date | string }>(
    `update project_notifications notification
        set read_at = coalesce(notification.read_at, now())
      where notification.id = $1
        and notification.project_id = $2
        and notification.recipient_user_id = $3
      returning notification.read_at`,
    [notificationId, scope.projectId, scope.userId],
  );
  const row = updated.rows[0];
  if (!row) throw new ProjectNotificationError("notification_not_found");
  const unread = await db.query<{ unread_count: number | string }>(
    `select count(*)::bigint as unread_count
       from project_notifications notification
      where notification.project_id = $1
        and notification.recipient_user_id = $2
        and notification.read_at is null`,
    [scope.projectId, scope.userId],
  );
  return {
    projectId: scope.projectId,
    notificationId,
    readAt: iso(row.read_at),
    unreadCount: safeCount(unread.rows[0]?.unread_count),
  };
}

export async function markAllProjectNotificationsRead(
  db: Queryable,
  scope: ProjectNotificationScope,
): Promise<{ projectId: number; markedCount: number; unreadCount: 0 }> {
  const result = await db.query(
    `update project_notifications notification
        set read_at = now()
      where notification.project_id = $1
        and notification.recipient_user_id = $2
        and notification.read_at is null
      returning notification.id`,
    [scope.projectId, scope.userId],
  );
  return {
    projectId: scope.projectId,
    markedCount: Math.max(0, Number(result.rowCount ?? result.rows.length) || 0),
    unreadCount: 0,
  };
}
