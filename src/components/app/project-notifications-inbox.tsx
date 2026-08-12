"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Bell,
  BellOff,
  Check,
  CheckCheck,
  ChevronRight,
  RefreshCw,
  TriangleAlert,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/primitives";
import {
  loadProjectNotifications,
  markAllClientProjectNotificationsRead,
  markClientProjectNotificationRead,
  projectNotificationCopy,
  projectNotificationDestination,
  projectNotificationErrorMessage,
  type ClientProjectNotification,
  type ClientProjectNotificationInbox,
} from "@/lib/project-notifications-client";
import { cn, plural } from "@/lib/utils";
import { useProjects } from "./project-provider";

type LoadState = "idle" | "loading" | "ready" | "error";

function notificationDate(value: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function unreadAccessibleLabel(count: number): string {
  if (count === 0) return "Уведомления: новых нет";
  return `Уведомления: ${count} ${plural(count, "непрочитанное", "непрочитанных", "непрочитанных")}`;
}

function InboxLoading() {
  return (
    <div role="status" aria-label="Загружаем уведомления" className="space-y-3">
      {[0, 1, 2].map((item) => (
        <div key={item} aria-hidden className="rounded-md bg-surface-inset p-4">
          <div className="skeleton h-4 w-2/3" />
          <div className="skeleton mt-3 h-3 w-full" />
          <div className="skeleton mt-2 h-3 w-1/2" />
        </div>
      ))}
      <span className="sr-only">Загружаем уведомления…</span>
    </div>
  );
}

export function ProjectNotificationsInboxPanel({
  inbox,
  state,
  error,
  markingId,
  markingAll,
  loadingMore,
  onRetry,
  onMarkRead,
  onMarkAll,
  onLoadMore,
  onOpenNotification,
}: {
  inbox: ClientProjectNotificationInbox | null;
  state: LoadState;
  error: string;
  markingId: number | null;
  markingAll: boolean;
  loadingMore: boolean;
  onRetry: () => void;
  onMarkRead: (notification: ClientProjectNotification) => void;
  onMarkAll: () => void;
  onLoadMore: () => void;
  onOpenNotification: (
    event: ReactMouseEvent<HTMLAnchorElement>,
    notification: ClientProjectNotification,
    href: string,
  ) => void;
}) {
  const notifications = inbox?.notifications ?? [];
  const initialLoading = state === "loading" && inbox == null;
  const empty = state === "ready" && notifications.length === 0;

  return (
    <div
      aria-busy={initialLoading || loadingMore || undefined}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-5 sm:px-5"
    >
      {error ? (
        <div role="alert" className="mb-4 rounded-md bg-danger-soft p-4 text-danger-text">
          <div className="flex items-start gap-3">
            <TriangleAlert className="mt-0.5 h-5 w-5 shrink-0" strokeWidth={2} aria-hidden />
            <div className="min-w-0 flex-1">
              <p className="text-[14px] leading-relaxed font-semibold text-pretty">{error}</p>
              <Button type="button" variant="ghost" size="sm" className="mt-2" onClick={onRetry}>
                <RefreshCw className="h-4 w-4" strokeWidth={2} aria-hidden />
                Повторить загрузку
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {initialLoading ? <InboxLoading /> : null}

      {empty ? (
        <div className="grid min-h-64 place-items-center px-3 py-10 text-center">
          <div className="max-w-sm">
            <span className="mx-auto grid h-12 w-12 place-items-center rounded-full bg-surface-inset text-text-3">
              <BellOff className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </span>
            <h3 className="mt-4 text-[16px] font-semibold text-text text-balance">
              Событий пока нет
            </h3>
            <p className="mt-2 text-[14px] leading-relaxed text-text-3 text-pretty">
              Здесь появятся запросы на согласование, комментарии, решения и напоминания выбранного проекта.
            </p>
          </div>
        </div>
      ) : null}

      {notifications.length > 0 ? (
        <ol aria-label="Уведомления выбранного проекта" className="space-y-3">
          {notifications.map((notification) => {
            const unread = notification.readAt == null;
            const copy = projectNotificationCopy(notification);
            const href = projectNotificationDestination(notification);
            const busy = markingId === notification.id;
            return (
              <li
                key={notification.id}
                className={cn(
                  "rounded-md p-4",
                  unread ? "bg-info-soft" : "bg-surface-inset/75",
                )}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  {unread ? (
                    <Badge tone="brand">Новое</Badge>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-text-2">
                      <Check className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      Прочитано
                    </span>
                  )}
                  <time
                    dateTime={notification.createdAt}
                    suppressHydrationWarning
                    className="nums text-[12px] text-text-2"
                  >
                    {notificationDate(notification.createdAt)}
                  </time>
                </div>
                <h3 className="mt-3 text-[15px] leading-snug font-semibold text-text text-pretty">
                  {copy.title}
                </h3>
                <p className="mt-1.5 text-[14px] leading-relaxed text-text-2 text-pretty break-words">
                  {copy.description}
                </p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  {href ? (
                    <Link
                      href={href}
                      onClick={(event) => onOpenNotification(event, notification, href)}
                      className="inline-flex min-h-11 items-center gap-1.5 rounded-xs bg-surface px-3.5 text-[13px] font-semibold text-text shadow-sm transition-colors duration-150 hover:text-brand focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-brand/15"
                    >
                      Открыть
                      <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
                    </Link>
                  ) : null}
                  {unread ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      loading={busy}
                      onClick={() => onMarkRead(notification)}
                    >
                      {!busy ? <Check className="h-4 w-4" strokeWidth={2} aria-hidden /> : null}
                      Отметить прочитанным
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ol>
      ) : null}

      {inbox?.hasMore ? (
        <Button
          type="button"
          variant="outline"
          className="mt-4 w-full"
          loading={loadingMore}
          onClick={onLoadMore}
        >
          Показать ещё
        </Button>
      ) : null}

      {inbox && inbox.unreadCount > 0 ? (
        <div className="mt-5 rounded-md bg-surface-inset p-3 text-[13px] leading-relaxed text-text-2">
          <p>
            Непрочитанных: <span className="nums font-semibold text-text">{inbox.unreadCount}</span>
          </p>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="mt-1"
            loading={markingAll}
            onClick={onMarkAll}
          >
            {!markingAll ? <CheckCheck className="h-4 w-4" strokeWidth={2} aria-hidden /> : null}
            Отметить все прочитанными
          </Button>
        </div>
      ) : null}
    </div>
  );
}

export function ProjectNotificationsInbox() {
  const router = useRouter();
  const projects = useProjects();
  const projectId = projects.current?.id ?? null;
  const dialogId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  const currentProjectRef = useRef<number | null>(projectId);
  const requestSequence = useRef(0);
  const inboxRef = useRef<ClientProjectNotificationInbox | null>(null);
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [inbox, setInbox] = useState<ClientProjectNotificationInbox | null>(null);
  const [error, setError] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [markingId, setMarkingId] = useState<number | null>(null);
  const [markingAll, setMarkingAll] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSequence.current += 1;
    };
  }, []);

  useEffect(() => {
    inboxRef.current = inbox;
  }, [inbox]);

  const loadPage = useCallback(async (append = false) => {
    const expectedProjectId = projectId;
    if (expectedProjectId == null) return false;
    const cursor = append ? inboxRef.current?.nextCursor ?? null : null;
    if (append && cursor == null) return false;
    const sequence = ++requestSequence.current;
    if (append) setLoadingMore(true);
    else if (inboxRef.current == null) setState("loading");
    setError("");
    try {
      const result = await loadProjectNotifications({ limit: 20, beforeId: cursor });
      if (
        !mountedRef.current
        || sequence !== requestSequence.current
        || currentProjectRef.current !== expectedProjectId
        || result.projectId !== expectedProjectId
      ) return false;
      setInbox((current) => {
        if (!append || !current || current.projectId !== result.projectId) return result;
        const seen = new Set(current.notifications.map((item) => item.id));
        return {
          ...result,
          notifications: [
            ...current.notifications,
            ...result.notifications.filter((item) => !seen.has(item.id)),
          ],
        };
      });
      setState("ready");
      return true;
    } catch (loadError) {
      if (
        !mountedRef.current
        || sequence !== requestSequence.current
        || currentProjectRef.current !== expectedProjectId
      ) return false;
      setError(projectNotificationErrorMessage(loadError));
      setState("error");
      return false;
    } finally {
      if (mountedRef.current && sequence === requestSequence.current) setLoadingMore(false);
    }
  }, [projectId]);

  useEffect(() => {
    currentProjectRef.current = projectId;
    requestSequence.current += 1;
    queueMicrotask(() => {
      if (!mountedRef.current || currentProjectRef.current !== projectId) return;
      inboxRef.current = null;
      setInbox(null);
      setError("");
      setState(projectId == null ? "idle" : "loading");
      setMarkingId(null);
      setMarkingAll(false);
      if (projectId != null) void loadPage(false);
    });
  }, [loadPage, projectId]);

  useEffect(() => {
    if (projectId == null) return;
    const refresh = () => void loadPage(false);
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [loadPage, projectId]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const openInbox = useCallback(() => {
    setOpen(true);
    void loadPage(false);
  }, [loadPage]);

  const closeInbox = useCallback(() => setOpen(false), []);

  const markRead = useCallback(async (notification: ClientProjectNotification) => {
    if (markingId != null || notification.readAt != null) return false;
    const expectedProjectId = projectId;
    if (expectedProjectId == null || notification.projectId !== expectedProjectId) return false;
    setMarkingId(notification.id);
    setError("");
    try {
      const result = await markClientProjectNotificationRead(notification.id);
      if (!mountedRef.current || currentProjectRef.current !== expectedProjectId || result.projectId !== expectedProjectId) {
        return false;
      }
      setInbox((current) => current && current.projectId === result.projectId ? {
        ...current,
        unreadCount: result.unreadCount,
        notifications: current.notifications.map((item) => item.id === result.notificationId
          ? { ...item, readAt: result.readAt }
          : item),
      } : current);
      setStatusMessage("Уведомление отмечено прочитанным.");
      return true;
    } catch (markError) {
      if (mountedRef.current && currentProjectRef.current === expectedProjectId) {
        setError(projectNotificationErrorMessage(markError));
      }
      return false;
    } finally {
      if (mountedRef.current && currentProjectRef.current === expectedProjectId) setMarkingId(null);
    }
  }, [markingId, projectId]);

  const markAll = useCallback(async () => {
    if (markingAll || projectId == null) return;
    const expectedProjectId = projectId;
    setMarkingAll(true);
    setError("");
    try {
      const result = await markAllClientProjectNotificationsRead();
      if (!mountedRef.current || currentProjectRef.current !== expectedProjectId || result.projectId !== expectedProjectId) return;
      const readAt = new Date().toISOString();
      setInbox((current) => current && current.projectId === result.projectId ? {
        ...current,
        unreadCount: 0,
        notifications: current.notifications.map((item) => item.readAt == null ? { ...item, readAt } : item),
      } : current);
      setStatusMessage("Все уведомления отмечены прочитанными.");
    } catch (markError) {
      if (mountedRef.current && currentProjectRef.current === expectedProjectId) {
        setError(projectNotificationErrorMessage(markError));
      }
    } finally {
      if (mountedRef.current && currentProjectRef.current === expectedProjectId) setMarkingAll(false);
    }
  }, [markingAll, projectId]);

  const openNotification = useCallback(async (
    event: ReactMouseEvent<HTMLAnchorElement>,
    notification: ClientProjectNotification,
    href: string,
  ) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    if (notification.readAt != null) {
      closeInbox();
      return;
    }
    event.preventDefault();
    if (await markRead(notification)) {
      closeInbox();
      router.push(href);
    }
  }, [closeInbox, markRead, router]);

  const unreadCount = inbox?.projectId === projectId ? inbox.unreadCount : 0;
  const displayedCount = unreadCount > 99 ? "99+" : String(unreadCount);
  const triggerLabel = projectId == null
    ? "Уведомления недоступны: выберите проект"
    : inbox?.projectId === projectId
      ? unreadAccessibleLabel(unreadCount)
      : state === "error"
        ? "Уведомления: не удалось загрузить"
        : "Уведомления: загружаем";

  return (
    <>
      <span role="status" aria-live="polite" className="sr-only">{statusMessage}</span>
      <Button
        ref={triggerRef}
        type="button"
        variant="ghost"
        size="icon"
        disabled={projectId == null}
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={dialogId}
        title="Уведомления"
        onClick={openInbox}
      >
        <Bell className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        {unreadCount > 0 ? (
          <span
            aria-hidden
            className="nums absolute -top-1 -right-1 inline-flex min-h-5 min-w-5 items-center justify-center rounded-full bg-brand px-1 text-[11px] leading-none font-bold text-white shadow-sm"
          >
            {displayedCount}
          </span>
        ) : null}
      </Button>

      <dialog
        ref={dialogRef}
        id={dialogId}
        aria-labelledby={`${dialogId}-title`}
        aria-describedby={descriptionId}
        onCancel={(event) => {
          event.preventDefault();
          closeInbox();
        }}
        onClose={() => {
          setOpen(false);
          triggerRef.current?.focus();
        }}
        onClick={(event) => {
          if (event.target === event.currentTarget) closeInbox();
        }}
        className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-hidden rounded-lg border border-line bg-surface p-0 text-text shadow-float backdrop:bg-text/40 backdrop:backdrop-blur-sm"
      >
        <div className="flex max-h-[calc(100dvh-2rem)] min-h-80 flex-col">
          <header className="flex shrink-0 items-start justify-between gap-4 px-4 pt-4 pb-3 sm:px-5 sm:pt-5">
            <div className="min-w-0 flex-1">
              <h2 id={`${dialogId}-title`} className="text-xl font-bold tracking-tight text-text text-balance">
                Уведомления
              </h2>
              <p id={descriptionId} className="mt-1 max-w-sm text-[14px] leading-relaxed text-text-3 text-pretty">
                Согласования, комментарии и напоминания выбранного проекта.
              </p>
            </div>
            <Button
              autoFocus
              type="button"
              variant="ghost"
              size="icon"
              onClick={closeInbox}
              aria-label="Закрыть уведомления"
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </Button>
          </header>

          <ProjectNotificationsInboxPanel
            inbox={inbox}
            state={state}
            error={error}
            markingId={markingId}
            markingAll={markingAll}
            loadingMore={loadingMore}
            onRetry={() => void loadPage(false)}
            onMarkRead={(notification) => void markRead(notification)}
            onMarkAll={() => void markAll()}
            onLoadMore={() => void loadPage(true)}
            onOpenNotification={openNotification}
          />
        </div>
      </dialog>
    </>
  );
}
