"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  BadgeCheck,
  BrainCircuit,
  Check,
  CheckCircle2,
  Clock3,
  Compass,
  Database,
  EyeOff,
  FileCheck2,
  Flame,
  Lightbulb,
  MoreHorizontal,
  RefreshCw,
  RotateCcw,
  Sparkles,
  TimerReset,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type {
  TodayBoard,
  TodayCompletedItem,
  TodayItem,
  TodayItemType,
  TodayPulse,
  TodayRecommendationKind,
  TodaySource,
} from "@/lib/today";
import { plural } from "@/lib/utils";

const ICONS = {
  opportunity: Lightbulb,
  review: FileCheck2,
  result: CheckCircle2,
  risk: AlertTriangle,
  onboarding: Compass,
} as const;

const ITEM_LABELS = {
  opportunity: "Возможность",
  review: "Нужно решение",
  result: "Результат",
  risk: "Риск",
  onboarding: "Начало",
} as const;

const CONFIDENCE_LABELS = {
  low: "Низкая уверенность",
  medium: "Средняя уверенность",
  high: "Высокая уверенность",
} as const;

const STATE_LABELS = {
  observed: "Наблюдаемые данные",
  inferred: "Объяснимый вывод",
  insufficient_data: "Данных мало",
  stale: "Устарело",
  blocked: "Действие заблокировано",
} as const;

const SOURCE_LABELS: Record<TodaySource, string> = {
  reviews: "Черновики и проверки",
  opportunities: "Возможности",
  results: "Результаты публикаций",
};

const GROUPS: Array<{
  key: string;
  title: string;
  description: string;
  types: TodayItemType[];
}> = [
  { key: "decisions", title: "Требует решения", description: "Риски и черновики, которые ждут вашего действия.", types: ["risk", "review"] },
  { key: "opportunities", title: "Можно использовать", description: "Свежие темы с проверяемым основанием.", types: ["opportunity"] },
  { key: "results", title: "Стоит проверить", description: "Новые наблюдаемые результаты публикаций.", types: ["result"] },
];

type LoadStatus = "loading" | "ready" | "error";
type ItemState = "done" | "snoozed";
type UndoNotice =
  | { kind: "state"; item: TodayItem; channelId: number; state: ItemState }
  | { kind: "feedback"; item: TodayItem; channelId: number; recommendationKind: TodayRecommendationKind; hiddenItems: TodayItem[] };

function safeChannelId(value: string | null): number | null {
  const channelId = Number(value);
  return Number.isSafeInteger(channelId) && channelId > 0 ? channelId : null;
}

