"use client";

// А4. Календарь — ГЛАВНЫЙ экран платформы (ТЗ 5.3, Приложение А).
// Одно главное действие: создать пост кликом в день. Публикует сервер.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion, useReducedMotion } from "motion/react";
import {
  AlertTriangle,
  CalendarDays,
  CalendarPlus,
  Check,
  ChevronLeft,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Flame,
  Inbox,
  LayoutGrid,
  Plus,
  RotateCw,
  Sparkles,
  X,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  deleteDraftAfterAck,
  DraftRequestError,
  isRecoverableLegacyDraft,
  isUnownedLegacyDraftCandidate,
  listServerDrafts,
} from "@/lib/draft-client";
import type { ServerDraft } from "@/lib/draft-types";
import { useStore } from "@/lib/store";
import type { Network, Post, RealPost, Trend, User } from "@/lib/types";
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

type View = "week" | "month";

type DraftDeleteTarget = {
  id: number;
  version: number;
};

type CalendarPost = Post & {
  serverDraftId?: number;
  draftVersion?: number;
  destinationIds?: number[];
  publicationParts?: RealPost["publication_parts"];
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
  "failed",
];

const DEFAULT_TIME = "10:00";
const EASE_SOFT: [number, number, number, number] = [0.22, 1, 0.36, 1];

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
  };
}

