"use client";

// А4. Календарь — ГЛАВНЫЙ экран платформы (ТЗ 5.3, Приложение А).
// Одно главное действие: создать пост кликом в день. Публикует сервер.

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  BarChart3,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Flame,
  GripVertical,
  Inbox,
  LayoutGrid,
  Lightbulb,
  List,
  Plus,
  RotateCw,
  Send,
  Sparkles,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { useProjects } from "@/components/app/project-provider";
import {
  calendarProjectExportPeriod,
  ProjectExportButton,
} from "@/components/app/project-export-button";
import {
  PublicationActionsDialog,
  type PublicationActionTarget,
  type PublicationRescheduleInput,
} from "@/components/app/publication-actions-dialog";
import { Button, buttonClassName } from "@/components/ui/button";
import {
  Badge,
  Card,
  EmptyState,
  Tabs,
  TelegramIcon,
  VkIcon,
} from "@/components/ui/primitives";
import {
  claimUnownedLegacyDraft,
  DraftRequestError,
  isRecoverableLegacyDraft,
  isUnownedLegacyDraftCandidate,
  listServerDrafts,
  rescheduleServerDraft,
} from "@/lib/draft-client";
import type { ServerDraft } from "@/lib/draft-types";
import {
  calendarAuthorOptions,
  calendarRecordMatches,
  calendarRecordStatus,
} from "@/lib/calendar-team-filters";
import type { ClientProjectRole } from "@/lib/project-client";
import {
  resolveCalendarDayMove,
  withOptimisticCalendarSchedule,
} from "@/lib/calendar-drag-reschedule";
import {
  calendarDragAutoScrollDelta,
  createCalendarLongPressDrag,
  type CalendarDragPoint,
} from "@/lib/calendar-long-press-drag";
import {
  calendarDateKey,
  calendarDateKeyForInstant,
  calendarDayForInstant,
} from "@/lib/calendar-timezone";
import { useStore } from "@/lib/store";
import {
  cancelPublication,
  reschedulePublication,
  restorePublicationToDraft,
} from "@/lib/publication-lifecycle-client";
import type { Network, Post, RealPost, Trend, User } from "@/lib/types";
import { ScheduleValidationError } from "@/lib/timezone-schedule";
import {
  addDays,
  channelHue,
  cn,
  fmtCompact,
  fmtDate,
  fmtDateTime,
  fmtTime,
  initials,
  NETWORK_LABEL,
  plural,
  sameDay,
  startOfWeek,
  weekdayFull,
  weekdayShort,
} from "@/lib/utils";

/* ------------------------------------------------------------- ОСНОВЫ */

type View = "week" | "month" | "list";

type CalendarPost = Post & {
  authorUserId?: number;
  authorName?: string;
  calendarStatus?: string;
  serverDraftId?: number;
  draftVersion?: number;
  destinationIds?: number[];
  publicationParts?: RealPost["publication_parts"];
  publicationOperationId?: number;
  operationStatus?: string;
  operationScheduleRevision?: number;
  scheduleTimezone?: string;
  scheduledOffset?: string | null;
  scheduleDisambiguation?: "reject" | "earlier" | "later";
};

/** Пост с датой — только такие живут в сетке */
type DatedPost = CalendarPost & { scheduledAt: string };

/** Черновик с датой обязан быть виден в сетке, а не исчезать между разделами. */
const GRID_STATUSES: Post["status"][] = [
  "draft",
  "scheduled",
  "publishing",
  "published_unverified",
  "published",
  "missing",
  "deleted_external",
  "failed_retry",
  "quarantined",
  "cancelled",
  "failed",
];

const DEFAULT_TIME = "10:00";
const EASE_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];
const CALENDAR_DRAG_HELP_ID = "calendar-drag-help";

type CalendarDragOrigin = Readonly<{
  point: CalendarDragPoint;
  rect: Readonly<{
    left: number;
    top: number;
    width: number;
    height: number;
  }>;
}>;

type CalendarDragPreview = Readonly<{
  postId: string;
  point: CalendarDragPoint;
  offsetX: number;
  offsetY: number;
  width: number;
}>;

const CALENDAR_STATUS_LABEL: Record<string, string> = {
  draft: "Черновик",
  in_review: "На согласовании",
  changes_requested: "Нужны правки",
  approved: "Согласовано",
  scheduled: "Запланировано",
  publishing: "Публикуется",
  published_unverified: "Ждёт подтверждения",
  published: "Опубликовано",
  missing: "Не найдено на площадке",
  deleted_external: "Удалено на площадке",
  failed_retry: "Повтор публикации",
  quarantined: "Нужна новая дата",
  cancelled: "Отменено",
  failed: "Ошибка публикации",
};

type CalendarEditorialStatus = NonNullable<ServerDraft["editorial_state"]>;

function calendarRoleCapabilities(role: ClientProjectRole | null | undefined) {
  return {
    canEdit: role === "owner" || role === "author" || role === "approver",
    canPublish: role === "owner" || role === "publisher",
  };
}

function calendarQueueAction(
  role: ClientProjectRole | null | undefined,
  status: CalendarEditorialStatus,
) {
  const { canPublish } = calendarRoleCapabilities(role);
  if (canPublish && status === "approved") {
    return { kind: "schedule", label: "Запланировать" } as const;
  }
  if (role === "publisher" || role === "approver" || status === "approved") {
    return { kind: "review", label: "Проверить" } as const;
  }
  return { kind: "open", label: "Открыть" } as const;
}

function calendarStatusTone(status: string): "brand" | "success" | "danger" | "neutral" {
  if (status === "approved" || status === "published") return "success";
  if (status === "changes_requested" || status === "failed" || status === "quarantined") {
    return "danger";
  }
  if (status === "in_review" || status === "scheduled" || status === "publishing") {
    return "brand";
  }
  return "neutral";
}

const isOnGrid = (p: CalendarPost): p is DatedPost =>
  typeof p.scheduledAt === "string" && GRID_STATUSES.includes(p.status);

// Ссылка на вышедший пост по сети: TG — t.me/<handle>/<id>, VK — vk.com/wall-<gid>_<pid>.
// Без handle (TG) или id записи ссылку не построить — тогда null, карточка живёт без неё.
function postUrlFor(rp: RealPost): string | undefined {
  if (rp.status !== "published" || rp.verification_state !== "verified") return undefined;
  if (rp.network === "vk") {
    return rp.vk_group_id != null && rp.vk_post_id != null
      ? `https://vk.com/wall-${rp.vk_group_id}_${rp.vk_post_id}`
      : undefined;
  }
  return rp.handle && rp.tg_message_id != null
    ? `https://t.me/${rp.handle.replace(/^@/, "")}/${rp.tg_message_id}`
    : undefined;
}

// Настоящий пост из базы → форма Post для карточек календаря (Д.3).
// id с префиксом real-, чтобы отличать от демо и доставать числовой id для повтора.
function realToPost(rp: RealPost): CalendarPost {
  return {
    id: `real-${rp.id}`,
    authorUserId: rp.author_user_id,
    authorName: rp.author_name,
    calendarStatus: rp.status,
    text: rp.text,
    networks: [rp.network],
    scheduledAt: rp.scheduled_at,
    status: rp.status,
    origin: rp.publication_origin === "rss" || rp.publication_origin === "retry" || rp.publication_origin === "legacy"
      ? "manual"
      : rp.publication_origin,
    media: null,
    attempts: rp.attempts,
    failReason: rp.last_error ?? undefined,
    createdAt: rp.created_at,
    channelTitle: rp.channel_title ?? undefined,
    channelId: rp.channel_id ?? undefined,
    postUrl: postUrlFor(rp),
    verificationState: rp.verification_state,
    publicationParts: rp.publication_parts,
    publicationOperationId: rp.publication_operation_id ?? undefined,
    operationStatus: rp.publication_operation_status ?? undefined,
    operationScheduleRevision: rp.operation_schedule_revision ?? undefined,
    scheduleTimezone: rp.scheduled_timezone ?? undefined,
    scheduledOffset: rp.scheduled_offset,
    scheduleDisambiguation: rp.scheduled_disambiguation ?? undefined,
  };
}

function serverDraftToPost(draft: ServerDraft): CalendarPost {
  const networks = [...new Set(draft.destinations.map((destination) => destination.network))];
  return {
    id: `draft-${draft.id}`,
    authorUserId: draft.author_user_id,
    authorName: draft.author_name,
    calendarStatus: draft.editorial_state ?? "draft",
    text: draft.text,
    networks,
    scheduledAt: draft.scheduled_at,
    status: "draft",
    origin: draft.origin,
    sourceRef: draft.source_ref ?? undefined,
    media: draft.media,
    createdAt: draft.created_at,
    serverDraftId: draft.id,
    draftVersion: draft.version,
    scheduleTimezone: draft.scheduled_timezone ?? undefined,
    scheduledOffset: draft.scheduled_offset,
    scheduleDisambiguation: draft.scheduled_disambiguation ?? undefined,
    destinationIds: draft.destinations.map((destination) => destination.channel_id),
    channelId: draft.destinations.length === 1 ? draft.destinations[0].channel_id : undefined,
    channelTitle:
      draft.destinations.length === 1
        ? (draft.destinations[0].title ?? draft.destinations[0].handle ?? undefined)
        : undefined,
  };
}

/** Достаём числовой id настоящего поста из «real-N». */
const realId = (id: string) => Number(id.replace(/^real-/, ""));

const dayKey = calendarDateKey;

/** Новый пост на конкретный день: сразу отдаём редактору дату и время */
const composerForDay = (day: Date) => {
  const localDate = calendarDateKey(day);
  return `/app/composer?date=${localDate}&time=${DEFAULT_TIME}`;
};

/** «14–20 июля», а на стыке месяцев — «29 июня – 5 июля» */
function weekRangeLabel(start: Date) {
  const end = addDays(start, 6);
  const endLabel = fmtDate(end.toISOString());
  if (start.getMonth() === end.getMonth()) return `${start.getDate()}–${endLabel}`;
  return `${fmtDate(start.toISOString())} – ${endLabel}`;
}

/** «Июль 2026» */
function monthTitle(d: Date) {
  const name = new Intl.DateTimeFormat("ru-RU", { month: "long" }).format(d);
  return `${name.charAt(0).toUpperCase()}${name.slice(1)} ${d.getFullYear()}`;
}

function isoWeekNumber(date: Date) {
  const utc = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil((((utc.getTime() - yearStart.getTime()) / 86_400_000) + 1) / 7);
}

/** 7.8 → «×7,8» */
const fmtMultiplier = (m: number) => `×${String(m).replace(".", ",")}`;

/* ------------------------------------------------------ МЕЛКИЕ КУСОЧКИ */