function updatedLabel(board: TodayBoard): string {
  if (!board.lastSuccessfulAt) return "Ещё не обновляли";
  try {
    const formatted = new Intl.DateTimeFormat("ru-RU", {
      timeZone: board.timezone,
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(board.lastSuccessfulAt));
    return `Последнее обновление: ${formatted}`;
  } catch {
    return "Последнее обновление: недавно";
  }
}

function orderedItems(items: TodayItem[]): TodayItem[] {
  const grouped = GROUPS.flatMap((group) => items.filter((item) => group.types.includes(item.type)));
  return [...grouped, ...items.filter((item) => item.type === "onboarding")];
}

function sourceForItem(item: TodayItem): TodaySource | null {
  if (item.type === "risk" || item.type === "review") return "reviews";
  if (item.type === "opportunity") return "opportunities";
  if (item.type === "result") return "results";
  return null;
}

function stableClientRank(items: TodayItem[]): TodayItem[] {
  const typeOrder: Record<TodayItemType, number> = { risk: 0, review: 1, opportunity: 2, result: 3, onboarding: 4 };
  return [...items]
    .sort((a, b) => b.priority - a.priority || typeOrder[a.type] - typeOrder[b.type] || a.fingerprint.localeCompare(b.fingerprint))
    .slice(0, 5);
}

function TodayLoadingCard() {
  return (
    <Card className="min-h-64 p-6" role="status" aria-busy="true">
      <div className="skeleton h-7 w-44 rounded-xs" />
      <div className="mt-5 space-y-3">
        <div className="skeleton h-24 rounded-sm" />
        <div className="skeleton h-24 rounded-sm" />
      </div>
      <span className="sr-only">Собираем решения на сегодня</span>
    </Card>
  );
}

function TodayPageFallback() {
  return (
    <AppShell title="Сегодня" subtitle="Приоритетные решения по выбранному каналу.">
      <div className="mx-auto w-full max-w-[68rem]"><TodayLoadingCard /></div>
    </AppShell>
  );
}

function metric(value: number): string {
  return new Intl.NumberFormat("ru-RU", { notation: value >= 10_000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(value);
}

function comparisonLabel(value: number | null, suffix = "%"): string {
  if (value == null) return "Нет сравнения";
  if (value === 0) return "Без изменений";
  return `${value > 0 ? "+" : "−"}${Math.abs(value).toLocaleString("ru-RU")}${suffix} к прошлым 7 дням`;
}

function PulseArtwork({ values }: { values: number[] }) {
  if (values.length === 0) return null;
  const width = 360;
  const height = 128;
  const padX = 12;
  const padY = 12;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (index: number) => values.length === 1 ? width / 2 : padX + (index / (values.length - 1)) * (width - padX * 2);
  const y = (value: number) => max === min ? height / 2 : height - padY - ((value - min) / span) * (height - padY * 2);
  const points = values.map((value, index) => `${x(index)},${y(value)}`).join(" ");
  const area = `${x(0)},${height - padY} ${points} ${x(values.length - 1)},${height - padY}`;
  return (
    <svg
      aria-hidden="true"
      className="h-28 w-full overflow-visible"
      viewBox={`0 0 ${width} ${height}`}
      fill="none"
      preserveAspectRatio="none"
    >
      <defs>
        <linearGradient id="today-pulse-fill" x1="180" y1="26" x2="180" y2="128" gradientUnits="userSpaceOnUse">
          <stop stopColor="var(--brand-1)" stopOpacity={0.3} />
          <stop offset="1" stopColor="var(--brand-1)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={area} fill="url(#today-pulse-fill)" />
      <polyline
        points={points}
        stroke="var(--brand-1)"
        strokeOpacity={0.95}
        strokeWidth="2.5"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
      {values.map((value, index) => <circle key={`${index}:${value}`} cx={x(index)} cy={y(value)} r="3" fill="var(--surface)" stroke="var(--brand-1)" strokeWidth="2" vectorEffect="non-scaling-stroke" />)}
    </svg>
  );
}

function PulseEmptyGraphic({ text }: { text: string }) {
  return <div className="grid min-h-28 place-items-center rounded-sm bg-surface-inset px-5 text-center"><div><BarChart3 className="mx-auto h-5 w-5 text-text-3" aria-hidden /><p className="mt-2 type-caption text-text-3">{text}</p></div></div>;
}

function ChannelPulse({ pulse, channelId, refreshing, onRefresh }: {
  pulse: TodayPulse;
  channelId: number | null;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  if (pulse.state === "unavailable") {
    return (
      <Card as="section" className="overflow-hidden p-5 sm:p-6" aria-labelledby="today-pulse-title">
        <div className="grid items-center gap-6 md:grid-cols-[minmax(0,0.9fr)_minmax(15rem,1.1fr)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-text-3"><BarChart3 className="h-4 w-4 shrink-0 text-brand" aria-hidden /><p className="type-caption font-semibold">Последние 7 дней</p></div>
            <h2 id="today-pulse-title" className="mt-2">Пульс канала за 7 дней</h2>
            <p className="mt-2 max-w-[55ch] text-pretty text-[14px] leading-relaxed text-text-2">Статистика временно недоступна. Остальные решения можно продолжать разбирать.</p>
            <Button variant="secondary" size="sm" className="mt-4" loading={refreshing} onClick={onRefresh}>Обновить статистику</Button>
          </div>
          <div className="min-w-0"><PulseEmptyGraphic text="Последние подтверждённые данные сохранены" /></div>
        </div>
      </Card>
    );
  }
  if (pulse.state === "no_posts" || pulse.state === "no_stats") {
    return (
      <Card as="section" className="overflow-hidden p-5 sm:p-6" aria-labelledby="today-pulse-title">
        <div className="grid items-center gap-6 md:grid-cols-[minmax(0,0.9fr)_minmax(15rem,1.1fr)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-text-3"><BarChart3 className="h-4 w-4 shrink-0 text-brand" aria-hidden /><p className="type-caption font-semibold">{pulse.periodLabel}</p></div>
            <h2 id="today-pulse-title" className="mt-2">Пульс канала за 7 дней</h2>
            <p className="mt-2 max-w-[55ch] text-pretty text-[14px] leading-relaxed text-text-2">
              {pulse.state === "no_posts"
                ? "За последние 7 дней публикаций не было. После первой публикации здесь появится короткая динамика канала."
                : "Публикации есть, но статистика по ним ещё не получена. Исходные материалы остаются без изменений."}
            </p>
            {pulse.state === "no_posts" ? (
              <Link
                className={buttonClassName({ variant: "primary", size: "sm", className: "mt-4" })}
                href={`/app/autopilot${channelId ? `?channel=${channelId}` : ""}`}
              >
                Создать план в автопилоте
              </Link>
            ) : (
              <Button variant="secondary" size="sm" className="mt-4" loading={refreshing} onClick={onRefresh}>Обновить статистику</Button>
            )}
          </div>
          <div className="min-w-0"><PulseEmptyGraphic text={pulse.state === "no_posts" ? "График появится после первой публикации" : "График появится после получения просмотров"} /></div>
        </div>
      </Card>
    );
  }
  return (
    <Card as="section" className="overflow-hidden p-5 sm:p-6" aria-labelledby="today-pulse-title">
      <div className="grid items-center gap-7 md:grid-cols-[minmax(0,0.92fr)_minmax(15rem,1.08fr)]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2 text-text-3"><BarChart3 className="h-4 w-4 shrink-0 text-brand" aria-hidden /><p className="type-caption font-semibold">{pulse.periodLabel}</p><Badge tone="neutral">Только реальные данные</Badge></div>
          <h2 id="today-pulse-title" className="mt-2">Пульс канала за 7 дней</h2>
          <p className="mt-2 max-w-[55ch] text-pretty text-[14px] leading-relaxed text-text-2">{pulse.insight}</p>
          <dl className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3">
            <div><dt className="type-caption text-text-3">Просмотры</dt><dd className="mt-0.5 font-bold tabular-nums text-text">{metric(pulse.views)}</dd><dd className="type-caption text-text-3">{comparisonLabel(pulse.comparison.viewsPerPostPercent)}</dd></div>
            <div><dt className="type-caption text-text-3">Реакции</dt><dd className="mt-0.5 font-bold tabular-nums text-text">{metric(pulse.reactions)}</dd><dd className="type-caption text-text-3">{comparisonLabel(pulse.comparison.reactionsPerPostPercent)}</dd></div>
          </dl>
          {pulse.bestPost ? (
            <Link className="mt-4 inline-flex min-h-11 items-center break-words text-[14px] font-semibold leading-relaxed text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand focus-visible:rounded-xs" href={pulse.bestPost.href}>Открыть лучший результат</Link>
          ) : null}
        </div>
        <div className="min-w-0" role="img" aria-label={`${pulse.publishedCount} публикаций за 7 дней, ${pulse.postsWithStats} со статистикой. Линия построена по просмотрам публикаций.`}>{pulse.series.length > 0 ? <PulseArtwork values={pulse.series.map((point) => point.views)} /> : <PulseEmptyGraphic text="Просмотры пока недоступны" />}</div>
      </div>
    </Card>
  );
}

function TodaySummaryMetrics({ board, items }: { board: TodayBoard; items: TodayItem[] }) {
  const highConfidenceShare = items.length === 0
    ? 0
    : Math.round((items.filter((item) => item.confidence === "high").length / items.length) * 100);
  const entries = [
    { label: "Решения в фокусе", value: String(items.length), icon: Flame, tone: "text-fire-text" },
    { label: "Период аналитики", value: "7 дней", icon: BarChart3, tone: "text-brand" },
    { label: "Возможности", value: String(board.readiness.opportunityCount), icon: BrainCircuit, tone: "text-danger-text" },
    { label: "Высокая уверенность", value: items.length > 0 ? `${highConfidenceShare}%` : "—", icon: BadgeCheck, tone: "text-success-text" },
  ];
  return (
    <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4" aria-label="Краткая сводка на сегодня">
      {entries.map((entry) => {
        const Icon = entry.icon;
        return (
          <Card as="div" key={entry.label} className="flex min-w-0 flex-col p-4">
            <dt className="order-2 mt-2 type-caption text-text-3">{entry.label}</dt>
            <dd className="order-1 flex items-center gap-2 text-xl font-bold leading-none tabular-nums text-text">
              <Icon className={`h-5 w-5 shrink-0 ${entry.tone}`} strokeWidth={2} aria-hidden />
              <span>{entry.value}</span>
            </dd>
          </Card>
        );
      })}
    </dl>
  );
}

function completedTimeLabel(value: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  } catch {
    return "сегодня";
  }
}

function completedItemForClient(item: TodayItem, completedAt: string): TodayCompletedItem {
  return {
    fingerprint: item.fingerprint,
    type: item.type,
    title: item.title,
    whyNow: item.whyNow,
    channelLabel: item.channelLabel,
    sourceLabel: item.sourceLabel,
    completedAt,
  };
}

function CompletedToday({ items, timezone }: { items: TodayCompletedItem[]; timezone: string }) {
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="today-completed-title">
      <Card className="overflow-hidden">
        <div className="flex flex-col gap-2 border-b border-line px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 id="today-completed-title">Готовые сегодня</h2>
              <Badge tone="success">{items.length}</Badge>
            </div>
            <p className="mt-1 text-[14px] leading-relaxed text-text-3">Здесь сохраняются решения, которые вы уже завершили сегодня.</p>
          </div>
        </div>
        <ol className="divide-y divide-line">
          {items.map((item) => (
            <li key={item.fingerprint}>
              <details className="group px-5 py-4 sm:px-6">
                <summary className="flex min-h-11 cursor-pointer list-none items-center gap-3 rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand [&::-webkit-details-marker]:hidden">
                  <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-success-soft text-success-text">
                    <Check className="h-4 w-4" aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block break-words text-[15px] font-semibold text-text">{item.title}</span>
                    <span className="mt-0.5 block type-caption text-text-3">{item.channelLabel} · готово в {completedTimeLabel(item.completedAt, timezone)}</span>
                  </span>
                  <span className="type-caption shrink-0 font-semibold text-brand group-open:hidden">Посмотреть</span>
                  <span className="type-caption hidden shrink-0 font-semibold text-brand group-open:inline">Скрыть</span>
                </summary>
                <div className="mt-3 rounded-sm bg-surface-inset px-4 py-3 text-[14px] leading-relaxed text-text-2">
                  <p>{item.whyNow}</p>
                  <p className="mt-2 type-caption text-text-3">Источник: {item.sourceLabel}</p>
                </div>
              </details>
            </li>
          ))}
        </ol>
      </Card>
    </section>
  );
}

function TodayItemCard({ item, featured, actionsDisabled, actionLoading, error, setTitleRef, onPrimary, onDone, onSnooze, onHide }: {
  item: TodayItem;
  featured: boolean;
  actionsDisabled: boolean;
  actionLoading: boolean;
  error?: string;
  setTitleRef: (element: HTMLHeadingElement | null) => void;
  onPrimary: (item: TodayItem) => void;
  onDone: (item: TodayItem) => void;
  onSnooze: (item: TodayItem) => void;
  onHide: (item: TodayItem) => void;
}) {
  const Icon = ICONS[item.type];
  return (
    <Card strong={featured} className="relative">
      <div className="min-w-0 p-5 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={item.type === "risk" ? "danger" : featured ? "brand" : "neutral"}>
            <Icon className="h-3.5 w-3.5" aria-hidden />
            {ITEM_LABELS[item.type]}
          </Badge>
          <span className="type-caption break-words text-text-3">{item.channelLabel} · {item.freshness}</span>
        </div>
        <p className="mt-2 type-caption text-text-3">{CONFIDENCE_LABELS[item.confidence]} · {STATE_LABELS[item.epistemicState]}</p>
        <h3 ref={setTitleRef} tabIndex={-1} className="mt-4 max-w-[46rem] text-balance focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">{item.title}</h3>
        <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">
          <span className="font-semibold text-text">Почему сейчас: </span>{item.whyNow}
        </p>
        <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-text-3">
          <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="break-words">Источник данных: {item.sourceLabel}</span>
        </p>
        <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            {item.smartAction ? (
              <Button variant="primary" className="h-auto min-h-11 whitespace-normal text-center" disabled={actionsDisabled} loading={actionLoading} onClick={() => onPrimary(item)}>
                <Sparkles className="h-4 w-4 shrink-0" aria-hidden />{item.primaryAction.label}
              </Button>
            ) : (
              <Link className={buttonClassName({ variant: "primary", className: "h-auto min-h-11 whitespace-normal text-center" })} href={item.primaryAction.href}>
                {item.primaryAction.label}
              </Link>
            )}
            {item.evidence ? <EvidenceCard kind={item.evidence.kind} id={item.evidence.id} compact /> : null}
          </div>
          <div className="flex items-center justify-end gap-2">
            <Button variant="secondary" size="sm" className="min-h-11" disabled={actionsDisabled} loading={!item.smartAction && actionLoading} onClick={() => onDone(item)}>
              <Check className="h-4 w-4" aria-hidden />Готово
            </Button>
            <details className="group/more relative">
              <summary className={buttonClassName({ variant: "secondary", size: "icon", className: "list-none [&::-webkit-details-marker]:hidden" })} aria-label="Дополнительные действия">
                <MoreHorizontal className="h-5 w-5" aria-hidden />
              </summary>
              <div className="card-plain absolute right-0 bottom-[calc(100%+0.5rem)] z-20 w-64 rounded-sm p-2 shadow-float">
                <Button variant="ghost" size="sm" className="w-full justify-start whitespace-normal text-left" disabled={actionsDisabled} onClick={() => onSnooze(item)}>
                  <Clock3 className="h-4 w-4 shrink-0" aria-hidden />Напомнить завтра
                </Button>
                {item.recommendationKind ? (
                  <Button variant="ghost" size="sm" className="w-full justify-start whitespace-normal text-left" disabled={actionsDisabled} onClick={() => onHide(item)}>
                    <EyeOff className="h-4 w-4 shrink-0" aria-hidden />Больше не показывать такое
                  </Button>
                ) : null}
              </div>
            </details>
          </div>
        </div>
        {error ? <p className="mt-4 text-[13px] font-semibold text-danger-text" role="alert">{error}</p> : null}
      </div>
    </Card>
  );
}

function ChannelSelector({ board, id, onChange }: { board: TodayBoard; id: string; onChange: (value: string) => void }) {
  if (board.channels.length <= 1) {
    return <div className="flex flex-wrap items-center gap-x-4 gap-y-1"><p className="type-caption font-semibold text-text-2">Канал</p><p className="break-words text-[15px] font-semibold text-text">{board.channelLabel}</p></div>;
  }
  return (
    <label className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4" htmlFor={id}>
      <span className="type-caption shrink-0 font-semibold text-text-2">Канал</span>
      <select
        id={id}
        value={board.channelId ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="h-12 w-full min-w-0 rounded-xs border border-line bg-surface px-4 text-base font-semibold text-text transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:w-72 sm:text-sm"
      >
        {board.channels.map((channel) => <option key={channel.id} value={channel.id}>{channel.label}{channel.enabled ? "" : " — временно приостановлен"}</option>)}
      </select>
    </label>
  );
}

function TodayPageContent() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const requestedChannelId = safeChannelId(searchParams.get("channel"));
  const [board, setBoard] = useState<TodayBoard | null>(null);
  const boardRef = useRef<TodayBoard | null>(null);
  const [status, setStatus] = useState<LoadStatus>("loading");
  const [refreshing, setRefreshing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [refreshError, setRefreshError] = useState("");
  const [refreshNotice, setRefreshNotice] = useState("");
  const [undo, setUndo] = useState<UndoNotice | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [pendingFocus, setPendingFocus] = useState<string | "summary" | null>(null);
  const [quickMode, setQuickMode] = useState(false);
  const [quickTotal, setQuickTotal] = useState(0);
  const [quickCompleted, setQuickCompleted] = useState(0);
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const stateSequence = useRef(0);
  const feedbackSequence = useRef(0);
  const actionSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const stateController = useRef<AbortController | null>(null);
  const feedbackController = useRef<AbortController | null>(null);
  const actionController = useRef<AbortController | null>(null);
  const titleRefs = useRef(new Map<string, HTMLHeadingElement>());
  const summaryRef = useRef<HTMLHeadingElement>(null);

  const commitBoard = useCallback((next: TodayBoard) => { boardRef.current = next; setBoard(next); }, []);

  const syncChannelUrl = useCallback((channelId: number | null) => {
    const params = new URLSearchParams(searchString);
    if (channelId == null) params.delete("channel"); else params.set("channel", String(channelId));
    const nextSearch = params.toString();
    if (nextSearch === searchString) return;
    router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false });
  }, [pathname, router, searchString]);

  const load = useCallback(async ({ clear = false, channelId = requestedChannelId }: { clear?: boolean; channelId?: number | null } = {}): Promise<boolean> => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const sequence = ++requestSequence.current;
    if (clear) { boardRef.current = null; setBoard(null); setStatus("loading"); }
    else if (boardRef.current) setRefreshing(true); else setStatus("loading");
    setRefreshError("");
    try {
      const query = channelId == null ? "" : `?channel=${channelId}`;
      const response = await fetch(`/api/today${query}`, { cache: "no-store", signal: controller.signal });
       const body = await response.json().catch(() => null) as TodayBoard | null;
       if (!response.ok || !body?.items || !Array.isArray(body.channels) || !Array.isArray(body.completedItems)) throw new Error("today_unavailable");
       if (controller.signal.aborted || sequence !== requestSequence.current) return false;
       const previous = boardRef.current;
       const failedSources = new Set(body.partialErrors.map((error) => error.source));
       const retained = previous?.channelId === body.channelId
         ? previous.items.filter((item) => {
           const source = sourceForItem(item);
           return source != null && failedSources.has(source)
             && !body.items.some((candidate) => candidate.fingerprint === item.fingerprint);
         })
         : [];
       const retainPulse = previous?.channelId === body.channelId
         && failedSources.has("results")
         && previous.pulse.state !== "unavailable";
       const nextBoard = retained.length > 0 || retainPulse
         ? {
           ...body,
           items: retained.length > 0 ? stableClientRank([...body.items, ...retained]) : body.items,
           pulse: retainPulse ? previous.pulse : body.pulse,
         }
         : body;
       commitBoard(nextBoard); setStatus("ready"); syncChannelUrl(nextBoard.channelId); return true;
    } catch {
      if (controller.signal.aborted || sequence !== requestSequence.current) return false;
      if (boardRef.current) { setStatus("ready"); setRefreshError("Не удалось загрузить свежие решения. Показаны последние доступные данные."); }
      else setStatus("error");
      return false;
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, [commitBoard, requestedChannelId, syncChannelUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ clear: true }), 0);
    return () => {
      window.clearTimeout(timer);
      activeController.current?.abort(); mutationController.current?.abort(); stateController.current?.abort();
      feedbackController.current?.abort(); actionController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const handleProjectChange = () => {
      mutationController.current?.abort(); stateController.current?.abort(); feedbackController.current?.abort(); actionController.current?.abort();
      setBusy(null); setUndo(null); setItemErrors({}); setRefreshNotice(""); setQuickMode(false); setQuickCompleted(0);
      setAnnouncement("Проект изменён. Обновляем решения на сегодня.");
      void load({ clear: true, channelId: null });
    };
    window.addEventListener("aurora:project-changed", handleProjectChange);
    return () => window.removeEventListener("aurora:project-changed", handleProjectChange);
  }, [load]);

  useEffect(() => {
    if (!pendingFocus || status !== "ready") return;
    const frame = window.requestAnimationFrame(() => {
      if (pendingFocus === "summary") summaryRef.current?.focus();
      else (titleRefs.current.get(pendingFocus) ?? summaryRef.current)?.focus();
      setPendingFocus(null);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [board, pendingFocus, status]);

  const postState = useCallback(async (item: TodayItem, channelId: number, state: "active" | ItemState, signal: AbortSignal) => {
    const response = await fetch("/api/today/state", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, fingerprint: item.fingerprint, state }), signal,
    });
    if (!response.ok) throw new Error("state_unavailable");
  }, []);

  const changeState = useCallback(async (item: TodayItem, nextState: ItemState) => {
    if (busy) return;
    const current = boardRef.current;
    if (!current?.channelId) return;
    const channelId = current.channelId;
    const originalIndex = current.items.findIndex((candidate) => candidate.fingerprint === item.fingerprint);
    if (originalIndex < 0) return;
    const visible = orderedItems(current.items);
    const visibleIndex = visible.findIndex((candidate) => candidate.fingerprint === item.fingerprint);
    const next = visible[visibleIndex + 1] ?? visible[visibleIndex - 1];
    stateController.current?.abort();
    const controller = new AbortController(); stateController.current = controller;
    const sequence = ++stateSequence.current;
    setBusy(item.fingerprint); setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "" }));
    setPendingFocus(next?.fingerprint ?? "summary");
    commitBoard({
      ...current,
      items: current.items.filter((candidate) => candidate.fingerprint !== item.fingerprint),
      completedItems: nextState === "done"
        ? [completedItemForClient(item, new Date().toISOString()), ...current.completedItems.filter((candidate) => candidate.fingerprint !== item.fingerprint)]
        : current.completedItems,
    });
    setUndo({ kind: "state", item, channelId, state: nextState });
    if (quickMode) setQuickCompleted((value) => Math.min(quickTotal, value + 1));
    setAnnouncement(nextState === "done" ? `«${item.title}» отмечено готовым.` : `«${item.title}» отложено до завтра, 09:00.`);
    try {
      await postState(item, channelId, nextState, controller.signal);
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      void load({ channelId });
    } catch {
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      const latest = boardRef.current;
      if (latest?.channelId === channelId && !latest.items.some((candidate) => candidate.fingerprint === item.fingerprint)) {
        const restored = [...latest.items]; restored.splice(Math.min(originalIndex, restored.length), 0, item);
        commitBoard({
          ...latest,
          items: restored,
          completedItems: latest.completedItems.filter((candidate) => candidate.fingerprint !== item.fingerprint),
        });
        setPendingFocus(item.fingerprint);
      }
      setUndo((notice) => notice?.item.fingerprint === item.fingerprint ? null : notice);
      setItemErrors((errors) => ({ ...errors, [item.fingerprint]: nextState === "done"
        ? "Не удалось отметить решение готовым. Карточка возвращена — попробуйте ещё раз."
        : "Не удалось отложить решение. Карточка возвращена — попробуйте ещё раз." }));
      setAnnouncement(`Не удалось изменить «${item.title}». Карточка возвращена.`);
    } finally { if (sequence === stateSequence.current) setBusy(null); }
  }, [busy, commitBoard, load, postState, quickMode, quickTotal]);

  const restore = useCallback(async () => {
    if (!undo || busy) return;
    const notice = undo;
    if (notice.kind === "feedback") {
      feedbackController.current?.abort();
      const controller = new AbortController(); feedbackController.current = controller;
      const sequence = ++feedbackSequence.current;
      setBusy(`undo-feedback:${notice.item.fingerprint}`);
      try {
        const response = await fetch("/api/today/feedback", {
          method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
          body: JSON.stringify({ channelId: notice.channelId, recommendationKind: notice.recommendationKind, state: "active" }),
        });
        if (!response.ok) throw new Error("feedback_unavailable");
        if (controller.signal.aborted || sequence !== feedbackSequence.current) return;
        const current = boardRef.current;
        if (current?.channelId === notice.channelId) {
          commitBoard({ ...current, items: stableClientRank([...current.items, ...notice.hiddenItems]) });
          setPendingFocus(notice.item.fingerprint);
        }
        setUndo(null); setAnnouncement("Такие рекомендации снова будут появляться.");
        if (quickMode) setQuickCompleted((value) => Math.max(0, value - notice.hiddenItems.length));
        void load({ channelId: notice.channelId });
      } catch {
        if (controller.signal.aborted || sequence !== feedbackSequence.current) return;
        setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "Не удалось вернуть тип рекомендаций. Проверьте соединение и повторите." }));
      } finally { if (sequence === feedbackSequence.current) setBusy(null); }
      return;
    }
    stateController.current?.abort();
    const controller = new AbortController(); stateController.current = controller;
    const sequence = ++stateSequence.current;
    setBusy(`undo:${notice.item.fingerprint}`);
    try {
      await postState(notice.item, notice.channelId, "active", controller.signal);
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      setUndo(null); setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "" }));
      setAnnouncement(`«${notice.item.title}» снова в списке.`);
      if (quickMode) setQuickCompleted((value) => Math.max(0, value - 1));
      const current = boardRef.current;
      if (current?.channelId === notice.channelId && !current.items.some((item) => item.fingerprint === notice.item.fingerprint)) {
        commitBoard({
          ...current,
          items: [notice.item, ...current.items],
          completedItems: current.completedItems.filter((candidate) => candidate.fingerprint !== notice.item.fingerprint),
        });
        setPendingFocus(notice.item.fingerprint);
      }
      void load({ channelId: notice.channelId });
    } catch {
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "Не удалось вернуть решение. Проверьте соединение и повторите." }));
    } finally { if (sequence === stateSequence.current) setBusy(null); }
  }, [busy, commitBoard, load, postState, quickMode, undo]);

  const runPrimary = useCallback(async (item: TodayItem) => {
    if (busy) return;
    if (!item.smartAction) {
      router.push(item.primaryAction.href);
      return;
    }
    const current = boardRef.current;
    if (!current?.channelId) return;
    actionController.current?.abort();
    const controller = new AbortController(); actionController.current = controller;
    const sequence = ++actionSequence.current;
    setBusy(`action:${item.fingerprint}`);
    setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "" }));
    try {
      const response = await fetch("/api/today/action", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({
          channelId: current.channelId,
          fingerprint: item.fingerprint,
          actionKind: item.smartAction.kind,
        }),
      });
      const body = await response.json().catch(() => null) as { error?: unknown; href?: unknown } | null;
      const errorCode = typeof body?.error === "string" ? body.error : "action_unavailable";
      if (!response.ok) {
        const refreshable = new Set([
          "action_changed", "action_not_found", "action_source_unavailable",
          "opportunity_not_found", "opportunity_stale", "opportunity_not_actionable",
        ]).has(errorCode);
        if (refreshable) {
          const loaded = await load({ channelId: current.channelId });
          if (controller.signal.aborted || sequence !== actionSequence.current) return;
          const stillVisible = boardRef.current?.items.some((candidate) => candidate.fingerprint === item.fingerprint) === true;
          setPendingFocus(stillVisible ? item.fingerprint : "summary");
          if (loaded) {
            const sourceUnavailable = errorCode === "action_source_unavailable";
            const message = sourceUnavailable
              ? "Источник для быстрого черновика больше недоступен. Решение обновлено — откройте возможность, чтобы выбрать другой источник."
              : "Следующий шаг изменился. Решения обновлены — выберите актуальное действие.";
            if (stillVisible) setItemErrors((errors) => ({ ...errors, [item.fingerprint]: message }));
            else setRefreshError(message);
            setAnnouncement(message);
          } else {
            setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "Не удалось проверить актуальность решения. Обновите решения и повторите действие." }));
            setAnnouncement(`Не удалось обновить решение «${item.title}».`);
          }
          return;
        }
        throw new Error(errorCode);
      }
      if (typeof body?.href !== "string" || !body.href.startsWith("/app/studio?")) {
        throw new Error("action_unavailable");
      }
      if (controller.signal.aborted || sequence !== actionSequence.current) return;
      setAnnouncement(`Следующий шаг для «${item.title}» подготовлен. Карточка останется в списке, пока вы не отметите её готовой.`);
      router.push(body.href);
    } catch (error) {
      if (controller.signal.aborted || sequence !== actionSequence.current) return;
      const code = error instanceof Error ? error.message : "action_unavailable";
      const message = code === "access_denied"
        ? "У вас нет доступа к созданию материалов в этом проекте. Обратитесь к владельцу проекта."
        : code === "unauthorized"
          ? "Сессия завершилась. Обновите страницу и войдите снова."
          : "Не удалось подготовить следующий шаг. Проверьте соединение и повторите действие.";
      setItemErrors((errors) => ({ ...errors, [item.fingerprint]: message }));
      setAnnouncement(`Не удалось подготовить следующий шаг для «${item.title}».`);
    } finally { if (sequence === actionSequence.current) setBusy(null); }
  }, [busy, load, router]);

  const hideRecommendation = useCallback(async (item: TodayItem) => {
    if (busy || !item.recommendationKind) return;
    const current = boardRef.current;
    if (!current?.channelId) return;
    const recommendationKind = item.recommendationKind;
    const hiddenItems = current.items.filter((candidate) => candidate.recommendationKind === recommendationKind);
    if (hiddenItems.length === 0) return;
    const remaining = current.items.filter((candidate) => candidate.recommendationKind !== recommendationKind);
    const visible = orderedItems(current.items);
    const visibleIndex = visible.findIndex((candidate) => candidate.fingerprint === item.fingerprint);
    const next = visible.slice(visibleIndex + 1).find((candidate) => candidate.recommendationKind !== recommendationKind)
      ?? [...visible.slice(0, visibleIndex)].reverse().find((candidate) => candidate.recommendationKind !== recommendationKind);
    feedbackController.current?.abort();
    const controller = new AbortController(); feedbackController.current = controller;
    const sequence = ++feedbackSequence.current;
    setBusy(`feedback:${item.fingerprint}`);
    setPendingFocus(next?.fingerprint ?? "summary");
    commitBoard({ ...current, items: remaining });
    setUndo({ kind: "feedback", item, channelId: current.channelId, recommendationKind, hiddenItems });
    setAnnouncement(`Рекомендации типа «${ITEM_LABELS[item.type]}» больше не будут показываться.`);
    if (quickMode) setQuickCompleted((value) => Math.min(quickTotal, value + hiddenItems.length));
    try {
      const response = await fetch("/api/today/feedback", {
        method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ channelId: current.channelId, recommendationKind, state: "hidden" }),
      });
      if (!response.ok) throw new Error("feedback_unavailable");
      if (controller.signal.aborted || sequence !== feedbackSequence.current) return;
      void load({ channelId: current.channelId });
    } catch {
      if (controller.signal.aborted || sequence !== feedbackSequence.current) return;
      const latest = boardRef.current;
      if (latest?.channelId === current.channelId) commitBoard({ ...latest, items: stableClientRank([...latest.items, ...hiddenItems]) });
      setUndo(null); setPendingFocus(item.fingerprint);
      if (quickMode) setQuickCompleted((value) => Math.max(0, value - hiddenItems.length));
      setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "Не удалось скрыть тип рекомендаций. Карточка возвращена — попробуйте ещё раз." }));
      setAnnouncement("Не удалось сохранить предпочтение. Карточка возвращена.");
    } finally { if (sequence === feedbackSequence.current) setBusy(null); }
  }, [busy, commitBoard, load, quickMode, quickTotal]);

  const refreshSources = useCallback(async () => {
    if (busy) return;
    const current = boardRef.current;
    if (!current?.channelId) { void load(); return; }
    const previousItems = current.items.map((item) => item.fingerprint).join(":");
    const previousPulse = JSON.stringify(current.pulse);
    mutationController.current?.abort();
    const controller = new AbortController(); mutationController.current = controller;
    const sequence = ++mutationSequence.current; setRefreshing(true); setRefreshError(""); setRefreshNotice("");
    try {
      const response = await fetch("/api/today/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: current.channelId }), signal: controller.signal,
      });
      if (!response.ok) throw new Error("refresh_unavailable");
      const result = await response.json() as { availability?: string };
      if (controller.signal.aborted || sequence !== mutationSequence.current) return;
      const loaded = await load({ channelId: current.channelId });
      if (loaded) {
        const latest = boardRef.current;
        const changed = latest?.items.map((item) => item.fingerprint).join(":") !== previousItems
          || JSON.stringify(latest?.pulse) !== previousPulse;
        const message = result.availability === "unavailable"
          ? "Ни один источник не обновился. Показаны последние успешные данные."
          : result.availability === "partial"
            ? "Решения обновлены частично. Доступные источники показаны."
            : changed
              ? "Решения обновлены — новые данные уже в списке."
              : "Всё актуально — новых решений пока нет.";
        setRefreshNotice(message);
        setAnnouncement(message);
      }
    } catch {
      if (controller.signal.aborted || sequence !== mutationSequence.current) return;
      setRefreshNotice("");
      setRefreshError("Не удалось обновить источники. Последние успешные данные сохранены — повторите попытку.");
    } finally { if (sequence === mutationSequence.current) setRefreshing(false); }
  }, [busy, load]);

  const handleChannelChange = (value: string) => {
    const channelId = safeChannelId(value); if (channelId == null) return;
    mutationController.current?.abort(); stateController.current?.abort(); feedbackController.current?.abort(); actionController.current?.abort();
    setBusy(null); setUndo(null); setItemErrors({}); setRefreshNotice(""); setQuickMode(false); setQuickCompleted(0);
    const params = new URLSearchParams(searchString); params.set("channel", String(channelId));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const actionableItems = board?.items.filter((item) => item.type !== "onboarding") ?? [];
  const orderedActionableItems = orderedItems(actionableItems);
  const firstItem = orderedActionableItems[0];
  const firstFingerprint = firstItem?.fingerprint;
  const startQuickMode = () => {
    if (actionableItems.length === 0) return;
    setQuickMode(true); setQuickTotal(actionableItems.length); setQuickCompleted(0);
    setPendingFocus(firstFingerprint ?? "summary");
    setAnnouncement(`Начат быстрый разбор: ${actionableItems.length} ${plural(actionableItems.length, "решение", "решения", "решений")}.`);
  };
  const stopQuickMode = () => {
    setQuickMode(false); setQuickCompleted(0); setAnnouncement("Быстрый разбор завершён."); setPendingFocus("summary");
  };
  const problemSources = board ? [...new Map([
    ...board.partialErrors,
    ...board.sourceStatuses.filter((source) => source.status === "error"),
  ].map((source) => [source.source, { source: source.source, message: source.message }])).values()] : [];

  return (
    <AppShell title="Сегодня" subtitle="Приоритетные решения по выбранному каналу.">
      <div className="mx-auto w-full max-w-[68rem] space-y-6" aria-busy={refreshing}>
        <p className="sr-only" aria-live="polite" aria-atomic="true">{announcement}</p>
        {status === "loading" ? <TodayLoadingCard /> : null}

        {status === "error" ? (
          <Card className="border-danger/30 p-6" role="alert">
            <AlertTriangle className="h-6 w-6 text-danger-text" aria-hidden />
            <h2 className="mt-4">Не удалось собрать решения</h2>
            <p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">Ваши черновики и действия сохранены. Проверьте соединение и повторите загрузку.</p>
            <Button className="mt-4 min-h-11" onClick={() => void load({ clear: true })}>Повторить загрузку</Button>
          </Card>
        ) : null}

        {status === "ready" && board && board.readiness.state === "no_channel" ? (
          <Card className="p-6 sm:p-8">
            <Compass className="h-7 w-7 text-brand" aria-hidden />
            <h2 className="mt-4">Подключите канал</h2>
            <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">После подключения здесь появятся решения по контенту, публикациям и их результатам.</p>
            <Link className={buttonClassName({ className: "mt-5 min-h-11" })} href="/app/settings?section=channels">Подключить канал</Link>
          </Card>
        ) : null}

        {status === "ready" && board && !board.enabled ? (
          <Card className="p-6 sm:p-8">
            <ChannelSelector board={board} id="today-disabled-channel" onChange={handleChannelChange} />
            <h2 className="mt-5">Сегодня временно приостановлено</h2>
            <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Решения снова появятся здесь после восстановления сервиса. Пока можно продолжить работу с материалами в календаре.</p>
            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <Button variant="secondary" className="min-h-11" onClick={() => void load()}>Проверить снова</Button>
              <Link className={buttonClassName({ className: "min-h-11" })} href="/app/calendar">Открыть календарь</Link>
            </div>
          </Card>
        ) : null}

        {status === "ready" && board?.enabled && board.readiness.state !== "no_channel" ? (
          <>
            <Card className="p-4 sm:p-5">
              <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                <div className="min-w-0">
                  <ChannelSelector board={board} id="today-channel" onChange={handleChannelChange} />
                  <h2 ref={summaryRef} tabIndex={-1} className="mt-4 text-[15px] font-semibold text-text focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
                    {actionableItems.length} {plural(actionableItems.length, "решение", "решения", "решений")} в фокусе
                  </h2>
                  <p className="mt-1 type-caption tabular-nums text-text-3">{updatedLabel(board)}</p>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap lg:justify-end">
                  {firstItem?.smartAction ? (
                    <Button variant="primary" size="sm" className="h-auto min-h-11 whitespace-normal" disabled={busy !== null || refreshing} loading={busy === `action:${firstItem.fingerprint}`} onClick={() => void runPrimary(firstItem)}>
                      <Sparkles className="h-4 w-4 shrink-0" aria-hidden />Сделать следующий шаг
                    </Button>
                  ) : firstItem ? (
                    <Link className={buttonClassName({ variant: "primary", size: "sm", className: "h-auto min-h-11 whitespace-normal text-center" })} href={firstItem.primaryAction.href}>
                      <Sparkles className="h-4 w-4 shrink-0" aria-hidden />Сделать следующий шаг
                    </Link>
                  ) : null}
                  {actionableItems.length > 1 && !quickMode ? (
                    <Button variant="secondary" size="sm" className="h-auto min-h-11 whitespace-normal" disabled={busy !== null || refreshing} onClick={startQuickMode}>
                      <TimerReset className="h-4 w-4 shrink-0" aria-hidden />Разобрать за 5 минут
                    </Button>
                  ) : null}
                  <Button variant="secondary" size="sm" className="min-h-11" disabled={busy !== null} loading={refreshing} onClick={() => void refreshSources()}>
                    <RefreshCw className="h-4 w-4" aria-hidden />Обновить решения
                  </Button>
                </div>
              </div>
              {problemSources.length > 0 ? (
                <div className="mt-4 rounded-sm border border-fire/25 bg-fire-soft px-4 py-3" role="status">
                  <p className="text-[13px] font-semibold text-fire-text">Не все источники обновились</p>
                  <ul className="mt-2 space-y-1 text-[13px] text-text-2">
                    {problemSources.map((source) => (
                      <li key={source.source} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fire-text" aria-hidden /><span>{SOURCE_LABELS[source.source]}: {source.message}</span></li>
                    ))}
                  </ul>
                </div>
              ) : null}
            </Card>

            <TodaySummaryMetrics board={board} items={actionableItems} />

            <ChannelPulse pulse={board.pulse} channelId={board.channelId} refreshing={refreshing} onRefresh={() => void refreshSources()} />

            {refreshNotice ? <div role="status" className="rounded-sm border border-success/25 bg-success-soft px-4 py-3 text-[14px] text-success-text">{refreshNotice}</div> : null}
            {refreshError ? <div role="alert" className="rounded-sm border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] text-danger-text">{refreshError}</div> : null}

            {undo ? (
              <Card className="border-success/25 bg-success-soft p-4" role="status">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-success-text">
                      {undo.kind === "feedback" ? "Тип рекомендаций скрыт" : undo.state === "done" ? "Решение отмечено готовым" : "Напомним завтра в 09:00"}
                    </p>
                    <p className="mt-1 break-words text-[13px] text-text-2">{undo.item.title}</p>
                    {itemErrors[undo.item.fingerprint] ? <p className="mt-2 text-[13px] font-semibold text-danger-text" role="alert">{itemErrors[undo.item.fingerprint]}</p> : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                     <Button variant="secondary" size="sm" className="min-h-11" disabled={refreshing || busy === undo.item.fingerprint} loading={busy === `undo:${undo.item.fingerprint}` || busy === `undo-feedback:${undo.item.fingerprint}`} onClick={() => void restore()}><RotateCcw className="h-4 w-4" aria-hidden />Вернуть</Button>
                    <Button variant="ghost" size="sm" className="min-h-11" disabled={refreshing || busy !== null} onClick={() => setUndo(null)}>Скрыть сообщение</Button>
                  </div>
                </div>
              </Card>
            ) : null}

            {board.availability === "partial" && problemSources.length === 0 ? <div role="status" className="rounded-sm border border-fire/25 bg-fire-soft px-4 py-3 text-[14px] text-fire-text">Часть источников временно недоступна. Работающие решения остаются в списке.</div> : null}

            {board.availability === "unavailable" ? (
              <Card className="border-danger/30 p-6" role="alert">
                <AlertTriangle className="h-6 w-6 text-danger-text" aria-hidden />
                <h2 className="mt-4">Источники решений временно недоступны</h2>
                <p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">Последние успешные данные сохранены. Повторите обновление, когда соединение восстановится.</p>
                <Button className="mt-4 min-h-11" loading={refreshing} onClick={() => void refreshSources()}>Повторить обновление</Button>
              </Card>
            ) : null}

            {board.availability !== "unavailable" && actionableItems.length === 0 && !quickMode ? (
              <Card className="p-7 text-center sm:p-10">
                {board.readiness.state === "need_competitors" ? (
                  <><Compass className="mx-auto h-8 w-8 text-brand" aria-hidden /><h2 className="mt-4">Добавьте конкурентов</h2><p className="mx-auto mt-2 max-w-[55ch] text-pretty text-[15px] leading-relaxed text-text-2">Для поиска устойчивых возможностей нужны минимум два конкурента. Сейчас добавлено: {board.readiness.competitorCount}.</p><Link className={buttonClassName({ className: "mt-5 min-h-11" })} href="/app/competitors">Добавить конкурентов</Link></>
                ) : board.readiness.state === "need_posts" ? (
                  <><FileCheck2 className="mx-auto h-8 w-8 text-brand" aria-hidden /><h2 className="mt-4">Создайте первый материал</h2><p className="mx-auto mt-2 max-w-[55ch] text-pretty text-[15px] leading-relaxed text-text-2">После публикации здесь появятся решения по результатам и реакции аудитории.</p><Link className={buttonClassName({ className: "mt-5 min-h-11" })} href={`/app/composer?channel=${board.channelId ?? ""}&from=calendar`}>Создать первый материал</Link></>
                ) : board.readiness.state === "need_stats" ? (
                  <><Database className="mx-auto h-8 w-8 text-brand" aria-hidden /><h2 className="mt-4">Получите статистику публикаций</h2><p className="mx-auto mt-2 max-w-[55ch] text-pretty text-[15px] leading-relaxed text-text-2">Результаты появятся после получения просмотров и реакций от подключённого канала.</p><Link className={buttonClassName({ className: "mt-5 min-h-11" })} href="/app/settings?section=channels">Проверить подключение канала</Link></>
                ) : (
                  <><CheckCircle2 className="mx-auto h-8 w-8 text-success-text" aria-hidden /><h2 className="mt-4">На сегодня всё выполнено</h2><p className="mx-auto mt-2 max-w-[55ch] text-pretty text-[15px] leading-relaxed text-text-2">Готово сегодня: {board.summary.doneToday}. Отложено до завтра: {board.summary.snoozed}.</p><Link className={buttonClassName({ className: "mt-5 min-h-11" })} href="/app/calendar">Открыть календарь</Link></>
                )}
              </Card>
            ) : null}

            {quickMode ? (
              <section aria-labelledby="today-quick-title">
                <Card className="mb-4 p-4 sm:p-5">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                      <p className="type-caption font-semibold text-brand">Быстрый разбор</p>
                      <h2 id="today-quick-title" className="mt-1">Разобрать за 5 минут</h2>
                      <p className="mt-1 text-[14px] leading-relaxed text-text-2">
                        {firstItem
                          ? `Шаг ${Math.min(quickCompleted + 1, quickTotal)} из ${quickTotal}. Откройте действие, затем явно выберите «Готово», «Напомнить завтра» или скройте нерелевантный тип.`
                          : `Разобрано: ${quickCompleted} из ${quickTotal}.`}
                      </p>
                    </div>
                    <Button variant="ghost" size="sm" className="min-h-11" onClick={stopQuickMode}>Выйти из режима</Button>
                  </div>
                </Card>
                {firstItem ? (
                  <TodayItemCard
                    item={firstItem}
                    featured
                    actionsDisabled={busy !== null || refreshing}
                    actionLoading={busy === firstItem.fingerprint || busy === `action:${firstItem.fingerprint}`}
                    error={itemErrors[firstItem.fingerprint]}
                    setTitleRef={(element) => { if (element) titleRefs.current.set(firstItem.fingerprint, element); else titleRefs.current.delete(firstItem.fingerprint); }}
                    onPrimary={(candidate) => void runPrimary(candidate)}
                    onDone={(candidate) => void changeState(candidate, "done")}
                    onSnooze={(candidate) => void changeState(candidate, "snoozed")}
                    onHide={(candidate) => void hideRecommendation(candidate)}
                  />
                ) : (
                  <Card className="p-7 text-center sm:p-10" role="status">
                    <CheckCircle2 className="mx-auto h-8 w-8 text-success-text" aria-hidden />
                    <h3 className="mt-4">Быстрый разбор завершён</h3>
                    <p className="mx-auto mt-2 max-w-[55ch] text-[15px] leading-relaxed text-text-2">Все решения из этой сессии разобраны. Новые данные появятся после следующего обновления.</p>
                    <Button variant="secondary" className="mt-5" onClick={stopQuickMode}>Вернуться к сводке</Button>
                  </Card>
                )}
              </section>
            ) : null}

             {actionableItems.length > 0 && !quickMode ? (
              <div className="space-y-8">
                {GROUPS.map((group) => {
                  const items = board.items.filter((item) => group.types.includes(item.type));
                  if (items.length === 0) return null;
                  return (
                    <section key={group.key} aria-labelledby={`today-group-${group.key}`}>
                      <div className="mb-3"><h2 id={`today-group-${group.key}`}>{group.title}</h2><p className="mt-1 text-[14px] leading-relaxed text-text-3">{group.description}</p></div>
                      <ol className="space-y-4">
                        {items.map((item) => (
                          <li key={item.fingerprint}>
                             <TodayItemCard item={item} featured={item.fingerprint === firstFingerprint}
                              actionsDisabled={busy !== null || refreshing} actionLoading={busy === item.fingerprint || busy === `action:${item.fingerprint}`} error={itemErrors[item.fingerprint]}
                              setTitleRef={(element) => { if (element) titleRefs.current.set(item.fingerprint, element); else titleRefs.current.delete(item.fingerprint); }}
                              onPrimary={(candidate) => void runPrimary(candidate)}
                              onDone={(candidate) => void changeState(candidate, "done")} onSnooze={(candidate) => void changeState(candidate, "snoozed")}
                              onHide={(candidate) => void hideRecommendation(candidate)} />
                          </li>
                        ))}
                      </ol>
                    </section>
                  );
                })}
              </div>
            ) : null}

            {!quickMode ? <CompletedToday items={board.completedItems} timezone={board.timezone} /> : null}
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

export default function TodayPage() {
  return <Suspense fallback={<TodayPageFallback />}><TodayPageContent /></Suspense>;
}