function serverDraftToPost(draft: ServerDraft): CalendarPost {
  const networks = [...new Set(draft.destinations.map((destination) => destination.network))];
  return {
    id: `draft-${draft.id}`,
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

const dayKey = (d: Date) => `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;

/** Новый пост на конкретный день: сразу отдаём редактору дату и время */
const composerForDay = (day: Date) => {
  const localDate = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
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
}: {
  post: DatedPost;
  onOpen: () => void;
  onRetry: () => void;
}) {
  // Метка канала нужна только при мультиканальности. Считаем здесь, а не прокидываем
  // пропом через календарь → неделю → день → карточку: стор всё равно контекст.
  const store = useStore();
  // Мультиканальность — по всем активным каналам (TG + VK): метка канала нужна,
  // когда их больше одного, независимо от сети.
  const multiChannel = store.realChannels.filter((c) => c.is_active).length > 1;
  // Сервер публикует прямо сейчас — показываем это честно
  if (post.status === "publishing") {
    return (
      <div
        aria-live="polite"
        className="rounded-sm border-l-2 border-brand bg-surface p-2.5 ring-1 ring-line"
      >
        <div className="skeleton h-3 w-10" />
        <div className="skeleton mt-2 h-3 w-full" />
        <div className="skeleton mt-1.5 h-3 w-2/3" />
        <p className="mt-2 text-[13px] font-semibold text-brand">Отправляем…</p>
      </div>
    );
  }

  const failed = post.status === "failed";
  const retrying = post.status === "failed_retry";
  const quarantined = post.status === "quarantined";
  const published = post.status === "published";
  const draft = post.status === "draft";
  const missing = post.status === "missing" || post.status === "deleted_external";
  const unverified = post.status === "published_unverified";

  return (
    <article
      id={`calendar-${post.id}`}
      tabIndex={-1}
      className={cn(
        "relative rounded-sm border-l-2 shadow-soft ring-1 ring-line",
        "transition-[transform,box-shadow] duration-200 ease-[var(--ease-soft)]",
        "hover:-translate-y-0.5 hover:shadow-card",
        failed || missing || quarantined
          ? "border-danger bg-danger-soft"
          : published
            ? "border-success bg-surface"
            : unverified
              ? "border-fire bg-fire-soft"
            : "border-brand bg-surface",
      )}
    >
      {/* Клик по всей карточке → редактор. Кнопка снизу, контент сверху — без вложенных кнопок */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Открыть в редакторе: ${post.text.slice(0, 60)}`}
        className="absolute inset-0 z-0 cursor-pointer rounded-sm"
      />

      <div className="pointer-events-none relative z-10 flex flex-col gap-1.5 p-2.5">
        <div className="flex items-center justify-between gap-2">
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
            <span className="nums text-[13px] font-bold text-text">{fmtTime(post.scheduledAt)}</span>
            {draft && (
              <span className="rounded-full bg-info-soft px-1.5 py-0.5 text-[11px] font-bold text-info-text">
                Черновик
              </span>
            )}
          </span>
          <NetworkChips networks={post.networks} />
        </div>

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

        {quarantined && (
          <span className="text-[13px] font-semibold text-danger-text">
            Дата истекла. Пост не будет отправлен без нового подтверждения.
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
            className="pointer-events-auto relative z-20 inline-flex items-center gap-1 self-start text-[13px] font-semibold text-brand transition-opacity duration-200 hover:opacity-70"
          >
            Открыть пост
            <ExternalLink className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </a>
        )}

        {/* Сбой: что случилось → что делаем → что нужно от тебя (ТЗ 7.5) */}
        {failed && (
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
        {quarantined && (
          <Button
            variant="danger"
            size="sm"
            onClick={onRetry}
            className="pointer-events-auto mt-0.5 w-full"
          >
            <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            Перенести на 2 минуты
          </Button>
        )}
      </div>
    </article>
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
}: {
  day: Date;
  index: number;
  posts: DatedPost[];
  isToday: boolean;
  isPast: boolean;
  onAdd: () => void;
  onOpen: (post: DatedPost) => void;
  onRetry: (post: DatedPost) => void;
}) {
  return (
    <div
      className={cn(
        "group/day flex flex-col rounded-md ring-1 transition-colors duration-200",
        isToday ? "bg-surface ring-brand/35" : "ring-line",
        !isToday && isPast ? "bg-surface-2/60" : "bg-surface",
      )}
    >
      <div className="flex items-center gap-2 px-2.5 pt-2.5 pb-1.5 md:justify-between">
        <span
          className={cn(
            "text-[13px] font-semibold",
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

      <div className="flex min-h-[88px] flex-1 flex-col gap-1.5 p-1.5 pt-0 md:min-h-[180px]">
        {posts.map((p) => (
          <PostCard key={p.id} post={p} onOpen={() => onOpen(p)} onRetry={() => onRetry(p)} />
        ))}

        {/* Пустое место в дне — и есть кнопка «создать пост» (главное действие) */}
        <button
          type="button"
          onClick={onAdd}
          aria-label={`Создать пост: ${weekdayFull(index)}, ${fmtDate(day.toISOString())}, ${DEFAULT_TIME}`}
          className={cn(
            "flex min-h-[44px] flex-1 cursor-pointer items-center justify-center rounded-sm",
            "border border-dashed border-transparent transition-colors duration-200",
            "hover:border-line-strong hover:bg-surface-inset/70",
            "focus-visible:border-line-strong focus-visible:bg-surface-inset/70",
          )}
        >
          <span
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full bg-surface-inset text-text-2 shadow-soft",
              "transition-[opacity,color,transform] duration-200 ease-[var(--ease-soft)]",
              "group-hover/day:text-brand",
              // На тач-устройствах кнопка видна всегда, на десктопе — по наведению
              "opacity-100 md:opacity-0",
              "md:group-hover/day:opacity-100 md:group-focus-within/day:opacity-100",
              "[@media(hover:none)]:opacity-100",
            )}
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} aria-hidden />
          </span>
        </button>
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
}: {
  day: Date;
  posts: DatedPost[];
  inMonth: boolean;
  isToday: boolean;
  onPick: () => void;
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
              {fmtTime(p.scheduledAt)}
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
    <div className="grid gap-2 md:grid-cols-7">
      {Array.from({ length: 7 }, (_, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md bg-surface p-2 ring-1 ring-line">
          <div className="skeleton h-7 w-full" />
          <div className="skeleton h-14 w-full" />
          {i % 2 === 0 && <div className="skeleton h-14 w-full" />}
          <div className="min-h-[40px] md:min-h-[70px]" />
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

/* --------------------------------------------------------------- ЭКРАН */

export default function CalendarPage() {
  const router = useRouter();
  const s = useStore();
  const reduce = useReducedMotion();

  const [view, setView] = useState<View>("week");
  const [dir, setDir] = useState(0);
  const [anchor, setAnchor] = useState<Date>(() => new Date());
  const [serverDrafts, setServerDrafts] = useState<ServerDraft[]>([]);
  const [draftOwner, setDraftOwner] = useState<User | null>(null);
  const [draftsReady, setDraftsReady] = useState(false);
  const [draftsError, setDraftsError] = useState(false);
  const [deletingDraftId, setDeletingDraftId] = useState<number | null>(null);
  const [draftDeleteTarget, setDraftDeleteTarget] = useState<DraftDeleteTarget | null>(null);
  const [showLocalRecovery, setShowLocalRecovery] = useState(false);
  const [showUnownedRecovery, setShowUnownedRecovery] = useState(false);
  const draftQueueHeadingRef = useRef<HTMLHeadingElement>(null);
  const focusedPostRef = useRef<string | null>(null);

  const hasUser = Boolean(s.user);
  const refreshDrafts = useCallback(async (owner: User, signal?: AbortSignal) => {
    try {
      const drafts = await listServerDrafts(signal);
      if (signal?.aborted) return;
      setServerDrafts(drafts);
      setDraftOwner(owner);
      setDraftsError(false);
    } catch (error) {
      if (signal?.aborted) return;
      setServerDrafts([]);
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
    setAnchor(new Date(post.scheduled_at));
    setView("week");
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const element = document.getElementById(focusedPostRef.current ?? "");
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ behavior: "smooth", block: "center" });
    }));
  }, [s.ready, s.realPosts]);

  // Полночь сегодняшнего дня. Считается на клиенте — до s.ready ничего датозависимого не рисуем
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const weekStart = useMemo(() => startOfWeek(anchor), [anchor]);
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

  // В авторизованном календаре основной источник только серверный. Демо/localStorage
  // не смешиваются с публикациями и черновиками аккаунта.
  const gridPosts = useMemo(() => {
    const all: CalendarPost[] = [...s.realPosts.map(realToPost), ...serverDraftPosts];
    if (!hidden.size) return all;
    return all.filter((p) =>
      p.destinationIds?.length
        ? p.destinationIds.some((id) => !hidden.has(id))
        : p.channelId == null || !hidden.has(p.channelId),
    );
  }, [s.realPosts, serverDraftPosts, hidden]);

  // Посты по дням — один проход вместо фильтра на каждую ячейку
  const postsByDay = useMemo(() => {
    const map = new Map<string, DatedPost[]>();
    for (const p of gridPosts) {
      if (!isOnGrid(p)) continue;
      const key = dayKey(new Date(p.scheduledAt));
      const list = map.get(key);
      if (list) list.push(p);
      else map.set(key, [p]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime());
    }
    return map;
  }, [gridPosts]);

  const dayPosts = (d: Date) => postsByDay.get(dayKey(d)) ?? [];

  // Основная очередь теперь только серверная. Старый глобальный localStorage ниже показан
  // отдельно как recovery-копии: он не привязан к пользователю и потому не импортируется сам.
  const queue = useMemo(
    () => serverDraftPosts.filter((post) => !post.scheduledAt),
    [serverDraftPosts],
  );
  const localRecovery = useMemo(
    () => (s.user ? s.posts.filter((post) => isRecoverableLegacyDraft(post, s.user!.id)) : []),
    [s.posts, s.user],
  );
  const unownedLocalRecovery = useMemo(
    () => (s.user ? s.posts.filter(isUnownedLegacyDraftCandidate) : []),
    [s.posts, s.user],
  );

  const visibleDays = view === "week" ? weekDays : monthCells;
  const periodCount = visibleDays.reduce((n, d) => {
    if (view === "month" && d.getMonth() !== anchor.getMonth()) return n;
    return n + dayPosts(d).length;
  }, 0);

  const isCurrentPeriod =
    view === "week"
      ? sameDay(weekStart, startOfWeek(today))
      : anchor.getFullYear() === today.getFullYear() && anchor.getMonth() === today.getMonth();

  const shift = (delta: number) => {
    setDir(delta);
    setAnchor((prev) =>
      view === "week"
        ? addDays(startOfWeek(prev), delta * 7)
        : new Date(prev.getFullYear(), prev.getMonth() + delta, 1),
    );
  };

  const goToday = () => {
    setDir(0);
    setAnchor(new Date());
  };

  const openPost = (post: CalendarPost) => {
    if (post.serverDraftId != null) {
      router.push(`/app/composer?draft=${post.serverDraftId}`);
      return;
    }
    if ((post.status === "draft" || post.status === "queued") && !post.id.startsWith("real-")) {
      router.push(`/app/composer?legacy=${encodeURIComponent(post.id)}`);
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
          ? (post.failReason ?? "Можно отправить снова кнопкой на карточке.")
          : post.scheduledAt
            ? `${fmtDateTime(post.scheduledAt)}. Публикует сервер.`
            : "",
    });
  };
  const addPostOn = (day: Date) => router.push(composerForDay(day));

  const removeDraft = async () => {
    const target = draftDeleteTarget;
    if (!target || deletingDraftId != null) return;
    setDeletingDraftId(target.id);
    try {
      await deleteDraftAfterAck(target.id, target.version, (acknowledgedId) => {
        setServerDrafts((drafts) => drafts.filter((draft) => draft.id !== acknowledgedId));
      });
      s.toast({ kind: "success", title: "Черновик удалён" });
      setDraftDeleteTarget(null);
      requestAnimationFrame(() => draftQueueHeadingRef.current?.focus());
    } catch (error) {
      s.toast({
        kind: "danger",
        title: "Черновик не удалён",
        body:
          error instanceof DraftRequestError && error.kind === "conflict"
            ? "Его уже изменили в другой вкладке. Обновили список — проверь актуальную версию."
            : "Сервер не подтвердил удаление. Попробуй ещё раз.",
      });
      if (s.user) await refreshDrafts(s.user);
      setDraftDeleteTarget(null);
    } finally {
      setDeletingDraftId(null);
    }
  };

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
    view === "week"
      ? `w${weekStart.getTime()}`
      : `m${anchor.getFullYear()}-${anchor.getMonth()}`;

  // `s.trends` — демонстрационный seed. В авторизованный календарь его не подмешиваем.
  const suggestions = s.user ? [] : s.trends.slice(0, 3);

  return (
    <AppShell
      title="Календарь"
      subtitle="Кликни на день — создашь пост. Публикует сервер, твой компьютер не нужен."
      action={
        <Button variant="brand" size="md" onClick={() => router.push("/app/composer")}>
          <Plus className="h-[18px] w-[18px]" strokeWidth={2.5} aria-hidden />
          Новый пост
        </Button>
      }
    >
      <div className="flex flex-col gap-6 xl:flex-row xl:items-start">
        {/* ------------------------------------------------------- СЕТКА */}
        <div className="min-w-0 flex-1">
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
              <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={view === "week" ? "Предыдущая неделя" : "Предыдущий месяц"}
                    onClick={() => shift(-1)}
                  >
                    <ChevronLeft className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </Button>

                  <p className="min-w-[150px] text-center text-[17px] font-extrabold -tracking-[0.02em] text-text sm:text-left">
                    {view === "week" ? weekRangeLabel(weekStart) : monthTitle(anchor)}
                  </p>

                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-10 w-10"
                    aria-label={view === "week" ? "Следующая неделя" : "Следующий месяц"}
                    onClick={() => shift(1)}
                  >
                    <ChevronRight className="h-5 w-5" strokeWidth={2} aria-hidden />
                  </Button>

                  {!isCurrentPeriod && (
                    <Button variant="ghost" size="sm" onClick={goToday} className="ml-1">
                      Сегодня
                    </Button>
                  )}
                </div>

                <div className="flex items-center gap-3">
                  <span className="nums hidden text-[13px] text-text-2 md:inline">
                    {periodCount} {plural(periodCount, "пост", "поста", "постов")}
                  </span>
                  <Tabs<View>
                    value={view}
                    onChange={setView}
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
                    ]}
                  />
                </div>
              </div>

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
                          "inline-flex h-9 max-w-[16rem] cursor-pointer items-center gap-2 rounded-full border px-3",
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
                      className="inline-flex items-center gap-2 rounded-full bg-fire-soft px-3 py-1.5 text-[13px] font-semibold text-fire-text"
                    >
                      <EyeOff className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden />
                      {hidden.size}{" "}
                      {plural(hidden.size, "канал скрыт", "канала скрыто", "каналов скрыто")}
                      <button
                        type="button"
                        onClick={() => setHidden(new Set())}
                        className="cursor-pointer rounded-xs underline underline-offset-2 hover:no-underline"
                      >
                        Показать все
                      </button>
                    </div>
                  )}
                </div>
              )}

              <motion.div
                key={periodKey}
                initial={reduce ? false : { opacity: 0, x: dir * 10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ duration: 0.22, ease: EASE_SOFT }}
              >
                {view === "week" ? (
                  <div className="grid gap-2 md:grid-cols-7">
                    {weekDays.map((day, i) => (
                      <DayColumn
                        key={day.toISOString()}
                        day={day}
                        index={i}
                        posts={dayPosts(day)}
                        isToday={sameDay(day, today)}
                        isPast={day.getTime() < today.getTime()}
                        onAdd={() => addPostOn(day)}
                        onOpen={openPost}
                        onRetry={(p) =>
                          p.id.startsWith("real-") ? s.retryRealPost(realId(p.id)) : s.retryPost(p.id)
                        }
                      />
                    ))}
                  </div>
                ) : (
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
                          onPick={() => {
                            setDir(0);
                            setAnchor(day);
                            setView("week");
                          }}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </motion.div>
            </>
          )}
        </div>

        {/* ----------------------------------------------- ПРАВАЯ КОЛОНКА */}
        <aside className="w-full xl:sticky xl:top-6 xl:w-[320px] xl:shrink-0 xl:self-start">
          {!s.ready ? (
            <SideSkeleton />
          ) : (
            <div className="flex flex-col gap-4">
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
                ) : draftsError ? (
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
                    body="Черновики без даты появятся здесь. Их можно поставить в календарь в один клик."
                  />
                ) : (
                  <ul className="mt-3 flex flex-col gap-2">
                    {queue.map((p) => (
                      <li key={p.id} className="rounded-sm bg-surface-2 p-3 ring-1 ring-line">
                        <p className="line-2 text-[14px] leading-snug text-text">{p.text}</p>

                        {p.sourceRef && (
                          <div className="mt-2">
                            <SourceBadge label={p.sourceRef.label} />
                          </div>
                        )}

                        <div className="mt-2.5 flex items-center gap-2">
                          <NetworkChips networks={p.networks} />
                          <div className="ml-auto flex items-center gap-1">
                            <Button variant="soft" size="sm" onClick={() => openPost(p)}>
                              <CalendarPlus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                              Запланировать
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              className="w-9 px-0"
                              aria-label="Удалить черновик"
                              aria-haspopup="dialog"
                              loading={deletingDraftId === p.serverDraftId}
                              onClick={() => {
                                if (p.serverDraftId == null || p.draftVersion == null) return;
                                setDraftDeleteTarget({
                                  id: p.serverDraftId,
                                  version: p.draftVersion,
                                });
                              }}
                            >
                              {deletingDraftId !== p.serverDraftId && (
                                <X className="h-4 w-4" strokeWidth={2} aria-hidden />
                              )}
                            </Button>
                          </div>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}

                {(localRecovery.length > 0 || unownedLocalRecovery.length > 0) && (
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
                                  <Button
                                    variant="ghost"
                                    size="sm"
                                    className="w-9 px-0"
                                    aria-label="Удалить локальную копию из этого браузера"
                                    onClick={() => removeLocalRecovery(post)}
                                  >
                                    <X className="h-4 w-4" strokeWidth={2} aria-hidden />
                                  </Button>
                                </div>
                              </li>
                            ))}
                          </ul>
                        )}
                      </>
                    )}

                    {unownedLocalRecovery.length > 0 && (
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
                                      className="w-9 px-0"
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
                  Пример, как это работает. Настоящие залёты твоих конкурентов — в разделе «Сними
                  это», когда добавишь каналы в «Разведке».
                </p>

                {suggestions.length === 0 ? (
                  <EmptyState
                    icon={<Sparkles className="h-5 w-5" strokeWidth={1.5} aria-hidden />}
                    title="Пока нечего предложить"
                    body="Как только у конкурентов что-то залетит, идея появится здесь."
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

                        <Button
                          variant="soft"
                          size="sm"
                          className="mt-2.5 w-full"
                          onClick={() => makeDraft(t)}
                        >
                          <Sparkles className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
                          Сделать черновик
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
            </div>
          )}
        </aside>
      </div>

      <ConfirmDialog
        open={draftDeleteTarget != null}
        title="Удалить черновик?"
        description="Черновик исчезнет из календаря и очереди только после подтверждения сервера. Восстановить удалённую версию автоматически нельзя."
        confirmLabel="Удалить черновик"
        cancelLabel="Оставить"
        busy={deletingDraftId != null}
        onCancel={() => {
          if (deletingDraftId == null) setDraftDeleteTarget(null);
        }}
        onConfirm={() => void removeDraft()}
      />
    </AppShell>
  );
}