function NetworkChips({ networks }: { networks: Network[] }) {
  return (
    <span className="flex shrink-0 items-center gap-1 text-text-3">
      {networks.map((n) => (
        <span key={n} className="inline-flex" title={NETWORK_LABEL[n]}>
          {n === "tg" ? (
            <TelegramIcon className="h-3 w-3" />
          ) : (
            <VkIcon className="h-3 w-3" />
          )}
          <span className="sr-only">{NETWORK_LABEL[n]}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Метка канала на карточке.
 *
 * Раньше здесь был текстовый чип с именем — и в узкой колонке недели он обрезался
 * до «Техн…», а два канала на «Т» становились неразличимы. Лечить это тултипом нельзя:
 * NN/g отвергает ховер-подсказки — растёт interaction cost, и на тач-устройствах их
 * просто нет. Поэтому идентификатор нередуцируемый: инициалы видны всегда и не режутся.
 *
 * Цвет — второй слой, не первый: по WCAG 1.4.1 (уровень A) цвет не может быть
 * единственным признаком, а в этом календаре цветовой бюджет уже занят статусом поста
 * (зелёная галочка — вышел, красный треугольник — сбой, янтарь — залёт).
 * Полное имя не пропадает — оно уходит скринридеру.
 */
function ChannelAvatar({ title, id }: { title: string; id: number | string }) {
  const hue = channelHue(id);
  return (
    <span
      className="inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-full text-[10px] leading-none font-bold"
      style={{
        // Одинаковая светлота у всех каналов: иначе оттенок начнёт спорить со статусом
        backgroundColor: `oklch(0.92 0.06 ${hue})`,
        color: `oklch(0.42 0.13 ${hue})`,
      }}
      aria-hidden
    >
      {initials(title)}
    </span>
  );
}

/** Связка «разведка → контент»: откуда взялся пост */
function SourceBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1 rounded-full bg-fire-soft px-1.5 py-0.5 text-[13px] leading-tight font-semibold text-fire-text">
      <Flame className="h-3 w-3 shrink-0" strokeWidth={2.5} aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

/* -------------------------------------------------- КАРТОЧКА ПОСТА В ДНЕ */

function PostCard({
  post,
  onOpen,
  onRetry,
  onReschedule,
  onRequestMove,
  canMove = false,
  moving = false,
  dragging = false,
  moveBlockedReason,
  onPointerDragStart,
  onPointerDragMove,
  onPointerDragEnd,
  onPointerDragCancel,
  calendarTimezone,
}: {
  post: DatedPost;
  onOpen: () => void;
  onRetry?: () => void;
  onReschedule?: () => void;
  onRequestMove?: () => void;
  canMove?: boolean;
  moving?: boolean;
  dragging?: boolean;
  moveBlockedReason?: string;
  onPointerDragStart?: (post: DatedPost, origin: CalendarDragOrigin) => boolean;
  onPointerDragMove?: (post: DatedPost, point: CalendarDragPoint) => void;
  onPointerDragEnd?: (post: DatedPost, point: CalendarDragPoint) => void;
  onPointerDragCancel?: () => void;
  calendarTimezone: string;
}) {
  // Метка канала нужна только при мультиканальности. Считаем здесь, а не прокидываем
  // пропом через календарь → неделю → день → карточку: стор всё равно контекст.
  const store = useStore();
  // Мультиканальность — по всем активным каналам (TG + VK): метка канала нужна,
  // когда их больше одного, независимо от сети.
  const multiChannel = store.realChannels.filter((c) => c.is_active).length > 1;
  const failed = post.status === "failed";
  const publishing = post.status === "publishing";
  const retrying = post.status === "failed_retry";
  const quarantined = post.status === "quarantined";
  const published = post.status === "published";
  const missing = post.status === "missing" || post.status === "deleted_external";
  const unverified = post.status === "published_unverified";
  const cancelled = post.status === "cancelled";
  const visibleStatus = calendarRecordStatus(post);
  const reduceMotion = useReducedMotion();
  const touchMoveBlockerRef = useRef<((event: TouchEvent) => void) | null>(null);
  const suppressOpenUntilRef = useRef(0);
  const dragRectRef = useRef<CalendarDragOrigin["rect"] | null>(null);
  const activePointerTypeRef = useRef("");

  const unlockTouchScroll = useCallback(() => {
    const blocker = touchMoveBlockerRef.current;
    if (!blocker) return;
    window.removeEventListener("touchmove", blocker);
    touchMoveBlockerRef.current = null;
  }, []);

  const lockTouchScroll = useCallback(() => {
    if (touchMoveBlockerRef.current) return;
    const blocker = (event: TouchEvent) => event.preventDefault();
    touchMoveBlockerRef.current = blocker;
    window.addEventListener("touchmove", blocker, { passive: false });
  }, []);

  const pointerDragRef = useRef<ReturnType<typeof createCalendarLongPressDrag> | null>(null);

  useEffect(() => {
    const pointerDrag = createCalendarLongPressDrag({
      onActivate: (point) => {
        const rect = dragRectRef.current;
        if (!canMove || !rect || onPointerDragStart?.(post, { point, rect }) !== true) {
          return false;
        }
        if (activePointerTypeRef.current !== "mouse") lockTouchScroll();
        return true;
      },
      onMove: (point) => onPointerDragMove?.(post, point),
      onDrop: (point) => {
        unlockTouchScroll();
        onPointerDragEnd?.(post, point);
      },
      onCancel: () => {
        unlockTouchScroll();
        onPointerDragCancel?.();
      },
    }, { mouseActivation: "threshold" });
    pointerDragRef.current = pointerDrag;

    return () => {
      pointerDrag.dispose();
      if (pointerDragRef.current === pointerDrag) pointerDragRef.current = null;
      unlockTouchScroll();
    };
  }, [
    canMove,
    lockTouchScroll,
    onPointerDragCancel,
    onPointerDragEnd,
    onPointerDragMove,
    onPointerDragStart,
    post,
    unlockTouchScroll,
  ]);

  useEffect(() => {
    const pointerDrag = pointerDragRef.current;
    if (!dragging && pointerDrag?.isActive()) pointerDrag.cancel();
  }, [dragging]);

  const pointerPoint = (event: ReactPointerEvent<HTMLElement>): CalendarDragPoint => ({
    clientX: event.clientX,
    clientY: event.clientY,
  });

  const releasePointer = (event: ReactPointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
    event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const startPointerSession = (
    event: ReactPointerEvent<HTMLElement>,
    allowMouse: boolean,
  ) => {
    if (!canMove || moving || event.button !== 0 || (!allowMouse && event.pointerType === "mouse")) {
      return;
    }
    const article = event.currentTarget.closest<HTMLElement>("[data-calendar-card]");
    const rect = article?.getBoundingClientRect();
    if (!rect) return;
    dragRectRef.current = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    activePointerTypeRef.current = event.pointerType;
    const started = pointerDragRef.current?.pointerDown({
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      isPrimary: event.isPrimary,
      point: pointerPoint(event),
    });
    if (started) event.currentTarget.setPointerCapture(event.pointerId);
  };

  const movePointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const result = pointerDragRef.current?.pointerMove({
      pointerId: event.pointerId,
      point: pointerPoint(event),
    });
    if (result === "dragging") event.preventDefault();
    if (result === "cancelled") releasePointer(event);
  };

  const endPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const dragged = pointerDragRef.current?.pointerUp({
      pointerId: event.pointerId,
      point: pointerPoint(event),
    }) === true;
    if (dragged) {
      suppressOpenUntilRef.current = Date.now() + 700;
      event.preventDefault();
    }
    releasePointer(event);
  };

  const cancelPointerSession = (event: ReactPointerEvent<HTMLElement>) => {
    const dragged = pointerDragRef.current?.pointerCancel(event.pointerId) === true;
    if (dragged) suppressOpenUntilRef.current = Date.now() + 700;
    releasePointer(event);
  };

  return (
    <motion.article
      id={`calendar-${post.id}`}
      tabIndex={-1}
      layout="position"
      layoutId={`calendar-card-${post.id}`}
      transition={{ layout: { duration: reduceMotion ? 0 : 0.28, ease: EASE_SOFT } }}
      data-calendar-card
      data-calendar-draggable={canMove && !moving ? "true" : undefined}
      data-calendar-dragging={dragging ? "true" : undefined}
      aria-busy={moving || undefined}
      className={cn(
        "relative min-w-0 rounded-sm border-l-2 shadow-soft ring-1 ring-line",
        "transition-[transform,box-shadow,opacity,border-color] duration-200 ease-[var(--ease-soft)] motion-reduce:transition-none",
        !dragging && "hover:-translate-y-0.5 hover:shadow-card",
        canMove && !moving && "cursor-grab select-none active:cursor-grabbing",
        dragging && "scale-[0.985] border-dashed opacity-20 shadow-none ring-2 ring-brand/45",
        moving && "pointer-events-none opacity-55",
        failed || missing || quarantined
          ? "border-danger bg-danger-soft"
          : cancelled
            ? "border-line-strong bg-surface-2"
          : published
            ? "border-success bg-surface"
            : unverified
              ? "border-fire bg-fire-soft"
            : "border-brand bg-surface",
      )}
    >
      {/* Клик по всей карточке открывает публикацию или черновик в редакторе. */}
      <button
        id={`calendar-open-${post.id}`}
        type="button"
        onClick={(event) => {
          if (Date.now() < suppressOpenUntilRef.current) {
            event.preventDefault();
            event.stopPropagation();
            return;
          }
          onOpen();
        }}
        onPointerDown={(event) => startPointerSession(event, false)}
        onPointerMove={movePointerSession}
        onPointerUp={endPointerSession}
        onPointerCancel={cancelPointerSession}
        onLostPointerCapture={cancelPointerSession}
        onContextMenu={(event) => {
          if (pointerDragRef.current?.isActive()) event.preventDefault();
        }}
        aria-label={post.serverDraftId != null
          ? `Открыть черновик в редакторе: ${post.text.slice(0, 60)}`
          : `Открыть публикацию: ${post.text.slice(0, 60)}`}
        aria-describedby={canMove ? CALENDAR_DRAG_HELP_ID : undefined}
        title={!canMove ? moveBlockedReason : undefined}
        className={cn(
          "absolute inset-0 z-0 min-h-11 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
          canMove ? "cursor-pointer touch-pan-y" : "cursor-pointer",
        )}
      />

      <div className="pointer-events-none relative z-10 flex min-w-0 flex-col gap-1.5 p-2.5">
        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <span className="flex items-center gap-1">
            {published && (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" strokeWidth={2.5} aria-hidden />
            )}
            {failed && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-danger"
                strokeWidth={2}
                aria-hidden
              />
            )}
            {quarantined && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-danger"
                strokeWidth={2}
                aria-hidden
              />
            )}
            {missing && (
              <AlertTriangle
                className="h-3.5 w-3.5 shrink-0 text-danger"
                strokeWidth={2}
                aria-hidden
              />
            )}
            <span className="nums text-[13px] font-bold text-text">
              {fmtTime(post.scheduledAt, post.scheduleTimezone ?? calendarTimezone)}
            </span>
          </span>
          <span className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1">
            <NetworkChips networks={post.networks} />
            {canMove && (
              <button
                type="button"
                className="pointer-events-auto relative z-20 flex min-h-11 min-w-11 cursor-grab touch-none items-center justify-center rounded-xs text-text-3 transition-colors duration-150 hover:bg-brand/10 hover:text-brand focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:cursor-grabbing motion-reduce:transition-none"
                aria-label={`Перетащить или выбрать другой день: ${post.text.slice(0, 60)}`}
                aria-haspopup="dialog"
                title="Перетащить или выбрать другой день"
                onPointerDown={(event) => startPointerSession(event, true)}
                onPointerMove={movePointerSession}
                onPointerUp={endPointerSession}
                onPointerCancel={cancelPointerSession}
                onLostPointerCapture={cancelPointerSession}
                onClick={(event) => {
                  if (Date.now() < suppressOpenUntilRef.current) {
                    event.preventDefault();
                    return;
                  }
                  onRequestMove?.();
                }}
              >
                <GripVertical className="h-4 w-4" strokeWidth={2} />
              </button>
            )}
            {moving && (
              <RotateCw className="h-3.5 w-3.5 animate-spin text-brand" strokeWidth={2} aria-hidden />
            )}
          </span>
        </div>

        <Badge
          tone={calendarStatusTone(visibleStatus)}
          className="max-w-full self-start whitespace-normal leading-tight"
        >
          {CALENDAR_STATUS_LABEL[visibleStatus] ?? visibleStatus}
        </Badge>

        {/* Канал показываем только когда их несколько: при одном это очевидно и лишь шумит */}
        {multiChannel && post.channelTitle && (
          <span className="flex items-center gap-1.5">
            <ChannelAvatar title={post.channelTitle} id={post.channelId ?? post.channelTitle} />
            <span className="sr-only">Канал: {post.channelTitle}</span>
          </span>
        )}

        <p className="line-2 text-[13px] leading-snug text-text-2">{post.text}</p>

        {unverified && (
          <span className="text-[13px] font-semibold text-fire-text">
            Отправлено, подтверждение внешней сети ещё не получено
          </span>
        )}

        {post.publicationParts && post.publicationParts.length > 1 && (
          <span className="text-[13px] font-medium text-text-3">
            Telegram: {post.publicationParts.filter((part) => part.sendStatus === "sent").length}
            /{post.publicationParts.length} частей подтверждено
          </span>
        )}

        {missing && (
          <span className="text-[13px] font-semibold text-danger-text">
            Сообщение не найдено во внешнем канале и исключено из аналитики
          </span>
        )}

        {retrying && (
          <span className="text-[13px] font-semibold text-fire-text">
            Временный сбой: сервер повторит отправку по своему таймеру
          </span>
        )}

        {publishing && (
          <span aria-live="polite" className="text-[13px] font-semibold text-brand">
            Публикация готовится к отправке. Статус обновится автоматически.
          </span>
        )}

        {quarantined && (
          <span className="text-[13px] font-semibold text-danger-text">
            Дата истекла. Пост не будет отправлен без нового подтверждения.
          </span>
        )}

        {cancelled && (
          <span className="text-[13px] font-semibold text-text-2">
            Отменена. Старая задача больше не может отправить этот пост.
          </span>
        )}

        {post.sourceRef && <SourceBadge label={post.sourceRef.label} />}

        {published && post.metrics && (
          <span className="flex items-center gap-1 text-[13px] font-medium text-text-3">
            <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            <span className="nums">{fmtCompact(post.metrics.views)}</span>
          </span>
        )}

        {/* Пост вышел — даём открыть его в самой сети (только настоящие посты, у демо нет ссылки) */}
        {published && post.postUrl && (
          <a
            href={post.postUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="pointer-events-auto relative z-20 inline-flex min-h-11 items-center gap-1 self-start rounded-xs px-1 text-[13px] font-semibold text-brand transition-opacity duration-200 hover:opacity-70 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
          >
            Открыть пост
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </a>
        )}

        {/* Сбой: что случилось → что делаем → что нужно от тебя (ТЗ 7.5) */}
        {failed && onRetry && (
          <>
            {post.failReason && (
              <p className="text-[13px] leading-snug font-medium text-danger-text">
                {post.failReason}
              </p>
            )}
            <Button
              variant="danger"
              size="sm"
              onClick={onRetry}
              className="pointer-events-auto mt-0.5 w-full"
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
              Ещё раз
            </Button>
          </>
        )}
        {quarantined && onReschedule && (
          <Button
            variant="danger"
            size="sm"
            onClick={onReschedule}
            className="pointer-events-auto mt-0.5 w-full"
          >
            <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Перенести на 2 минуты
          </Button>
        )}
      </div>
    </motion.article>
  );
}

function CalendarDragOverlay({
  preview,
  post,
  calendarTimezone,
  reduceMotion,
}: {
  preview: CalendarDragPreview | null;
  post: DatedPost | null;
  calendarTimezone: string;
  reduceMotion: boolean;
}) {
  const failed = post?.status === "failed";
  const quarantined = post?.status === "quarantined";
  const missing = post?.status === "missing" || post?.status === "deleted_external";
  const cancelled = post?.status === "cancelled";
  const published = post?.status === "published";
  const unverified = post?.status === "published_unverified";

  return (
    <AnimatePresence>
      {preview && post && (
        <motion.div
          key={preview.postId}
          aria-hidden
          initial={reduceMotion ? false : { opacity: 0, scale: 0.96 }}
          animate={{ opacity: 0.98, scale: reduceMotion ? 1 : 1.025 }}
          exit={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.98 }}
          transition={{ duration: reduceMotion ? 0 : 0.16, ease: EASE_SOFT }}
          style={{
            width: preview.width,
            x: preview.point.clientX - preview.offsetX,
            y: preview.point.clientY - preview.offsetY,
          }}
          className={cn(
            "pointer-events-none fixed left-0 top-0 z-[120] min-w-0 will-change-transform rounded-sm border-l-2 p-2.5 shadow-[0_18px_48px_rgba(15,23,42,0.22)] ring-2 ring-brand/55",
            failed || missing || quarantined
              ? "border-danger bg-danger-soft"
              : cancelled
                ? "border-line-strong bg-surface-2"
                : published
                  ? "border-success bg-surface"
                  : unverified
                    ? "border-fire bg-fire-soft"
                    : "border-brand bg-surface",
          )}
        >
          <div className="flex min-w-0 items-center justify-between gap-2">
            <span className="nums text-[13px] font-bold text-text">
              {fmtTime(post.scheduledAt, post.scheduleTimezone ?? calendarTimezone)}
            </span>
            <span className="flex items-center gap-1 text-brand">
              <NetworkChips networks={post.networks} />
              <GripVertical className="h-4 w-4 shrink-0" strokeWidth={2} />
            </span>
          </div>
          <Badge
            tone={calendarStatusTone(calendarRecordStatus(post))}
            className="mt-1.5 max-w-full whitespace-normal leading-tight"
          >
            {CALENDAR_STATUS_LABEL[calendarRecordStatus(post)] ?? calendarRecordStatus(post)}
          </Badge>
          <p className="mt-1.5 line-2 text-[13px] leading-snug text-text-2">{post.text}</p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function CalendarMoveDialog({
  post,
  days,
  calendarTimezone,
  canDropOn,
  onMove,
  onClose,
}: {
  post: DatedPost | null;
  days: Date[];
  calendarTimezone: string;
  canDropOn: (post: DatedPost, day: Date) => boolean;
  onMove: (post: DatedPost, day: Date) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const firstMoveRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const firstAllowedIndex = post ? days.findIndex((day) => canDropOn(post, day)) : -1;

  useEffect(() => {
    if (!post) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const frame = requestAnimationFrame(() => (firstMoveRef.current ?? closeRef.current)?.focus());
    return () => {
      cancelAnimationFrame(frame);
      const previous = previousFocusRef.current;
      // Sibling content is still inert while effect cleanups run. Restore focus on the
      // next frame, after the inert cleanup below has made the opener interactive again.
      requestAnimationFrame(() => {
        if (previous?.isConnected) previous.focus({ preventScroll: true });
      });
    };
  }, [post]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!post || !dialog) return;
    const inerted: Array<{ element: HTMLElement; previous: boolean }> = [];
    let current: HTMLElement = dialog;
    while (current.parentElement) {
      const parent = current.parentElement;
      for (const sibling of parent.children) {
        if (sibling !== current && sibling instanceof HTMLElement) {
          inerted.push({ element: sibling, previous: sibling.hasAttribute("inert") });
          sibling.setAttribute("inert", "");
        }
      }
      if (parent === document.body) break;
      current = parent;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      for (const item of inerted) {
        if (!item.previous) item.element.removeAttribute("inert");
      }
      document.body.style.overflow = previousOverflow;
    };
  }, [post]);

  if (!post) return null;

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/45 p-4"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-md border-2 border-line bg-surface p-5 shadow-card"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>(
            "button:not([disabled])",
          ) ?? [])];
          if (!focusable.length) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-xl font-extrabold tracking-tight text-text">
              Перенести публикацию
            </h2>
            <p id={descriptionId} className="mt-1.5 text-pretty text-sm leading-relaxed text-text-2">
              Выберите другой день. Время {fmtTime(
                post.scheduledAt,
                post.scheduleTimezone ?? calendarTimezone,
              )} сохранится.
            </p>
          </div>
          <Button
            ref={closeRef}
            variant="ghost"
            size="sm"
            className="w-11 shrink-0 px-0"
            aria-label="Закрыть выбор дня"
            onClick={onClose}
          >
            <X className="h-4 w-4" strokeWidth={2} aria-hidden />
          </Button>
        </div>

        <p className="mt-4 line-2 rounded-sm bg-surface-2 p-3 text-[13px] leading-relaxed text-text-2">
          {post.text}
        </p>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {days.map((day, index) => {
            const allowed = canDropOn(post, day);
            const currentDay = calendarDateKeyForInstant(
              post.scheduledAt,
              post.scheduleTimezone ?? calendarTimezone,
            ) === dayKey(day);
            return (
              <button
                key={day.toISOString()}
                ref={index === firstAllowedIndex ? firstMoveRef : undefined}
                type="button"
                disabled={!allowed}
                onClick={() => onMove(post, day)}
                className="flex min-h-14 items-center justify-between gap-3 rounded-sm border border-line bg-surface px-3 py-2.5 text-left transition-[border-color,background-color,transform] duration-150 hover:-translate-y-0.5 hover:border-brand hover:bg-brand/5 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:translate-y-0 disabled:hover:border-line disabled:hover:bg-surface motion-reduce:transition-none"
              >
                <span>
                  <span className="block text-[13px] font-bold text-text">
                    {weekdayFull(index)}, {fmtDate(day.toISOString())}
                  </span>
                  <span className="mt-0.5 block text-[12px] text-text-3">
                    {currentDay ? "Текущий день" : allowed ? "Перенести сюда" : "Недоступно"}
                  </span>
                </span>
                <CalendarDays className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} aria-hidden />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ ДЕНЬ (НЕДЕЛЯ) */

function DayColumn({
  day,
  index,
  posts,
  isToday,
  isPast,
  onAdd,
  onOpen,
  onRetry,
  onReschedule,
  onRequestMove,
  canMovePost,
  moveBlockedReason,
  movingPostId,
  draggedPostId,
  dragging,
  dropActive,
  dropAllowed,
  onPostPointerDragStart,
  onPostPointerDragMove,
  onPostPointerDragEnd,
  onPostPointerDragCancel,
  calendarTimezone,
}: {
  day: Date;
  index: number;
  posts: DatedPost[];
  isToday: boolean;
  isPast: boolean;
  onAdd?: () => void;
  onOpen: (post: DatedPost) => void;
  onRetry?: (post: DatedPost) => void;
  onReschedule?: (post: DatedPost) => void;
  onRequestMove: (post: DatedPost) => void;
  canMovePost: (post: DatedPost) => boolean;
  moveBlockedReason: (post: DatedPost) => string | undefined;
  movingPostId: string | null;
  draggedPostId: string | null;
  dragging: boolean;
  dropActive: boolean;
  dropAllowed: boolean;
  onPostPointerDragStart: (post: DatedPost, origin: CalendarDragOrigin) => boolean;
  onPostPointerDragMove: (post: DatedPost, point: CalendarDragPoint) => void;
  onPostPointerDragEnd: (post: DatedPost, point: CalendarDragPoint) => void;
  onPostPointerDragCancel: () => void;
  calendarTimezone: string;
}) {
  return (
    <div
      data-calendar-day={dayKey(day)}
      className={cn(
        "group/day relative min-w-0 flex min-h-[27rem] flex-col overflow-hidden rounded-md ring-1",
        "transition-[background-color,box-shadow] duration-200 ease-[var(--ease-soft)] motion-reduce:transition-none",
        isToday ? "bg-surface ring-brand/35" : "ring-line",
        !isToday && isPast ? "bg-surface-2/50" : "bg-surface",
        dragging && dropAllowed && !dropActive && "ring-brand/25",
        dropActive && dropAllowed && "bg-brand/10 shadow-card ring-2 ring-brand",
      )}
    >
      <div className="border-b border-line px-3 py-3">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "text-[13px] font-bold",
              isToday ? "text-brand" : "text-text-2",
            )}
          >
            {weekdayShort(index)}
          </span>
          {isToday ? (
            <span className="nums flex h-7 w-7 items-center justify-center rounded-full bg-brand-gradient text-[13px] font-bold text-white">
              {day.getDate()}
            </span>
          ) : (
            <span
              className={cn(
                "nums flex h-7 w-7 items-center justify-center text-[15px] font-bold",
                isPast ? "text-text-3" : "text-text",
              )}
            >
              {day.getDate()}
            </span>
          )}
        </div>
        <p className="nums mt-1.5 text-[12px] text-text-3">
          {posts.length} {plural(posts.length, "пост", "поста", "постов")}
        </p>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 p-2">
        {dropActive && dropAllowed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="pointer-events-none absolute inset-1.5 z-30 rounded-sm border-2 border-dashed border-brand bg-brand/8 shadow-[inset_0_0_0_1px_var(--color-surface)]"
            aria-hidden
          >
            <span className="absolute inset-x-2 top-16 flex min-h-11 items-center justify-center gap-1 rounded-sm bg-surface/95 px-2 text-center text-[13px] font-semibold text-brand shadow-soft">
              <GripVertical className="h-4 w-4 shrink-0" strokeWidth={2} />
              Отпустите здесь
            </span>
          </motion.div>
        )}
        {posts.map((p) => (
          <PostCard
            key={p.id}
            post={p}
            onOpen={() => onOpen(p)}
            onRetry={onRetry ? () => onRetry(p) : undefined}
            onReschedule={onReschedule ? () => onReschedule(p) : undefined}
            onRequestMove={() => onRequestMove(p)}
            canMove={canMovePost(p)}
            moveBlockedReason={moveBlockedReason(p)}
            moving={movingPostId === p.id}
            dragging={draggedPostId === p.id}
            onPointerDragStart={onPostPointerDragStart}
            onPointerDragMove={onPostPointerDragMove}
            onPointerDragEnd={onPostPointerDragEnd}
            onPointerDragCancel={onPostPointerDragCancel}
            calendarTimezone={calendarTimezone}
          />
        ))}

        {/* Пустое место в дне — и есть кнопка «создать пост» (главное действие) */}
        {onAdd && (
          <button
            id={`calendar-add-${dayKey(day)}`}
            type="button"
            onClick={onAdd}
            aria-label={`Создать пост: ${weekdayFull(index)}, ${fmtDate(day.toISOString())}, ${DEFAULT_TIME}`}
            className={cn(
              "mt-auto flex min-h-11 cursor-pointer items-center justify-center gap-1.5 rounded-sm px-2",
              "border border-dashed transition-colors duration-150 motion-reduce:transition-none",
              posts.length === 0 && isToday
                ? "flex-1 border-brand/45 bg-brand/5 text-brand"
                : "border-transparent text-brand hover:border-brand/30 hover:bg-brand/5",
              "focus-visible:border-brand focus-visible:bg-brand/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand",
            )}
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden />
            <span className="text-[13px] font-semibold">
              {posts.length === 0 && isToday ? "Добавить пост" : "Новый пост"}
            </span>
          </button>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ СЕТКА МЕСЯЦА */

function MonthCell({
  day,
  posts,
  inMonth,
  isToday,
  onPick,
  calendarTimezone,
}: {
  day: Date;
  posts: DatedPost[];
  inMonth: boolean;
  isToday: boolean;
  onPick: () => void;
  calendarTimezone: string;
}) {
  const shown = posts.slice(0, 3);
  const rest = posts.length - shown.length;

  const dot = (p: DatedPost) =>
    p.status === "failed" || p.status === "missing" || p.status === "deleted_external"
      ? "bg-danger"
      : p.status === "published"
        ? "bg-success"
        : p.status === "published_unverified"
          ? "bg-fire"
        : "bg-brand";

  return (
    <button
      type="button"
      onClick={onPick}
      aria-label={`${fmtDate(day.toISOString())}: ${posts.length} ${plural(posts.length, "пост", "поста", "постов")}. Открыть неделю`}
      className={cn(
        "flex min-h-[68px] cursor-pointer flex-col gap-1 rounded-sm p-1.5 text-left ring-1",
        "transition-colors duration-200 md:min-h-[104px] md:p-2",
        inMonth ? "bg-surface hover:bg-surface-inset/60" : "bg-surface-2/50",
        isToday ? "ring-brand/40" : inMonth ? "ring-line" : "ring-transparent",
      )}
    >
      <span className="flex items-center justify-between gap-1">
        {isToday ? (
          <span className="nums flex h-6 w-6 items-center justify-center rounded-full bg-brand-gradient text-[13px] font-bold text-white">
            {day.getDate()}
          </span>
        ) : (
          <span
            className={cn(
              "nums flex h-6 w-6 items-center justify-center text-[13px] font-bold",
              inMonth ? "text-text" : "text-text-3",
            )}
          >
            {day.getDate()}
          </span>
        )}
        {rest > 0 && (
          <span className="nums text-[13px] font-semibold text-text-3">+{rest}</span>
        )}
      </span>

      {/* Телефон — точки, десктоп — мини-плашки */}
      <span className="flex flex-wrap items-center gap-1 md:hidden">
        {shown.map((p) => (
          <span key={p.id} className={cn("h-1.5 w-1.5 rounded-full", dot(p))} />
        ))}
      </span>

      <span className="hidden flex-col gap-1 md:flex">
        {shown.map((p) => (
          <span
            key={p.id}
            className={cn(
              "flex items-center gap-1 rounded-xs px-1 py-0.5",
              p.status === "failed" ? "bg-danger-soft" : "bg-surface-inset",
            )}
          >
            <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot(p))} />
            <span className="nums shrink-0 text-[13px] font-semibold text-text">
              {fmtTime(p.scheduledAt, p.scheduleTimezone ?? calendarTimezone)}
            </span>
            <span className="truncate text-[13px] text-text-2">{p.text}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

/* ----------------------------------------------------------- СКЕЛЕТОНЫ */

function GridSkeleton() {
  return (
    <div className="grid gap-2 xl:grid-cols-7">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md bg-surface p-2 ring-1 ring-line">
          <div className="skeleton h-7 w-full" />
          <div className="skeleton h-14 w-full" />
          {i % 2 === 0 && <div className="skeleton h-14 w-full" />}
          <div className="min-h-[40px] xl:min-h-[70px]" />
        </div>
      ))}
    </div>
  );
}

function SideSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      {Array.from({ length: 2 }, (_, i) => (
        <Card key={i} className="flex flex-col gap-3 p-4">
          <div className="skeleton h-5 w-40" />
          <div className="skeleton h-20 w-full" />
          <div className="skeleton h-20 w-full" />
        </Card>
      ))}
    </div>
  );
}

function WeekSummary({ posts }: { posts: DatedPost[] }) {
  const scheduled = posts.filter((post) => ["scheduled", "publishing", "failed_retry"].includes(post.status)).length;
  const published = posts.filter((post) => post.status === "published").length;
  const measured = posts.filter((post) => post.metrics && post.metrics.views > 0);
  const views = measured.reduce((total, post) => total + (post.metrics?.views ?? 0), 0);
  const reactions = measured.reduce((total, post) => total + (
    (post.metrics?.reactions ?? 0)
    + (post.metrics?.comments ?? 0)
    + (post.metrics?.shares ?? 0)
  ), 0);
  const engagement = views > 0 ? `${Math.round((reactions / views) * 100)}%` : "—";
  const items = [
    { label: "Постов на неделе", value: String(posts.length), icon: Flame, tone: "text-fire-text" },
    { label: "Запланировано", value: String(scheduled), icon: CalendarPlus, tone: "text-fire-text" },
    { label: "Опубликовано", value: String(published), icon: Send, tone: "text-success-text" },
    { label: "Вовлечённость", value: engagement, icon: BarChart3, tone: "text-brand" },
  ];

  return (
    <Card as="section" className="p-4 sm:p-5" aria-labelledby="calendar-week-summary-title">
      <h2 id="calendar-week-summary-title" className="sr-only">Статистика недели</h2>
      <dl className="grid grid-cols-1 gap-4 min-[360px]:grid-cols-2 lg:grid-cols-4">
        {items.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.label} className="flex min-w-0 items-start gap-3">
              <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-inset", item.tone)}>
                <Icon className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
              </span>
              <div className="flex min-w-0 flex-col">
                <dt className="order-2 mt-1.5 text-[13px] leading-snug text-text-3">{item.label}</dt>
                <dd className="nums order-1 text-xl font-extrabold leading-none text-text tabular-nums">{item.value}</dd>
              </div>
            </div>
          );
        })}
      </dl>
    </Card>
  );
}

function UpcomingPublications({
  posts,
  calendarTimezone,
  onOpen,
  onCreate,
  exportAction,
}: {
  posts: DatedPost[];
  calendarTimezone: string;
  onOpen: (post: DatedPost) => void;
  onCreate?: () => void;
  exportAction: React.ReactNode;
}) {
  return (
    <Card as="section" className="p-4 sm:p-5" aria-labelledby="calendar-upcoming-title">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="calendar-upcoming-title" className="text-[16px] font-extrabold tracking-tight text-text">
          Ближайшие публикации
        </h2>
        {exportAction}
      </div>
      {posts.length === 0 ? (
        <div className="mt-4 rounded-sm bg-surface-inset p-4">
          <p className="text-[14px] font-semibold text-text">Публикаций пока нет</p>
          <p className="mt-1 text-[13px] leading-relaxed text-text-2">
            Добавьте пост, чтобы он появился в недельном плане.
          </p>
          {onCreate && (
            <Button variant="secondary" size="sm" className="mt-3" onClick={onCreate}>
              <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
              Создать пост
            </Button>
          )}
        </div>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {posts.map((post) => (
            <li key={post.id}>
              <button
                type="button"
                onClick={() => onOpen(post)}
                className="grid min-h-11 w-full grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-x-3 gap-y-1 rounded-xs px-1 py-2.5 text-left transition-colors duration-150 hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand motion-reduce:transition-none sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
                aria-label={`Открыть публикацию: ${post.text.slice(0, 60)}`}
              >
                <span className="text-[12px] font-semibold text-text-3">{fmtDate(post.scheduledAt)}</span>
                <span className="nums text-[13px] font-bold text-text tabular-nums">
                  {fmtTime(post.scheduledAt, post.scheduleTimezone ?? calendarTimezone)}
                </span>
                <span className="truncate text-[13px] text-text-2">{post.text}</span>
                <Badge tone={calendarStatusTone(calendarRecordStatus(post))} className="col-start-3 justify-self-start sm:col-auto">
                  {CALENDAR_STATUS_LABEL[calendarRecordStatus(post)] ?? calendarRecordStatus(post)}
                </Badge>
              </button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function CalendarTip() {
  return (
    <Card as="aside" className="bg-info-soft p-4 sm:p-5" aria-labelledby="calendar-tip-title">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface text-fire-text shadow-soft">
          <Lightbulb className="h-[18px] w-[18px]" strokeWidth={2} aria-hidden />
        </span>
        <div className="min-w-0">
          <h2 id="calendar-tip-title" className="text-[14px] font-extrabold text-text">Подсказка</h2>
          <p className="mt-1.5 text-pretty text-[13px] leading-relaxed text-text-2">
            Разносите ключевые публикации по разным дням — так проще видеть нагрузку и сравнивать результаты.
          </p>
          <Link href="/app/analytics" className={buttonClassName({ variant: "ghost", size: "sm", className: "mt-2 -ml-3 text-brand" })}>
            Смотреть аналитику
            <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
          </Link>
        </div>
      </div>
    </Card>
  );
}

/* --------------------------------------------------------------- ЭКРАН */

export default function CalendarPage() {
  const router = useRouter();
  const s = useStore();
  const projects = useProjects();
  const reduce = useReducedMotion();
  const currentProjectId = projects.current?.id;
  const currentRole = projects.current?.role;
  const currentProjectTimezone = projects.current?.timezone;
  const calendarTimezone = currentProjectTimezone
    ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    ?? "UTC";
  const { canEdit, canPublish } = calendarRoleCapabilities(currentRole);
  const canInspectPublication = currentRole != null;

  const [view, setView] = useState<View>("week");
  const [dir, setDir] = useState(0);
  const [anchor, setAnchor] = useState<Date>(() => calendarDayForInstant(
    new Date().toISOString(),
    calendarTimezone,
  ));
  const [serverDrafts, setServerDrafts] = useState<ServerDraft[]>([]);
  const [draftOwner, setDraftOwner] = useState<User | null>(null);
  const [draftsReady, setDraftsReady] = useState(false);
  const [draftsError, setDraftsError] = useState(false);
  const [publicationTarget, setPublicationTarget] = useState<PublicationActionTarget | null>(null);
  const [publicationBusy, setPublicationBusy] = useState(false);
  const [draggedPostId, setDraggedPostId] = useState<string | null>(null);
  const [dragPreview, setDragPreview] = useState<CalendarDragPreview | null>(null);
  const [dragOverDay, setDragOverDay] = useState<string | null>(null);
  const [movingPostId, setMovingPostId] = useState<string | null>(null);
  const [movePickerPostId, setMovePickerPostId] = useState<string | null>(null);
  const [optimisticSchedules, setOptimisticSchedules] = useState<Record<string, string>>({});
  const [moveAnnouncement, setMoveAnnouncement] = useState("");
  const [calendarClock, setCalendarClock] = useState(() => Date.now());
  const [showLocalRecovery, setShowLocalRecovery] = useState(false);
  const [showUnownedRecovery, setShowUnownedRecovery] = useState(false);
  const draftQueueHeadingRef = useRef<HTMLHeadingElement>(null);
  const weekScrollerRef = useRef<HTMLDivElement>(null);
  const dragPointRef = useRef<CalendarDragPoint | null>(null);
  const movingPostRef = useRef<string | null>(null);
  const focusedPostRef = useRef<string | null>(null);
  const anchoredProjectRef = useRef<string | null>(null);

  const hasUser = Boolean(s.user);
  useEffect(() => {
    const timer = window.setInterval(() => setCalendarClock(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);
  const refreshDrafts = useCallback(async (owner: User, signal?: AbortSignal) => {
    try {
      const drafts = await listServerDrafts(signal);
      if (signal?.aborted) return;
      setServerDrafts(drafts);
      setDraftOwner(owner);
      setDraftsError(false);
    } catch (error) {
      if (signal?.aborted) return;
      setDraftOwner(owner);
      setDraftsError(true);
      if (!(error instanceof DraftRequestError && error.kind === "offline")) {
        console.error("[/app/calendar drafts]", error);
      }
    } finally {
      if (!signal?.aborted) setDraftsReady(true);
    }
  }, []);

  useEffect(() => {
    if (!s.authReady || !s.user) return;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- первичная синхронизация с серверным API
    void refreshDrafts(s.user, controller.signal);
    const onFocus = () => void refreshDrafts(s.user as User);
    window.addEventListener("focus", onFocus);
    return () => {
      controller.abort();
      window.removeEventListener("focus", onFocus);
    };
  }, [hasUser, refreshDrafts, s.authReady, s.user]);

  useEffect(() => {
    if (!s.ready || focusedPostRef.current) return;
    const match = window.location.hash.match(/^#calendar-real-(\d+)$/u);
    if (!match) return;
    const post = s.realPosts.find((candidate) => candidate.id === Number(match[1]));
    if (!post?.scheduled_at) return;
    focusedPostRef.current = `calendar-real-${post.id}`;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- focused deep link selects its exact week
    setAnchor(calendarDayForInstant(
      post.scheduled_at,
      post.scheduled_timezone ?? calendarTimezone,
    ));
    setView("week");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = document.getElementById(focusedPostRef.current ?? "");
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }, [calendarTimezone, s.ready, s.realPosts]);

  // Полночь сегодняшнего дня. Считается на клиенте — до s.ready ничего датозависимого не рисуем
  const today = useMemo(
    () => calendarDayForInstant(new Date(calendarClock).toISOString(), calendarTimezone),
    [calendarClock, calendarTimezone],
  );

  useEffect(() => {
    if (!currentProjectId) return;
    const projectKey = `${currentProjectId}:${calendarTimezone}`;
    if (anchoredProjectRef.current === projectKey) return;
    anchoredProjectRef.current = projectKey;
    setAnchor(today);
  }, [calendarTimezone, currentProjectId, today]);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
  const exportPeriod = useMemo(
    () => calendarProjectExportPeriod(view === "month" ? "month" : "week", anchor, weekStart),
    [anchor, view, weekStart],
  );
  const weekDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)),
    [weekStart],
  );

  const monthCells = useMemo(() => {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    const gridStart = startOfWeek(first);
    const span = Math.round((last.getTime() - gridStart.getTime()) / 86_400_000) + 1;
    const weeks = Math.ceil(span / 7);
    return Array.from({ length: weeks * 7 }, (_, i) => addDays(gridStart, i));
  }, [anchor]);

  /* ------------------------------------------------- ФИЛЬТР ПО КАНАЛАМ */
  // Фильтр — по АККАУНТУ, а не по сети: пять Telegram-каналов это одна сеть,
  // и фильтр «по сети» на них бесполезен.
  //
  // hidden, а не visible: по умолчанию видно всё. Пустое множество = ничего не скрыто,
  // поэтому вновь подключённый канал появляется в календаре сам, а не оказывается
  // невидимым из-за того, что его нет в списке «выбранных».
  const tgChannels = useMemo(
    () => s.realChannels.filter((c) => c.is_active),
    [s.realChannels],
  );
  const [hidden, setHidden] = useState<Set<number>>(new Set());
  const [authorFilter, setAuthorFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const multiChannel = tgChannels.length > 1;

  const toggleChannel = useCallback((id: number) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const draftsReadyForUser = draftsReady && draftOwner === s.user;
  const serverDraftPosts = useMemo(
    () => (draftOwner === s.user ? serverDrafts.map(serverDraftToPost) : []),
    [draftOwner, s.user, serverDrafts],
  );

  const allCalendarPosts = useMemo<CalendarPost[]>(
    () => [...s.realPosts.map(realToPost), ...serverDraftPosts],
    [s.realPosts, serverDraftPosts],
  );
  const calendarAuthors = useMemo(() => {
    return calendarAuthorOptions(allCalendarPosts);
  }, [allCalendarPosts]);
  const calendarStatuses = useMemo(() => {
    const statuses = new Set(allCalendarPosts.map(calendarRecordStatus));
    return Object.entries(CALENDAR_STATUS_LABEL)
      .filter(([value]) => statuses.has(value))
      .map(([value, label]) => ({ value, label }));
  }, [allCalendarPosts]);
  useEffect(() => {
    if (authorFilter === "all" || calendarAuthors.some((author) => String(author.id) === authorFilter)) return;
    queueMicrotask(() => setAuthorFilter("all"));
  }, [authorFilter, calendarAuthors]);
  useEffect(() => {
    if (statusFilter === "all" || calendarStatuses.some((status) => status.value === statusFilter)) return;
    queueMicrotask(() => setStatusFilter("all"));
  }, [calendarStatuses, statusFilter]);
  const matchesTeamFilters = useCallback(
    (post: CalendarPost) => calendarRecordMatches(post, {
      author: authorFilter,
      status: statusFilter,
    }),
    [authorFilter, statusFilter],
  );
  const filteredServerDraftPosts = useMemo(
    () => serverDraftPosts.filter(matchesTeamFilters),
    [matchesTeamFilters, serverDraftPosts],
  );

  // В авторизованном календаре основной источник только серверный. Демо/localStorage
  // не смешиваются с публикациями и черновиками аккаунта.
  const gridPosts = useMemo(() => {
    const teamFiltered = allCalendarPosts.filter(matchesTeamFilters);
    if (!hidden.size) return teamFiltered;
    return teamFiltered.filter((p) =>
      p.destinationIds?.length
        ? p.destinationIds.some((id) => !hidden.has(id))
        : p.channelId == null || !hidden.has(p.channelId),
    );
  }, [allCalendarPosts, hidden, matchesTeamFilters]);

  const displayedGridPosts = useMemo(() => gridPosts.map((post) => {
    const optimisticScheduledAt = optimisticSchedules[post.id];
    return optimisticScheduledAt && post.scheduledAt
      ? { ...post, scheduledAt: optimisticScheduledAt }
      : post;
  }), [gridPosts, optimisticSchedules]);

  const canManageCalendarMove = useCallback((post: CalendarPost) => {
    if (post.serverDraftId != null) {
      const draft = serverDrafts.find((candidate) => candidate.id === post.serverDraftId);
      return canEdit && post.draftVersion != null && draft?.purpose !== "source_context";
    }
    return canPublish
      && post.status === "scheduled"
      && post.publicationOperationId != null
      && post.operationScheduleRevision != null
      && Boolean(post.operationStatus)
      && Boolean(post.scheduleTimezone);
  }, [canEdit, canPublish, serverDrafts]);

  const canStartCalendarMove = useCallback(
    (post: CalendarPost) => (
      movingPostId == null
      && !publicationBusy
      && canManageCalendarMove(post)
    ),
    [canManageCalendarMove, movingPostId, publicationBusy],
  );

  const calendarMoveBlockedReason = useCallback((post: CalendarPost) => {
    if (movingPostId != null || publicationBusy) {
      return "Дождитесь завершения текущего действия.";
    }
    if (post.serverDraftId != null) {
      const draft = serverDrafts.find((candidate) => candidate.id === post.serverDraftId);
      if (!canEdit) return "Для переноса черновика нужно право редактирования.";
      if (draft?.purpose === "source_context") {
        return "Материал-источник нельзя переносить как публикацию.";
      }
      if (post.draftVersion == null) return "Обновите календарь, чтобы перенести этот черновик.";
      return undefined;
    }
    if (!canPublish) return "Для переноса нужно право публикации.";
    if (post.status === "published") return "Опубликованный пост является историей и не переносится.";
    if (post.status === "publishing") return "Публикация уже отправляется и временно не переносится.";
    if (post.status !== "scheduled") return "Публикацию с этим статусом нельзя переносить между днями.";
    if (
      post.publicationOperationId == null
      || post.operationScheduleRevision == null
      || !post.operationStatus
      || !post.scheduleTimezone
    ) {
      return "Обновите календарь, чтобы получить актуальные данные публикации.";
    }
    return undefined;
  }, [canEdit, canPublish, movingPostId, publicationBusy, serverDrafts]);

  const draggedPost = useMemo(() => {
    if (!draggedPostId) return null;
    const post = displayedGridPosts.find((candidate) => candidate.id === draggedPostId);
    return post && isOnGrid(post) ? post : null;
  }, [displayedGridPosts, draggedPostId]);

  const movePickerPost = useMemo(() => {
    if (!movePickerPostId) return null;
    const post = displayedGridPosts.find((candidate) => candidate.id === movePickerPostId);
    return post && isOnGrid(post) && canStartCalendarMove(post) ? post : null;
  }, [canStartCalendarMove, displayedGridPosts, movePickerPostId]);

  const hasMovablePosts = useMemo(
    () => displayedGridPosts.some((post) => isOnGrid(post) && canManageCalendarMove(post)),
    [canManageCalendarMove, displayedGridPosts],
  );

  // Посты по дням — один проход вместо фильтра на каждую ячейку
  const postsByDay = useMemo(() => {
    const map = new Map<string, DatedPost[]>();
    for (const p of displayedGridPosts) {
      if (!isOnGrid(p)) continue;
      const key = calendarDateKeyForInstant(
        p.scheduledAt,
        p.scheduleTimezone ?? calendarTimezone,
      );
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    }
    return map;
  }, [calendarTimezone, displayedGridPosts]);

  const dayPosts = (d: Date) => postsByDay.get(dayKey(d)) ?? [];

  // Основная очередь теперь только серверная. Старый глобальный localStorage ниже показан
  // отдельно как recovery-копии: он не привязан к пользователю и потому не импортируется сам.
  const queue = useMemo(
    () => filteredServerDraftPosts.filter((post) => !post.scheduledAt),
    [filteredServerDraftPosts],
  );
  const localRecovery = useMemo(
    () => (s.user ? s.posts.filter((post) => isRecoverableLegacyDraft(post, s.user!.id)) : []),
    [s.posts, s.user],
  );
  const unownedLocalRecovery = useMemo(
    () => (s.user ? s.posts.filter(isUnownedLegacyDraftCandidate) : []),
    [s.posts, s.user],
  );

  const weekPosts = useMemo(
    () => weekDays.flatMap((day) => postsByDay.get(dayKey(day)) ?? []),
    [postsByDay, weekDays],
  );
  const upcomingPosts = useMemo(
    () => displayedGridPosts
      .filter((post): post is DatedPost => (
        isOnGrid(post)
        && new Date(post.scheduledAt).getTime() >= today.getTime()
        && !["published", "missing", "deleted_external", "cancelled", "failed"].includes(post.status)
      ))
      .sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime())
      .slice(0, 3),
    [displayedGridPosts, today],
  );

  const isCurrentPeriod =
    view === "month"
      ? anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth()
      : sameDay(weekStart, startOfWeek(today));

  const shift = (delta: number) => {
    setDir(delta);
    setAnchor((prev) =>
      view === "month"
        ? new Date(prev.getFullYear(), prev.getMonth() + delta, 1)
        : addDays(startOfWeek(prev), delta * 7),
    );
  };

  const goToday = () => {
    setDir(0);
    setAnchor(today);
  };

  const openPost = (post: CalendarPost) => {
    if (post.serverDraftId != null) {
      router.push(`/app/composer?draft=${post.serverDraftId}&from=calendar`);
      return;
    }
    if ((post.status === "draft" || post.status === "queued") && !post.id.startsWith("real-")) {
      router.push(`/app/composer?legacy=${encodeURIComponent(post.id)}&from=calendar`);
      return;
    }
    if (
      canInspectPublication
      && post.publicationOperationId != null
      && post.operationScheduleRevision != null
      && post.operationStatus
      && post.scheduledAt
      && post.scheduleTimezone
    ) {
      setPublicationTarget({
        operationId: post.publicationOperationId,
        operationStatus: post.operationStatus,
        postStatus: post.status,
        scheduleRevision: post.operationScheduleRevision,
        scheduledAt: post.scheduledAt,
        timezone: post.scheduleTimezone,
        scheduledOffset: post.scheduledOffset ?? null,
        scheduleDisambiguation: post.scheduleDisambiguation ?? "reject",
        text: post.text,
      });
      return;
    }
    const title =
      post.status === "published"
        ? "Пост вышел"
        : post.status === "published_unverified"
          ? "Доставка ещё не подтверждена"
          : post.status === "missing" || post.status === "deleted_external"
            ? "Пост не найден во внешнем канале"
        : post.status === "quarantined"
          ? "Дата истекла — публикация остановлена"
          : post.status === "failed_retry"
            ? "Сервер ждёт безопасного времени повтора"
        : post.status === "failed"
          ? "Пост не вышел"
          : post.status === "publishing"
            ? "Публикуется прямо сейчас"
            : "Пост запланирован";
    s.toast({
      kind: post.status === "failed" ? "danger" : "info",
      title,
      body:
        post.status === "failed"
          ? (post.failReason ?? (
              canPublish
                ? "Можно отправить снова кнопкой на карточке."
                : "Статус сохранён в календаре. Повторную отправку выполняет участник с правом публикации."
            ))
          : post.status === "published_unverified"
            ? "Сеть могла принять публикацию, но не вернула подтверждение. Автоматический повтор остановлен, чтобы не создать дубль; Аврора сверяет внешний канал."
          : post.scheduledAt
            ? `${fmtDateTime(post.scheduledAt, post.scheduleTimezone ?? calendarTimezone)}. Публикует сервер.`
            : "",
    });
  };
  const addPostOn = (day: Date) => router.push(composerForDay(day));
  const retryCalendarPost = (post: DatedPost) => {
    if (post.id.startsWith("real-")) {
      s.retryRealPost(realId(post.id));
      return;
    }
    s.retryPost(post.id);
  };

  const publicationFailure = useCallback((error?: string) => {
    const conflict = error === "schedule_revision_conflict" || error === "publication_status_conflict";
    const inProgress = error === "publication_in_progress";
    s.toast({
      kind: "danger",
      title: inProgress
        ? "Публикация уже отправляется"
        : conflict
          ? "Состояние публикации изменилось"
          : "Действие не выполнено",
      body: inProgress
        ? "Отправка уже началась. Дождись результата; если статус останется неподтверждённым, проверь публикацию в канале."
        : conflict
          ? "Состояние изменилось в другой вкладке или во время обработки. Календарь обновлён — повтори действие с актуальными данными."
          : "Сервер не подтвердил изменение. Запланированная публикация оставлена в прежнем состоянии.",
    });
  }, [s]);

  const moveCalendarPost = useCallback(async (post: DatedPost, targetDay: Date) => {
    if (
      movingPostRef.current != null
      || !canManageCalendarMove(post)
      || calendarDateKeyForInstant(
        post.scheduledAt,
        post.scheduleTimezone ?? calendarTimezone,
      ) === dayKey(targetDay)
    ) return;

    movingPostRef.current = post.id;
    setMovingPostId(post.id);
    try {
      const draft = post.serverDraftId == null
        ? null
        : serverDrafts.find((candidate) => candidate.id === post.serverDraftId) ?? null;
      const timezone = draft?.scheduled_timezone
        ?? post.scheduleTimezone
        ?? currentProjectTimezone
        ?? Intl.DateTimeFormat().resolvedOptions().timeZone
        ?? "UTC";
      const moved = resolveCalendarDayMove({
        scheduledAt: post.scheduledAt,
        targetDay,
        timezone,
        disambiguation: draft?.scheduled_disambiguation ?? post.scheduleDisambiguation,
        offset: draft?.scheduled_offset ?? post.scheduledOffset,
      });
      if (new Date(moved.scheduledAt).getTime() <= Date.now() + 30_000) {
        throw new ScheduleValidationError("past_time");
      }

      const persisted = await withOptimisticCalendarSchedule({
        apply: () => setOptimisticSchedules((current) => ({
          ...current,
          [post.id]: moved.scheduledAt,
        })),
        persist: async () => {
          if (draft && post.serverDraftId != null) {
            const updated = await rescheduleServerDraft(post.serverDraftId, {
              version: draft.version,
              scheduledAt: moved.scheduledAt,
              schedule: {
                localDate: moved.localDate,
                localTime: moved.localTime,
                timezone: moved.timezone,
                disambiguation: moved.disambiguation,
                offset: moved.offset,
              },
            });
            setServerDrafts((current) => current.map((candidate) => (
              candidate.id === updated.id ? updated : candidate
            )));
            return true;
          }
          if (
            post.publicationOperationId != null
            && post.operationScheduleRevision != null
            && post.operationStatus
          ) {
            const result = await reschedulePublication({
              operationId: post.publicationOperationId,
              expectedScheduleRevision: post.operationScheduleRevision,
              expectedStatus: post.operationStatus,
              idempotencyKey: crypto.randomUUID(),
              scheduledAt: moved.scheduledAt,
              localDate: moved.localDate,
              localTime: moved.localTime,
              timezone: moved.timezone,
              disambiguation: moved.disambiguation,
              offset: moved.offset,
            });
            if (!result.ok) {
              publicationFailure(result.error);
              await s.refreshReal();
              return false;
            }
            await s.refreshReal();
            return true;
          }
          throw new Error("calendar_move_not_supported");
        },
        clear: () => setOptimisticSchedules((current) => {
          if (!(post.id in current)) return current;
          const next = { ...current };
          delete next[post.id];
          return next;
        }),
      });
      if (!persisted) return;

      const successBody = `${fmtDateTime(moved.scheduledAt, moved.timezone)}. Время публикации сохранено.`;
      setMoveAnnouncement(
        `Публикация перенесена на ${moved.localDate}, ${moved.localTime}.`,
      );
      s.toast({ kind: "success", title: "Публикация перенесена", body: successBody });
    } catch (error) {
      const scheduleError = error instanceof ScheduleValidationError ? error.code : null;
      const conflict = error instanceof DraftRequestError && error.kind === "conflict";
      const offline = error instanceof DraftRequestError && error.kind === "offline";
      const title = scheduleError === "past_time"
        ? "Нужна будущая дата"
        : scheduleError === "nonexistent_local_time" || scheduleError === "ambiguous_local_time"
          ? "Нужно уточнить время"
          : conflict
            ? "Черновик уже изменён"
            : "Публикация не перенесена";
      const body = scheduleError === "past_time"
        ? "На выбранном дне это время уже прошло. Перетащите карточку на будущий день."
        : scheduleError === "nonexistent_local_time" || scheduleError === "ambiguous_local_time"
          ? "Из-за перехода часового пояса это время отсутствует или повторяется. Откройте публикацию и выберите время вручную."
          : conflict
            ? "Дата изменилась в другой вкладке. Календарь обновлён — повторите перенос с актуальной карточкой."
            : offline
              ? "Нет соединения с сервером. Старая дата сохранена; повторите перенос после восстановления сети."
              : "Сервер не подтвердил новую дату. Публикация осталась на прежнем месте.";
      setMoveAnnouncement(`${title}. ${body}`);
      s.toast({ kind: "danger", title, body });
      if (post.serverDraftId != null && s.user) await refreshDrafts(s.user);
    } finally {
      movingPostRef.current = null;
      setMovingPostId(null);
      setDraggedPostId(null);
      setDragOverDay(null);
    }
  }, [
    canManageCalendarMove,
    calendarTimezone,
    currentProjectTimezone,
    publicationFailure,
    refreshDrafts,
    s,
    serverDrafts,
  ]);

  const canDropPostOn = useCallback((post: DatedPost, day: Date) => {
    const timezone = post.scheduleTimezone ?? currentProjectTimezone ?? calendarTimezone;
    if (
      day.getTime() < today.getTime()
      || calendarDateKeyForInstant(post.scheduledAt, timezone) === dayKey(day)
    ) return false;
    try {
      const moved = resolveCalendarDayMove({
        scheduledAt: post.scheduledAt,
        targetDay: day,
        timezone,
        disambiguation: post.scheduleDisambiguation,
        offset: post.scheduledOffset,
      });
      return new Date(moved.scheduledAt).getTime() > Date.now() + 30_000;
    } catch {
      return false;
    }
  }, [calendarTimezone, currentProjectTimezone, today]);

  const canDropDraggedPostOn = useCallback((day: Date) => Boolean(
    draggedPost
    && canDropPostOn(draggedPost, day)
  ), [canDropPostOn, draggedPost]);

  const pointerDayAt = useCallback((point: CalendarDragPoint) => {
    const target = document.elementFromPoint(point.clientX, point.clientY);
    const key = target?.closest<HTMLElement>("[data-calendar-day]")?.dataset.calendarDay;
    return key ? weekDays.find((day) => dayKey(day) === key) ?? null : null;
  }, [weekDays]);

  const updatePointerDropTarget = useCallback((post: DatedPost, point: CalendarDragPoint) => {
    const day = pointerDayAt(point);
    setDragOverDay(day && canDropPostOn(post, day) ? dayKey(day) : null);
  }, [canDropPostOn, pointerDayAt]);

  const startPostPointerDrag = useCallback((post: DatedPost, origin: CalendarDragOrigin) => {
    if (!canStartCalendarMove(post)) return false;
    const offsetX = Math.max(0, Math.min(origin.point.clientX - origin.rect.left, origin.rect.width));
    const offsetY = Math.max(0, Math.min(origin.point.clientY - origin.rect.top, origin.rect.height));
    dragPointRef.current = origin.point;
    setDraggedPostId(post.id);
    setDragPreview({
      postId: post.id,
      point: origin.point,
      offsetX,
      offsetY,
      width: Math.max(112, origin.rect.width),
    });
    setDragOverDay(null);
    setMoveAnnouncement(
      "Перенос публикации начат. Ведите карточку к другому дню и отпустите.",
    );
    return true;
  }, [canStartCalendarMove]);

  const movePostPointerDrag = useCallback((post: DatedPost, point: CalendarDragPoint) => {
    dragPointRef.current = point;
    setDragPreview((current) => current?.postId === post.id
      ? { ...current, point }
      : current);
    updatePointerDropTarget(post, point);
  }, [updatePointerDropTarget]);

  const cancelPostPointerDrag = useCallback(() => {
    dragPointRef.current = null;
    setDraggedPostId(null);
    setDragPreview(null);
    setDragOverDay(null);
    setMoveAnnouncement("Перенос публикации отменён.");
  }, []);

  const endPostPointerDrag = useCallback((post: DatedPost, point: CalendarDragPoint) => {
    const day = pointerDayAt(point);
    dragPointRef.current = null;
    setDraggedPostId(null);
    setDragPreview(null);
    setDragOverDay(null);
    if (!day || !canDropPostOn(post, day)) {
      setMoveAnnouncement("Перенос публикации отменён. Выберите другой будущий день.");
      return;
    }
    void moveCalendarPost(post, day);
  }, [canDropPostOn, moveCalendarPost, pointerDayAt]);

  useEffect(() => {
    if (!draggedPost) return;
    let frame = 0;
    const scrollAtEdges = () => {
      const point = dragPointRef.current;
      let scrolled = false;
      if (point) {
        const verticalDelta = calendarDragAutoScrollDelta(
          point.clientY,
          window.innerHeight,
          72,
          20,
        );
        if (verticalDelta !== 0) {
          window.scrollBy({ top: verticalDelta, behavior: "auto" });
          scrolled = true;
        }

        const scroller = weekScrollerRef.current;
        if (scroller) {
          const rect = scroller.getBoundingClientRect();
          const closeToScroller = point.clientY >= rect.top - 72 && point.clientY <= rect.bottom + 72;
          const horizontalDelta = closeToScroller
            ? calendarDragAutoScrollDelta(point.clientX - rect.left, rect.width, 72, 18)
            : 0;
          if (horizontalDelta !== 0 && scroller.scrollWidth > scroller.clientWidth) {
            scroller.scrollBy({ left: horizontalDelta, behavior: "auto" });
            scrolled = true;
          }
        }

        if (scrolled) updatePointerDropTarget(draggedPost, point);
      }
      frame = window.requestAnimationFrame(scrollAtEdges);
    };
    frame = window.requestAnimationFrame(scrollAtEdges);
    return () => window.cancelAnimationFrame(frame);
  }, [draggedPost, updatePointerDropTarget]);

  useEffect(() => {
    if (!draggedPostId) return;
    const cancelWithEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      cancelPostPointerDrag();
    };
    window.addEventListener("keydown", cancelWithEscape);
    return () => window.removeEventListener("keydown", cancelWithEscape);
  }, [cancelPostPointerDrag, draggedPostId]);

  const cancelTargetPublication = useCallback(async () => {
    const target = publicationTarget;
    if (!target || publicationBusy) return;
    setPublicationBusy(true);
    try {
      const result = await cancelPublication({
        operationId: target.operationId,
        expectedScheduleRevision: target.scheduleRevision,
        expectedStatus: target.operationStatus,
        idempotencyKey: crypto.randomUUID(),
      });
      if (!result.ok) {
        publicationFailure(result.error);
        await s.refreshReal();
        return;
      }
      await s.refreshReal();
      setPublicationTarget(null);
      s.toast({
        kind: "success",
        title: "Публикация отменена",
        body: "Отмена подтверждена сервером. Даже если старая задача осталась в очереди, она ничего не отправит.",
      });
    } finally {
      setPublicationBusy(false);
    }
  }, [publicationBusy, publicationFailure, publicationTarget, s]);

  const rescheduleTargetPublication = useCallback(async (schedule: PublicationRescheduleInput) => {
    const target = publicationTarget;
    if (!target || publicationBusy) return;
    setPublicationBusy(true);
    try {
      const result = await reschedulePublication({
        operationId: target.operationId,
        expectedScheduleRevision: target.scheduleRevision,
        expectedStatus: target.operationStatus,
        idempotencyKey: crypto.randomUUID(),
        scheduledAt: schedule.scheduledAt,
        localDate: schedule.localDate,
        localTime: schedule.localTime,
        timezone: schedule.timezone,
        disambiguation: schedule.disambiguation,
        offset: schedule.offset,
      });
      if (!result.ok && result.status !== "scheduled") {
        publicationFailure(result.error);
        await s.refreshReal();
        return;
      }
      await s.refreshReal();
      setPublicationTarget(null);
      s.toast({
        kind: result.ok ? "success" : "info",
        title: result.ok ? "Публикация перенесена" : "Дата сохранена, очередь восстанавливается",
        body: result.scheduledAt
          ? `${fmtDateTime(result.scheduledAt, schedule.timezone)}. Предыдущая дата больше не действует.`
          : "Новая дата сохранена; сервис планирования восстановит очередь.",
      });
    } finally {
      setPublicationBusy(false);
    }
  }, [publicationBusy, publicationFailure, publicationTarget, s]);

  const editTargetPublication = useCallback(async () => {
    const target = publicationTarget;
    if (!target || publicationBusy) return;
    setPublicationBusy(true);
    try {
      let revision = target.scheduleRevision;
      let status = target.operationStatus;
      const publicationSettled = ["published", "published_unverified", "missing", "deleted_external"]
        .includes(target.postStatus);
      if (!publicationSettled && status !== "cancelled") {
        const cancelled = await cancelPublication({
          operationId: target.operationId,
          expectedScheduleRevision: revision,
          expectedStatus: status,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!cancelled.ok || cancelled.scheduleRevision == null) {
          publicationFailure(cancelled.error);
          await s.refreshReal();
          return;
        }
        revision = cancelled.scheduleRevision;
        status = "cancelled";
      }
      const restored = await restorePublicationToDraft({
        operationId: target.operationId,
        expectedScheduleRevision: revision,
        expectedStatus: status,
        idempotencyKey: crypto.randomUUID(),
      });
      await s.refreshReal();
      if (!restored.ok || restored.draftId == null) {
        s.toast({
          kind: "danger",
          title: publicationSettled ? "Новая версия не создана" : "Публикация остановлена, черновик не создан",
          body: publicationSettled
            ? "Опубликованный пост не изменён. Повторите действие, чтобы создать новый черновик."
            : "Старая отправка безопасно отменена. Повторите «Редактировать», чтобы восстановить сохранённый текст в новый черновик.",
        });
        return;
      }
      setPublicationTarget(null);
      router.push(`/app/composer?draft=${restored.draftId}&from=calendar`);
    } finally {
      setPublicationBusy(false);
    }
  }, [publicationBusy, publicationFailure, publicationTarget, router, s]);

  const removeLocalRecovery = (post: Post) => {
    s.removePost(post.id);
    s.toast({ kind: "info", title: "Локальная копия удалена из этого браузера" });
  };

  const claimLocalRecovery = (post: Post) => {
    if (!s.user) return;
    const claimed = claimUnownedLegacyDraft(post, s.user.id);
    if (!claimed) {
      s.toast({
        kind: "danger",
        title: "Копию не открыли",
        body: "Она уже привязана к другому аккаунту или больше недоступна.",
      });
      return;
    }
    // Это только локальная привязка после явного клика. На сервер черновик попадёт
    // позднее и тоже только по отдельной кнопке «Сохранить» в Composer.
    s.updatePost(post.id, { legacyOwnerUserId: claimed.legacyOwnerUserId });
    setShowLocalRecovery(true);
    s.toast({
      kind: "info",
      title: "Локальная копия привязана",
      body: "Теперь она показана среди копий этого аккаунта. Открой её отдельной кнопкой после проверки.",
    });
  };

  const makeDraft = (trend: Trend) => {
    s.trendToDraft(trend);
    s.toast({
      kind: "success",
      title: "Черновик готов",
      body: "Лежит в очереди — поставь дату, когда захочешь.",
    });
  };

  const periodKey =
    view === "month"
      ? `m${anchor.getFullYear()}-${anchor.getMonth()}`
      : `${view}-${weekStart.getTime()}`;

  // `s.trends` — демонстрационный seed. В авторизованный календарь его не подмешиваем.
  const suggestions = s.user ? [] : s.trends.slice(0, 3);
  const calendarPartiallyStale = s.realError || draftsError;

  return (
    <AppShell
      title="Календарь"
      subtitle={canEdit
        ? "Планируйте, публикуйте и отслеживайте контент."
        : "Следите за статусами и открывайте публикации для проверки."}
      action={
        canEdit ? (
          <Button variant="primary" size="md" onClick={() => router.push("/app/composer?from=calendar")}>
            <Plus className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
            Новый пост
          </Button>
        ) : (
          <ProjectExportButton
            channels={s.realChannels}
            defaultKind="content_plan"
            initialPeriod={exportPeriod}
          />
        )
      }
    >
      <div className="flex flex-col gap-8">
        {/* ------------------------------------------------------- СЕТКА */}
        <div className="min-w-0">
          {s.ready && calendarPartiallyStale && (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-sm bg-fire-soft p-3 text-fire-text" role="status">
              <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
              <p className="min-w-0 flex-1 text-pretty text-[13px] leading-relaxed font-medium">
                Не все данные календаря обновились. Уже загруженные карточки сохранены; повторите синхронизацию, когда соединение восстановится.
              </p>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  void s.refreshReal();
                  if (s.user) void refreshDrafts(s.user);
                }}
              >
                <RotateCw className="h-3.5 w-3.5" aria-hidden />
                Обновить календарь
              </Button>
            </div>
          )}
          {!s.ready ? (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between gap-3">
                <div className="skeleton h-9 w-56" />
                <div className="skeleton h-10 w-44" />
              </div>
              <GridSkeleton />
            </div>
          ) : (
            <>
              <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label={view === "month" ? "Предыдущий месяц" : "Предыдущая неделя"}
                    onClick={() => shift(-1)}
                  >
                    <ChevronLeft className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </Button>

                  <div className="min-w-[120px] text-center sm:min-w-[150px] sm:text-left">
                    <p className="text-[17px] font-extrabold -tracking-[0.02em] text-text">
                      {view === "month" ? monthTitle(anchor) : weekRangeLabel(weekStart)}
                    </p>
                    <p className="type-caption mt-0.5 text-text-3">
                      {view === "month" ? "Месячный план" : `Неделя ${isoWeekNumber(weekStart)}`}
                    </p>
                    <span className="sr-only">Время проекта: <bdi>{calendarTimezone}</bdi></span>
                  </div>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-11 w-11"
                    aria-label={view === "month" ? "Следующий месяц" : "Следующая неделя"}
                    onClick={() => shift(1)}
                  >
                    <ChevronRight className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </Button>

                  {!isCurrentPeriod && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={goToday}
                      aria-label="Сегодня"
                      className="ml-1 max-[359px]:h-11 max-[359px]:w-11 max-[359px]:px-0"
                    >
                      <CalendarDays className="hidden h-4 w-4 max-[359px]:block" strokeWidth={2} aria-hidden />
                      <span className="max-[359px]:sr-only">Сегодня</span>
                    </Button>
                  )}
                </div>

                <div className="flex w-full min-w-0 items-center gap-3 self-start md:w-auto md:self-auto">
                  <Tabs<View>
                    value={view}
                    onChange={(nextView) => {
                      if (draggedPostId) cancelPostPointerDrag();
                      setView(nextView);
                    }}
                    idPrefix="calendar-view-tab"
                    controls="calendar-view-panel"
                    className="w-full max-[359px]:gap-0 max-[359px]:[&_[role=tab]]:flex-1 max-[359px]:[&_[role=tab]]:justify-center max-[359px]:[&_[role=tab]]:px-1.5 md:w-auto"
                    items={[
                      {
                        value: "week",
                        label: "Неделя",
                        icon: <CalendarDays className="h-4 w-4" strokeWidth={2} aria-hidden />,
                      },
                      {
                        value: "month",
                        label: "Месяц",
                        icon: <LayoutGrid className="h-4 w-4" strokeWidth={2} aria-hidden />,
                      },
                      {
                        value: "list",
                        label: "Список",
                        icon: <List className="h-4 w-4" strokeWidth={2} aria-hidden />,
                      },
                    ]}
                  />
                </div>
              </div>

              <fieldset className="mb-4 flex min-w-0 flex-col gap-3 border-0 p-0 sm:flex-row sm:flex-wrap sm:items-center">
                <legend className="sr-only">Фильтры общего календаря</legend>
                <label className="min-w-0 flex-1 sm:max-w-[17rem]">
                  <span className="sr-only">Автор</span>
                  <select
                    value={authorFilter}
                    onChange={(event) => setAuthorFilter(event.currentTarget.value)}
                    className="h-11 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-text outline-none transition-colors duration-150 hover:border-brand/40 focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none sm:text-[14px]"
                  >
                    <option value="all">Все авторы</option>
                    {calendarAuthors.map((author) => (
                      <option key={author.id} value={author.id}>{author.name}</option>
                    ))}
                  </select>
                </label>
                <label className="min-w-0 flex-1 sm:max-w-[17rem]">
                  <span className="sr-only">Статус</span>
                  <select
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.currentTarget.value)}
                    className="h-11 w-full rounded-sm border border-line-strong bg-surface px-3 text-base text-text outline-none transition-colors duration-150 hover:border-brand/40 focus-visible:border-brand focus-visible:ring-4 focus-visible:ring-brand/15 motion-reduce:transition-none sm:text-[14px]"
                  >
                    <option value="all">Все статусы</option>
                    {calendarStatuses.map((status) => (
                      <option key={status.value} value={status.value}>{status.label}</option>
                    ))}
                  </select>
                </label>
                {(authorFilter !== "all" || statusFilter !== "all") && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="min-h-11 self-start sm:self-auto"
                    onClick={() => {
                      setAuthorFilter("all");
                      setStatusFilter("all");
                    }}
                  >
                    Сбросить фильтры
                  </Button>
                )}
                <p className="sr-only" role="status" aria-live="polite">
                  В календаре показано материалов: {gridPosts.length}.
                </p>
              </fieldset>

              {/* ------------------------------------------- ФИЛЬТР ПО КАНАЛАМ */}
              {/* Sprout Social в своей же справке признаёт: состояние фильтров — причина №1,
                  по которой запланированный пост «пропадает» из календаря («Missing posts are
                  often hidden by filters»). Поэтому здесь фильтр всегда на виду, скрытые
                  каналы названы вслух, а сброс — в один клик. Прятать это в выпадашку нельзя. */}
              {multiChannel && (
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  {tgChannels.map((ch) => {
                    const off = hidden.has(ch.id);
                    const name = ch.title ?? ch.handle ?? `Канал ${ch.id}`;
                    return (
                      <button
                        key={ch.id}
                        type="button"
                        onClick={() => toggleChannel(ch.id)}
                        aria-pressed={!off}
                        className={cn(
                          "inline-flex min-h-11 max-w-[16rem] cursor-pointer items-center gap-2 rounded-full border px-3",
                          "text-[13px] font-semibold transition-colors duration-200",
                          off
                            ? "border-line bg-transparent text-text-3"
                            : "border-line-strong bg-surface text-text",
                        )}
                      >
                        <span className={cn("transition-opacity", off && "opacity-40")}>
                          <ChannelAvatar title={name} id={ch.id} />
                        </span>
                        <span className="truncate">{name}</span>
                        {off && <EyeOff className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />}
                      </button>
                    );
                  })}

                  {/* Скрытое названо вслух — иначе человек решит, что пост потерялся */}
                  {hidden.size > 0 && (
                    <div
                      role="status"
                      className="inline-flex min-h-11 items-center gap-2 rounded-full bg-fire-soft px-3 py-1.5 text-[13px] font-semibold text-fire-text"
                    >
                      <EyeOff className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
                      {hidden.size}{" "}
                      {plural(hidden.size, "канал скрыт", "канала скрыто", "каналов скрыто")}
                      <button
                        type="button"
                        onClick={() => setHidden(new Set())}
                        className="min-h-11 cursor-pointer rounded-xs px-1 underline underline-offset-2 hover:no-underline"
                      >
                        Показать все
                      </button>
                    </div>
                  )}
                </div>
              )}

              {view === "week" && hasMovablePosts && (
                <>
                  <p id={CALENDAR_DRAG_HELP_ID} className="sr-only">
                    Карточку можно перенести на другой день. С клавиатуры нажмите кнопку переноса и выберите день в диалоге.
                  </p>
                  <div
                    aria-hidden
                    className="mb-3 flex min-h-11 items-center gap-2 rounded-sm bg-brand/10 px-3 py-2 text-sm text-text-2"
                  >
                    <GripVertical className="h-4 w-4 shrink-0 text-brand" strokeWidth={2} />
                    <p>
                      <span className="font-semibold text-text">Переносите публикации между днями.</span>{" "}
                      Мышью тяните за ручку, на телефоне удерживайте карточку. Время сохранится.
                    </p>
                  </div>
                </>
              )}
              <p className="sr-only" role="status" aria-live="polite">
                {moveAnnouncement}
              </p>

              <motion.div
                id="calendar-view-panel"
                role="tabpanel"
                aria-labelledby={`calendar-view-tab-${view}`}
                key={periodKey}
                initial={reduce ? false : { opacity: 0, x: dir * 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: EASE_SOFT }}
              >
                {view === "week" ? (
                  <div
                    ref={weekScrollerRef}
                    data-calendar-week-scroller
                    className="-mx-4 overflow-x-auto overscroll-x-contain px-4 pb-2 sm:mx-0 sm:px-0"
                  >
                    <LayoutGroup id={`calendar-week-${periodKey}`}>
                      <div className="grid min-w-[64rem] grid-cols-7 gap-2 xl:min-w-0">
                        {weekDays.map((day, i) => {
                          const key = dayKey(day);
                          const dropAllowed = canDropDraggedPostOn(day);
                          return (
                            <DayColumn
                              key={day.toISOString()}
                              day={day}
                              index={i}
                              posts={dayPosts(day)}
                              isToday={sameDay(day, today)}
                              isPast={day.getTime() < today.getTime()}
                              onAdd={canEdit ? () => addPostOn(day) : undefined}
                              onOpen={openPost}
                              onRetry={canPublish ? retryCalendarPost : undefined}
                              onReschedule={canPublish ? retryCalendarPost : undefined}
                              onRequestMove={(post) => setMovePickerPostId(post.id)}
                              canMovePost={canStartCalendarMove}
                              moveBlockedReason={calendarMoveBlockedReason}
                              movingPostId={movingPostId}
                              draggedPostId={draggedPostId}
                              dragging={draggedPost != null}
                              dropActive={dragOverDay === key}
                              dropAllowed={dropAllowed}
                              onPostPointerDragStart={startPostPointerDrag}
                              onPostPointerDragMove={movePostPointerDrag}
                              onPostPointerDragEnd={endPostPointerDrag}
                              onPostPointerDragCancel={cancelPostPointerDrag}
                              calendarTimezone={calendarTimezone}
                            />
                          );
                        })}
                      </div>
                    </LayoutGroup>
                  </div>
                ) : view === "month" ? (
                  <div>
                    <div className="mb-1.5 grid grid-cols-7 gap-1.5">
                      {Array.from({ length: 7 }, (_, i) => (
                        <span
                          key={i}
                          className="text-center text-[13px] font-semibold text-text-3"
                        >
                          {weekdayShort(i)}
                        </span>
                      ))}
                    </div>
                    <div className="grid grid-cols-7 gap-1.5">
                      {monthCells.map((day) => (
                        <MonthCell
                          key={day.toISOString()}
                          day={day}
                          posts={dayPosts(day)}
                          inMonth={day.getMonth() === anchor.getMonth()}
                          isToday={sameDay(day, today)}
                          calendarTimezone={calendarTimezone}
                          onPick={() => {
                            setDir(0);
                            setAnchor(day);
                            setView("week");
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {weekDays.map((day, index) => {
                      const posts = dayPosts(day);
                      return (
                        <Card as="section" key={day.toISOString()} className="overflow-hidden" aria-labelledby={`calendar-list-day-${dayKey(day)}`}>
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
                            <div className="flex items-center gap-2">
                              <h2 id={`calendar-list-day-${dayKey(day)}`} className="text-[14px] font-extrabold text-text">
                                {weekdayFull(index)}, {fmtDate(day.toISOString())}
                              </h2>
                              <span className="nums text-[12px] text-text-3 tabular-nums">
                                {posts.length} {plural(posts.length, "пост", "поста", "постов")}
                              </span>
                            </div>
                            {canEdit && (
                              <Button variant="ghost" size="sm" onClick={() => addPostOn(day)}>
                                <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                                Новый пост
                              </Button>
                            )}
                          </div>
                          {posts.length === 0 ? (
                            <p className="px-4 py-5 text-[13px] text-text-3">На этот день публикаций нет.</p>
                          ) : (
                            <ul className="divide-y divide-line">
                              {posts.map((post) => (
                                <li key={post.id}>
                                  <button
                                    type="button"
                                    onClick={() => openPost(post)}
                                    className="grid min-h-11 w-full grid-cols-[auto_minmax(0,1fr)] items-center gap-3 px-4 py-3 text-left transition-colors duration-150 hover:bg-surface-inset focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-brand motion-reduce:transition-none sm:grid-cols-[auto_auto_minmax(0,1fr)_auto]"
                                  >
                                    <span className="nums text-[13px] font-bold text-text tabular-nums">
                                      {fmtTime(post.scheduledAt, post.scheduleTimezone ?? calendarTimezone)}
                                    </span>
                                    <Badge tone={calendarStatusTone(calendarRecordStatus(post))} className="hidden sm:inline-flex">
                                      {CALENDAR_STATUS_LABEL[calendarRecordStatus(post)] ?? calendarRecordStatus(post)}
                                    </Badge>
                                    <span className="truncate text-[14px] text-text-2">{post.text}</span>
                                    <NetworkChips networks={post.networks} />
                                  </button>
                                </li>
                              ))}
                            </ul>
                          )}
                        </Card>
                      );
                    })}
                  </div>
                )}
              </motion.div>
            </>
          )}
        </div>

        {s.ready && view !== "month" && <WeekSummary posts={weekPosts} />}

        {s.ready && (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.65fr)_minmax(17rem,0.75fr)]">
            <UpcomingPublications
              posts={upcomingPosts}
              calendarTimezone={calendarTimezone}
              onOpen={openPost}
              onCreate={canEdit ? () => router.push("/app/composer?from=calendar") : undefined}
              exportAction={canEdit ? (
                <ProjectExportButton
                  channels={s.realChannels}
                  defaultKind="content_plan"
                  initialPeriod={exportPeriod}
                />
              ) : null}
            />
            <CalendarTip />
          </div>
        )}

        {/* --------------------------------------- ВТОРИЧНЫЕ МАТЕРИАЛЫ */}
        <section aria-label="Дополнительные материалы календаря">
          {!s.ready ? (
            <SideSkeleton />
          ) : (
            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              {/* Очередь без дат */}
              <Card as="section" className="p-4">
                <header className="flex items-center justify-between gap-2">
                  <h2
                    ref={draftQueueHeadingRef}
                    tabIndex={-1}
                    className="flex items-center gap-2 text-[15px] font-extrabold tracking-tight text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"
                  >
                    <Inbox className="h-[18px] w-[18px] text-text-2" strokeWidth={2} aria-hidden />
                    Очередь без дат
                  </h2>
                  <span className="nums rounded-full bg-surface-inset px-2 py-0.5 text-[13px] font-bold text-text-2">
                    {queue.length}
                  </span>
                </header>

                {!draftsReadyForUser ? (
                  <div className="mt-3 space-y-2" aria-label="Загружаем серверные черновики">
                    <div className="skeleton h-20 w-full" />
                    <div className="skeleton h-20 w-full" />
                  </div>
                ) : draftsError && serverDrafts.length === 0 ? (
                  <div className="mt-3 rounded-sm bg-danger-soft p-3">
                    <p className="text-[13px] leading-relaxed font-medium text-danger-text">
                      Серверные черновики не загрузились. Локальные копии ниже не менялись.
                    </p>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="mt-2"
                      onClick={() => s.user && void refreshDrafts(s.user)}
                    >
                      <RotateCw className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                      Повторить
                    </Button>
                  </div>
                ) : queue.length === 0 ? (
                  <EmptyState
                    icon={<Inbox className="h-5 w-5" strokeWidth={1.5} aria-hidden />}
                    title="Очередь пуста"
                    body={canPublish
                      ? "Согласованные черновики без даты можно запланировать здесь. Остальные доступны для проверки."
                      : "Черновики без даты появятся здесь — их можно открыть и проверить."}
                  />
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {queue.map((p) => {
                      const editorialStatus = (p.calendarStatus ?? "draft") as CalendarEditorialStatus;
                      const action = calendarQueueAction(currentRole, editorialStatus);
                      return (
                        <li key={p.id} className="rounded-sm bg-surface-2 p-3 ring-1 ring-line">
                          <div className="flex min-w-0 flex-wrap items-center gap-2">
                            <Badge tone={calendarStatusTone(editorialStatus)}>
                              {CALENDAR_STATUS_LABEL[editorialStatus] ?? editorialStatus}
                            </Badge>
                            <NetworkChips networks={p.networks} />
                          </div>
                          <p className="mt-2 line-clamp-2 break-words text-[14px] leading-snug text-text">
                            {p.text}
                          </p>

                          {p.sourceRef && (
                            <div className="mt-2">
                              <SourceBadge label={p.sourceRef.label} />
                            </div>
                          )}

                          <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">
                            <Button
                              variant={action.kind === "schedule" ? "soft" : "ghost"}
                              size="sm"
                              onClick={() => openPost(p)}
                            >
                              {action.kind === "schedule" ? (
                                <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                              ) : (
                                <Eye className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                              )}
                              {action.label}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                )}

                {(localRecovery.length > 0 || (canEdit && unownedLocalRecovery.length > 0)) && (
                  <div className="mt-4 border-t border-line pt-4">
                    <h3 className="text-[14px] font-extrabold text-text">Локальные копии этого браузера</h3>
                    {localRecovery.length > 0 && (
                      <>
                        <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                          Эти копии были записаны для текущего аккаунта и не смешиваются с другими.
                        </p>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2"
                          aria-expanded={showLocalRecovery}
                          onClick={() => setShowLocalRecovery((visible) => !visible)}
                        >
                          {showLocalRecovery ? "Скрыть локальные копии" : `Показать локальные копии (${localRecovery.length})`}
                        </Button>
                        {showLocalRecovery && (
                          <ul className="mt-3 flex flex-col gap-2">
                            {localRecovery.map((post) => (
                              <li key={post.id} className="rounded-sm bg-surface-inset p-3 ring-1 ring-line">
                                <p className="line-2 text-[13px] leading-snug text-text">{post.text}</p>
                                {post.scheduledAt && (
                                  <p className="mt-1 text-[12px] text-text-3">
                                    Локальная дата: {fmtDateTime(post.scheduledAt)}
                                  </p>
                                )}
                                <div className="mt-2 flex items-center justify-end gap-1">
                                  <Button variant="soft" size="sm" onClick={() => openPost(post)}>
                                    Открыть копию
                                  </Button>
                                  {canEdit && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="w-11 px-0"
                                      aria-label="Удалить локальную копию из этого браузера"
                                      onClick={() => removeLocalRecovery(post)}
                                    >
                                      <X className="h-4 w-4" strokeWidth={2} aria-hidden />
                                    </Button>
                                  )}
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}

                    {canEdit && unownedLocalRecovery.length > 0 && (
                      <div className={localRecovery.length ? "mt-4 border-t border-line pt-4" : "mt-2"}>
                        <div className="flex items-start gap-2 rounded-sm bg-fire-soft p-3 text-[13px] text-fire-text ring-1 ring-line">
                          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-fire" strokeWidth={2} aria-hidden />
                          <p className="leading-relaxed">
                            Найдены старые копии без отметки аккаунта. Они могут принадлежать другому
                            человеку, который входил в этом браузере, поэтому мы не показываем текст и
                            не импортируем их автоматически.
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="mt-2"
                          aria-expanded={showUnownedRecovery}
                          onClick={() => setShowUnownedRecovery((visible) => !visible)}
                        >
                          {showUnownedRecovery
                            ? "Скрыть старые копии"
                            : `Проверить старые копии (${unownedLocalRecovery.length})`}
                        </Button>
                        {showUnownedRecovery && (
                          <div className="mt-3">
                            <p className="text-[12px] leading-relaxed text-text-3">
                              Привязывай копию только на личном устройстве. Её текст откроется после
                              подтверждения, а на сервер попадёт только после отдельного сохранения.
                            </p>
                            <ul className="mt-2 flex flex-col gap-2">
                              {unownedLocalRecovery.map((post, index) => (
                                <li key={post.id} className="rounded-sm bg-surface-inset p-3 ring-1 ring-line">
                                  <p className="text-[13px] font-semibold text-text">
                                    Старая локальная копия {index + 1}
                                  </p>
                                  <p className="mt-1 text-[12px] text-text-3">
                                    Сохранена в браузере {fmtDateTime(post.createdAt)}. Содержимое скрыто.
                                  </p>
                                  <div className="mt-2 flex items-center justify-end gap-1">
                                    <Button variant="soft" size="sm" onClick={() => claimLocalRecovery(post)}>
                                      Это моя копия — привязать
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      className="w-11 px-0"
                                      aria-label="Удалить непривязанную локальную копию из этого браузера"
                                      onClick={() => removeLocalRecovery(post)}
                                    >
                                      <X className="h-4 w-4" strokeWidth={2} aria-hidden />
                                    </Button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Card>

              {/* Предложения ИИ */}
              <Card as="section" className="p-4">
                <header className="flex items-center gap-2">
                  <Sparkles className="h-[18px] w-[18px] text-brand" strokeWidth={2} aria-hidden />
                  <h2 className="text-[15px] font-extrabold tracking-tight text-text">
                    Платформа предлагает
                  </h2>
                </header>
                <p className="mt-1 text-[13px] leading-relaxed text-text-2">
                  Здесь появляются подтверждённые примеры из добавленных публичных источников.
                </p>

                {suggestions.length === 0 ? (
                  <EmptyState
                    icon={<Sparkles className="h-5 w-5" strokeWidth={1.5} aria-hidden />}
                    title="Пока нечего предложить"
                    body="Добавьте публичный источник, и подтверждённые примеры появятся здесь."
                  />
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {suggestions.map((t) => (
                      <li key={t.id} className="rounded-sm bg-surface-2 p-3 ring-1 ring-line">
                        <div className="flex items-start justify-between gap-2">
                          <p className="line-2 text-[14px] leading-snug font-semibold text-text">
                            {t.title}
                          </p>
                          <Badge tone="fire" className="shrink-0">
                            <Flame className="h-3 w-3" strokeWidth={2.5} aria-hidden />
                            {fmtMultiplier(t.multiplier)}
                          </Badge>
                        </div>

                        {canEdit && (
                          <Button
                            variant="soft"
                            size="sm"
                            className="mt-2.5 w-full"
                            onClick={() => makeDraft(t)}
                          >
                            <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                            Сделать черновик
                          </Button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </section>
      </div>

      {canInspectPublication && (
        <PublicationActionsDialog
          key={publicationTarget
            ? `${publicationTarget.operationId}:${publicationTarget.scheduleRevision}`
            : "closed-publication-actions"}
          target={publicationTarget}
          busy={publicationBusy}
          onClose={() => {
            if (!publicationBusy) setPublicationTarget(null);
          }}
          onEdit={() => void editTargetPublication()}
          onOpenReviewDraft={(draftId) => {
            setPublicationTarget(null);
            router.push(`/app/composer?draft=${draftId}&from=calendar`);
          }}
          onCancel={() => void cancelTargetPublication()}
          onReschedule={(value) => void rescheduleTargetPublication(value)}
          canManageSchedule={canPublish}
        />
      )}

      <CalendarMoveDialog
        post={movePickerPost}
        days={weekDays}
        calendarTimezone={calendarTimezone}
        canDropOn={canDropPostOn}
        onClose={() => setMovePickerPostId(null)}
        onMove={(post, day) => {
          setMovePickerPostId(null);
          void moveCalendarPost(post, day);
        }}
      />

      <CalendarDragOverlay
        preview={dragPreview}
        post={draggedPost}
        calendarTimezone={calendarTimezone}
        reduceMotion={Boolean(reduce)}
      />

    </AppShell>
  );
}
