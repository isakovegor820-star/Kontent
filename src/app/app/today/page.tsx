"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BarChart3,
  Check,
  CheckCircle2,
  Clock3,
  Compass,
  Database,
  EyeOff,
  FileCheck2,
  Lightbulb,
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
    return `Последнее успешное обновление: ${formatted}`;
  } catch {
    return "Последнее успешное обновление: недавно";
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

function ChannelPulse({ pulse, refreshing, onRefresh }: { pulse: TodayPulse; refreshing: boolean; onRefresh: () => void }) {
  if (pulse.state === "unavailable") {
    return (
      <Card as="section" className="p-5 sm:p-6" aria-labelledby="today-pulse-title">
        <div className="flex items-start gap-3">
          <BarChart3 className="mt-0.5 h-5 w-5 shrink-0 text-text-3" aria-hidden />
          <div className="min-w-0">
            <h2 id="today-pulse-title">Пульс канала за 7 дней</h2>
            <p className="mt-2 max-w-[65ch] text-[14px] leading-relaxed text-text-2">Статистика временно недоступна. Остальные решения можно продолжать разбирать.</p>
            <Button variant="secondary" size="sm" className="mt-4" loading={refreshing} onClick={onRefresh}>Обновить статистику</Button>
          </div>
        </div>
      </Card>
    );
  }
  if (pulse.state === "no_posts" || pulse.state === "no_stats") {
    return (
      <Card as="section" className="p-5 sm:p-6" aria-labelledby="today-pulse-title">
        <div className="flex items-start gap-3">
          <BarChart3 className="mt-0.5 h-5 w-5 shrink-0 text-brand" aria-hidden />
          <div className="min-w-0">
            <p className="type-caption font-semibold text-text-3">{pulse.periodLabel}</p>
            <h2 id="today-pulse-title" className="mt-1">Пульс канала за 7 дней</h2>
            <p className="mt-2 max-w-[65ch] text-[14px] leading-relaxed text-text-2">
              {pulse.state === "no_posts"
                ? "За последние 7 дней публикаций не было. После первой публикации здесь появится короткая динамика канала."
                : "Публикации есть, но статистика по ним ещё не получена. Исходные материалы остаются без изменений."}
            </p>
            {pulse.state === "no_posts" ? (
              <Link className={buttonClassName({ variant: "secondary", size: "sm", className: "mt-4" })} href="/app/composer">Создать материал</Link>
            ) : (
              <Button variant="secondary" size="sm" className="mt-4" loading={refreshing} onClick={onRefresh}>Обновить статистику</Button>
            )}
          </div>
        </div>
      </Card>
    );
  }
  const metrics = [
    { label: "Публикации", value: String(pulse.publishedCount), comparison: `${pulse.postsWithStats} со статистикой` },
    { label: "Просмотры", value: metric(pulse.views), comparison: comparisonLabel(pulse.comparison.viewsPerPostPercent) },
    { label: "Реакции", value: metric(pulse.reactions), comparison: comparisonLabel(pulse.comparison.reactionsPerPostPercent) },
    { label: "Доля реакций", value: pulse.engagementRate == null ? "—" : `${pulse.engagementRate.toLocaleString("ru-RU")}%`, comparison: comparisonLabel(pulse.comparison.engagementPoints, " п. п.") },
  ];
  return (
    <Card as="section" className="p-5 sm:p-6" aria-labelledby="today-pulse-title">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="type-caption font-semibold text-text-3">{pulse.periodLabel}</p>
          <h2 id="today-pulse-title" className="mt-1">Пульс канала за 7 дней</h2>
        </div>
        <Badge tone="neutral">Только реальные данные</Badge>
      </div>
      <dl className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        {metrics.map((entry) => (
          <div key={entry.label} className="min-w-0 rounded-sm bg-surface-inset p-3 sm:p-4">
            <dt className="type-caption text-text-3">{entry.label}</dt>
            <dd className="mt-1 text-xl font-bold leading-tight tabular-nums text-text sm:text-2xl">{entry.value}</dd>
            <dd className="mt-1 text-[12px] leading-relaxed text-text-3">{entry.comparison}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-5 grid gap-4 border-t border-line pt-4 lg:grid-cols-[minmax(0,1fr)_minmax(16rem,0.7fr)]">
        <div>
          <p className="type-caption font-semibold text-text-3">Что это значит</p>
          <p className="mt-1 max-w-[65ch] text-[14px] leading-relaxed text-text-2">{pulse.insight}</p>
        </div>
        {pulse.bestPost ? (
          <div className="min-w-0">
            <p className="type-caption font-semibold text-text-3">Лучший результат периода</p>
            <Link className="mt-1 inline-flex min-h-11 items-center break-words text-[14px] font-semibold leading-relaxed text-brand underline decoration-brand/35 underline-offset-4 hover:decoration-brand focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand" href={pulse.bestPost.href}>
              {pulse.bestPost.title}
            </Link>
          </div>
        ) : null}
      </div>
    </Card>
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
    <Card strong={featured} className="overflow-hidden">
      <div className="grid min-w-0 gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.type === "risk" ? "danger" : featured ? "brand" : "neutral"}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {ITEM_LABELS[item.type]}
            </Badge>
            <span className="type-caption break-words text-text-3">{item.channelLabel} · {item.freshness}</span>
          </div>
          <p className="mt-2 type-caption text-text-3">{CONFIDENCE_LABELS[item.confidence]} · {STATE_LABELS[item.epistemicState]}</p>
          <h3 ref={setTitleRef} tabIndex={-1} className="mt-4 text-balance focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">{item.title}</h3>
          <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">
            <span className="font-semibold text-text">Почему сейчас: </span>{item.whyNow}
          </p>
          <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-text-3">
            <Database className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span className="break-words">Источник данных: {item.sourceLabel}</span>
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
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
          {error ? <p className="mt-4 text-[13px] font-semibold text-danger-text" role="alert">{error}</p> : null}
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row lg:items-end">
          <Button variant="secondary" size="sm" className="min-h-11 w-full sm:w-auto" disabled={actionsDisabled} loading={!item.smartAction && actionLoading} onClick={() => onDone(item)}>
            <Check className="h-4 w-4" aria-hidden />Готово
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11 w-full sm:w-auto" disabled={actionsDisabled} onClick={() => onSnooze(item)}>
            <Clock3 className="h-4 w-4" aria-hidden />Напомнить завтра
          </Button>
          {item.recommendationKind ? (
            <Button variant="ghost" size="sm" className="min-h-11 w-full whitespace-normal text-left sm:w-auto" disabled={actionsDisabled} onClick={() => onHide(item)}>
              <EyeOff className="h-4 w-4 shrink-0" aria-hidden />Больше не показывать такое
            </Button>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

function ChannelSelector({ board, id, onChange }: { board: TodayBoard; id: string; onChange: (value: string) => void }) {
  if (board.channels.length <= 1) {
    return <div><p className="type-caption font-semibold text-text-2">Канал</p><p className="mt-1 break-words text-[15px] font-semibold text-text">{board.channelLabel}</p></div>;
  }
  return (
    <label className="block" htmlFor={id}>
      <span className="type-caption font-semibold text-text-2">Канал</span>
      <select
        id={id}
        value={board.channelId ?? ""}
        onChange={(event) => onChange(event.target.value)}
        className="mt-1.5 h-12 w-full min-w-0 rounded-xs border border-line bg-surface px-4 text-base font-semibold text-text transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:w-72 sm:text-sm"
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
       if (!response.ok || !body?.items || !Array.isArray(body.channels)) throw new Error("today_unavailable");
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
      setBusy(null); setUndo(null); setItemErrors({}); setQuickMode(false); setQuickCompleted(0);
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
    commitBoard({ ...current, items: current.items.filter((candidate) => candidate.fingerprint !== item.fingerprint) });
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
        commitBoard({ ...latest, items: restored }); setPendingFocus(item.fingerprint);
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
        commitBoard({ ...current, items: [notice.item, ...current.items] }); setPendingFocus(notice.item.fingerprint);
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
      const body = await response.json().catch(() => null) as { href?: unknown } | null;
      if (!response.ok || typeof body?.href !== "string" || !body.href.startsWith("/app/studio?")) {
        throw new Error("action_unavailable");
      }
      if (controller.signal.aborted || sequence !== actionSequence.current) return;
      setAnnouncement(`Следующий шаг для «${item.title}» подготовлен. Карточка останется в списке, пока вы не отметите её готовой.`);
      router.push(body.href);
    } catch {
      if (controller.signal.aborted || sequence !== actionSequence.current) return;
      setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "Не удалось подготовить следующий шаг. Исходные данные не изменены — попробуйте ещё раз." }));
      setAnnouncement(`Не удалось подготовить следующий шаг для «${item.title}».`);
    } finally { if (sequence === actionSequence.current) setBusy(null); }
  }, [busy, router]);

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
    mutationController.current?.abort();
    const controller = new AbortController(); mutationController.current = controller;
    const sequence = ++mutationSequence.current; setRefreshing(true); setRefreshError("");
    try {
      const response = await fetch("/api/today/refresh", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ channelId: current.channelId }), signal: controller.signal,
      });
      if (!response.ok) throw new Error("refresh_unavailable");
      const result = await response.json() as { availability?: string };
      if (controller.signal.aborted || sequence !== mutationSequence.current) return;
      const loaded = await load({ channelId: current.channelId });
      if (loaded) setAnnouncement(result.availability === "unavailable"
        ? "Ни один источник не обновился. Показаны последние успешные данные."
        : result.availability === "partial"
          ? "Решения обновлены частично. Доступные источники показаны."
          : "Решения обновлены.");
    } catch {
      if (controller.signal.aborted || sequence !== mutationSequence.current) return;
      setRefreshError("Не удалось обновить источники. Последние успешные данные сохранены — повторите попытку.");
    } finally { if (sequence === mutationSequence.current) setRefreshing(false); }
  }, [busy, load]);

  const handleChannelChange = (value: string) => {
    const channelId = safeChannelId(value); if (channelId == null) return;
    mutationController.current?.abort(); stateController.current?.abort(); feedbackController.current?.abort(); actionController.current?.abort();
    setBusy(null); setUndo(null); setItemErrors({}); setQuickMode(false); setQuickCompleted(0);
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

            <ChannelPulse pulse={board.pulse} refreshing={refreshing} onRefresh={() => void refreshSources()} />

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
          </>
        ) : null}
      </div>
    </AppShell>
  );
}

export default function TodayPage() {
  return <Suspense fallback={<TodayPageFallback />}><TodayPageContent /></Suspense>;
}
