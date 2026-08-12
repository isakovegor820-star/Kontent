import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ permission: vi.fn() }));

vi.mock("./project-permissions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./project-permissions")>();
  return { ...actual, requireSelectedProjectPermission: mocks.permission };
});

import {
  authorizeProjectNotificationScope,
  listProjectNotifications,
  markAllProjectNotificationsRead,
  markProjectNotificationRead,
  parseProjectNotificationId,
  parseProjectNotificationListQuery,
  ProjectNotificationError,
  type ProjectNotificationScope,
} from "./project-notifications";

const scope: ProjectNotificationScope = Object.freeze({
  projectId: 23,
  userId: 5,
  role: "author",
});

describe("project notification input boundaries", () => {
  it("accepts the bounded cursor contract and rejects foreign selectors", () => {
    expect(parseProjectNotificationListQuery(new URLSearchParams("limit=50&before=91&unread=true")))
      .toEqual({ limit: 50, beforeId: 91, unreadOnly: true });
    expect(parseProjectNotificationListQuery(new URLSearchParams()))
      .toEqual({ limit: 20, beforeId: null, unreadOnly: false });

    for (const query of [
      "limit=51",
      "limit=0",
      "before=-1",
      "unread=yes",
      "projectId=999",
      "limit=10&limit=20",
    ]) {
      expect(() => parseProjectNotificationListQuery(new URLSearchParams(query)))
        .toThrowError(ProjectNotificationError);
    }
  });

  it("accepts only short positive safe notification ids", () => {
    expect(parseProjectNotificationId("42")).toBe(42);
    for (const value of ["0", "-1", "1.5", "x", "9".repeat(21), Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parseProjectNotificationId(value)).toThrowError(ProjectNotificationError);
    }
  });
});

describe("project notification service isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.permission.mockResolvedValue({ projectId: 23, userId: 5, role: "author", version: 2 });
  });

  it("resolves the selected project with project.read and ignores client project ids entirely", async () => {
    const db = { query: vi.fn() };
    await expect(authorizeProjectNotificationScope(db as never, 5)).resolves.toEqual(scope);
    expect(mocks.permission).toHaveBeenCalledWith(db, 5, "project.read");
  });

  it("lists only the recipient in the authorized project and keeps raw safe_data private", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("count(*)::bigint")) {
        expect(params).toEqual([23, 5]);
        return { rows: [{ unread_count: "2" }], rowCount: 1 };
      }
      expect(sql).toContain("notification.project_id = $1");
      expect(sql).toContain("notification.recipient_user_id = $2");
      expect(sql).not.toContain("safe_data");
      expect(params).toEqual([23, 5, null, false, 3]);
      return {
        rows: [
          {
            id: "12",
            project_id: "23",
            actor_user_id: "8",
            actor_name: "Анна",
            event_type: "draft_comment_added",
            entity_type: "draft",
            entity_id: "71",
            read_at: null,
            created_at: "2026-08-12T09:00:00.000Z",
          },
          {
            id: "11",
            project_id: "23",
            actor_user_id: null,
            actor_name: null,
            event_type: "publication_review_due",
            entity_type: "publication_review_task",
            entity_id: "31",
            read_at: "2026-08-12T09:10:00.000Z",
            created_at: "2026-08-12T08:00:00.000Z",
          },
          {
            id: "10",
            project_id: "23",
            actor_user_id: null,
            actor_name: null,
            event_type: "older",
            entity_type: "draft",
            entity_id: "1",
            read_at: null,
            created_at: "2026-08-12T07:00:00.000Z",
          },
        ],
        rowCount: 3,
      };
    });

    await expect(listProjectNotifications({ query } as never, scope, {
      limit: 2,
      beforeId: null,
      unreadOnly: false,
    })).resolves.toEqual({
      projectId: 23,
      notifications: [
        {
          id: 12,
          projectId: 23,
          actor: { id: 8, name: "Анна" },
          eventType: "draft_comment_added",
          entityType: "draft",
          entityId: "71",
          readAt: null,
          createdAt: "2026-08-12T09:00:00.000Z",
        },
        {
          id: 11,
          projectId: 23,
          actor: null,
          eventType: "publication_review_due",
          entityType: "publication_review_task",
          entityId: "31",
          readAt: "2026-08-12T09:10:00.000Z",
          createdAt: "2026-08-12T08:00:00.000Z",
        },
      ],
      unreadCount: 2,
      nextCursor: 11,
      hasMore: true,
    });
  });

  it("marks one item idempotently without revealing a foreign project or recipient", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith("update project_notifications")) {
        expect(sql).toContain("notification.project_id = $2");
        expect(sql).toContain("notification.recipient_user_id = $3");
        expect(sql).toContain("coalesce(notification.read_at, now())");
        expect(params).toEqual([17, 23, 5]);
        return { rows: [{ read_at: "2026-08-12T10:00:00.000Z" }], rowCount: 1 };
      }
      expect(params).toEqual([23, 5]);
      return { rows: [{ unread_count: "1" }], rowCount: 1 };
    });

    await expect(markProjectNotificationRead({ query } as never, scope, "17"))
      .resolves.toEqual({
        projectId: 23,
        notificationId: 17,
        readAt: "2026-08-12T10:00:00.000Z",
        unreadCount: 1,
      });
  });

  it("returns the same not-found result for missing and foreign notification ids", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    await expect(markProjectNotificationRead({ query } as never, scope, 999))
      .rejects.toMatchObject({ code: "notification_not_found" });
    expect(query).toHaveBeenCalledWith(expect.stringContaining("notification.recipient_user_id = $3"), [999, 23, 5]);
  });

  it("marks all unread items only for the authorized recipient and project", async () => {
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      expect(sql).toContain("notification.project_id = $1");
      expect(sql).toContain("notification.recipient_user_id = $2");
      expect(sql).toContain("notification.read_at is null");
      expect(params).toEqual([23, 5]);
      return { rows: [{ id: "2" }, { id: "1" }], rowCount: 2 };
    });
    await expect(markAllProjectNotificationsRead({ query } as never, scope))
      .resolves.toEqual({ projectId: 23, markedCount: 2, unreadCount: 0 });
  });
});
