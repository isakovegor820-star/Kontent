import fs from "node:fs";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("./project-provider", () => ({
  useProjects: () => ({ current: { id: 23 } }),
}));

import {
  ProjectNotificationsInbox,
  ProjectNotificationsInboxPanel,
} from "./project-notifications-inbox";
import type {
  ClientProjectNotification,
  ClientProjectNotificationInbox,
} from "@/lib/project-notifications-client";

const unread: ClientProjectNotification = {
  id: 12,
  projectId: 23,
  actor: { id: 8, name: "Анна" },
  eventType: "draft_review_requested",
  entityType: "draft",
  entityId: "71",
  readAt: null,
  createdAt: "2026-08-12T09:00:00.000Z",
};

const read: ClientProjectNotification = {
  ...unread,
  id: 11,
  actor: null,
  eventType: "publication_review_due",
  entityType: "publication_review_task",
  entityId: "31",
  readAt: "2026-08-12T09:30:00.000Z",
};

function inbox(overrides: Partial<ClientProjectNotificationInbox> = {}): ClientProjectNotificationInbox {
  return {
    projectId: 23,
    notifications: [unread, read],
    unreadCount: 1,
    nextCursor: 11,
    hasMore: true,
    ...overrides,
  };
}

const callbacks = {
  onRetry: vi.fn(),
  onMarkRead: vi.fn(),
  onMarkAll: vi.fn(),
  onLoadMore: vi.fn(),
  onOpenNotification: vi.fn(),
};

function renderPanel(input: {
  inbox: ClientProjectNotificationInbox | null;
  state: "idle" | "loading" | "ready" | "error";
  error?: string;
  markingId?: number | null;
  markingAll?: boolean;
  loadingMore?: boolean;
}) {
  return renderToStaticMarkup(createElement(ProjectNotificationsInboxPanel, {
    ...callbacks,
    error: "",
    markingId: null,
    markingAll: false,
    loadingMore: false,
    ...input,
  }));
}

describe("ProjectNotificationsInbox interface", () => {
  it("exposes a named native dialog trigger with a 44px button contract", () => {
    const html = renderToStaticMarkup(createElement(ProjectNotificationsInbox));
    expect(html).toContain('aria-label="Уведомления: загружаем"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-label="Закрыть уведомления"');
    expect(html).toContain("Согласования, комментарии и напоминания выбранного проекта.");
    expect(html).toContain("h-11 w-11");
  });

  it("announces loading and provides an orienting empty state", () => {
    const loading = renderPanel({ inbox: null, state: "loading" });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain("Загружаем уведомления…");

    const empty = renderPanel({
      inbox: inbox({ notifications: [], unreadCount: 0, hasMore: false, nextCursor: null }),
      state: "ready",
    });
    expect(empty).toContain("Событий пока нет");
    expect(empty).toContain("запросы на согласование, комментарии, решения и напоминания");
  });

  it("does not rely on color for read state and keeps destinations as real links", () => {
    const html = renderPanel({ inbox: inbox(), state: "ready", markingId: 12 });
    expect(html).toContain("Новое");
    expect(html).toContain("Прочитано");
    expect(html).toContain('href="/app/composer?draft=71"');
    expect(html).toContain('href="/app/calendar"');
    expect(html).toContain("Отметить прочитанным");
    expect(html).toContain("Отметить все прочитанными");
    expect(html).toContain("Показать ещё");
  });

  it("keeps actionable errors visible with a verb-first retry", () => {
    const html = renderPanel({
      inbox: null,
      state: "error",
      error: "Не удалось загрузить уведомления. Проверьте соединение и повторите.",
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Проверьте соединение и повторите");
    expect(html).toContain("Повторить загрузку");
  });

  it("guards focus, stale projects, polling and motion conventions in the interactive shell", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/components/app/project-notifications-inbox.tsx"),
      "utf8",
    );
    expect(source).toContain("dialog.showModal()");
    expect(source).toContain("triggerRef.current?.focus()");
    expect(source).toContain("currentProjectRef.current !== expectedProjectId");
    expect(source).toContain("window.setInterval(refresh, 60_000)");
    expect(source).toContain("onCancel=");
    expect(source).toContain("focus-visible:ring-4");
    expect(source).not.toContain("transition-all");
  });

  it("keeps the modal and notification rows reflow-safe at narrow widths and zoom", () => {
    const source = fs.readFileSync(
      path.join(process.cwd(), "src/components/app/project-notifications-inbox.tsx"),
      "utf8",
    );
    expect(source).toContain("w-[calc(100%-2rem)] max-w-lg");
    expect(source).toContain("max-h-[calc(100dvh-2rem)]");
    expect(source).toContain("min-h-0 flex-1 overflow-y-auto");
    expect(source).toContain("flex flex-wrap");
    expect(source).toContain("break-words");
    expect(source).not.toContain("w-screen");
  });
});
