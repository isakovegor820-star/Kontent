import { afterEach, describe, expect, it, vi } from "vitest";

import {
  loadProjectNotifications,
  markAllClientProjectNotificationsRead,
  markClientProjectNotificationRead,
  parseProjectNotificationInboxResponse,
  projectNotificationCopy,
  projectNotificationDestination,
  projectNotificationErrorMessage,
  ProjectNotificationRequestError,
  type ClientProjectNotification,
} from "./project-notifications-client";

const notification: ClientProjectNotification = {
  id: 12,
  projectId: 23,
  actor: { id: 8, name: "Анна" },
  eventType: "draft_review_requested",
  entityType: "draft",
  entityId: "71",
  readAt: null,
  createdAt: "2026-08-12T09:00:00.000Z",
};

function inboxBody(overrides: Record<string, unknown> = {}) {
  return {
    ok: true,
    inbox: {
      projectId: 23,
      notifications: [notification],
      unreadCount: 1,
      nextCursor: null,
      hasMore: false,
      ...overrides,
    },
  };
}

describe("project notification client contract", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses only internally consistent project-scoped inbox responses", () => {
    expect(parseProjectNotificationInboxResponse(inboxBody())).toEqual(inboxBody().inbox);
    expect(parseProjectNotificationInboxResponse(inboxBody({
      notifications: [{ ...notification, projectId: 999 }],
    }))).toBeNull();
    expect(parseProjectNotificationInboxResponse(inboxBody({ unreadCount: -1 }))).toBeNull();
    expect(parseProjectNotificationInboxResponse(inboxBody({ nextCursor: "bad" }))).toBeNull();
  });

  it("loads a bounded page without ever sending a project selector", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(inboxBody()));
    vi.stubGlobal("fetch", fetchMock);

    await expect(loadProjectNotifications({ limit: 20, beforeId: 91, unreadOnly: true }))
      .resolves.toMatchObject({ projectId: 23, unreadCount: 1 });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/project-notifications?limit=20&before=91&unread=true",
      expect.objectContaining({ cache: "no-store" }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("projectId");
  });

  it("marks one and all without mutable request bodies", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({
        ok: true,
        projectId: 23,
        notificationId: 12,
        readAt: "2026-08-12T10:00:00.000Z",
        unreadCount: 0,
      }))
      .mockResolvedValueOnce(Response.json({
        ok: true,
        projectId: 23,
        markedCount: 4,
        unreadCount: 0,
      }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(markClientProjectNotificationRead(12)).resolves.toMatchObject({ notificationId: 12 });
    await expect(markAllClientProjectNotificationsRead()).resolves.toMatchObject({ markedCount: 4 });
    expect(fetchMock.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ method: "POST" }));
    expect(fetchMock.mock.calls[0]?.[1]).not.toHaveProperty("body");
    expect(fetchMock.mock.calls[1]?.[1]).not.toHaveProperty("body");
  });

  it("uses honest Russian copy and safe destinations for known events", () => {
    expect(projectNotificationCopy(notification)).toEqual({
      title: "Материал ждёт согласования",
      description: "Анна: материал отправлен на проверку.",
    });
    expect(projectNotificationDestination(notification)).toBe("/app/composer?draft=71");
    expect(projectNotificationDestination({ ...notification, entityId: "javascript:alert(1)" })).toBeNull();
    expect(projectNotificationErrorMessage(new ProjectNotificationRequestError("rate_limited", 429)))
      .toContain("Подождите");
  });
});
