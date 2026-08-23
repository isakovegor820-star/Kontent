"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock3,
  Compass,
  Database,
  FileCheck2,
  Lightbulb,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type { TodayBoard, TodayItem, TodayItemType, TodaySource } from "@/lib/today";
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
type UndoNotice = { item: TodayItem; channelId: number; state: ItemState };

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

function TodayItemCard({ item, featured, actionsDisabled, actionLoading, error, setTitleRef, onDone, onSnooze }: {
  item: TodayItem;
  featured: boolean;
  actionsDisabled: boolean;
  actionLoading: boolean;
  error?: string;
  setTitleRef: (element: HTMLHeadingElement | null) => void;
  onDone: (item: TodayItem) => void;
  onSnooze: (item: TodayItem) => void;
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
            <Link className={buttonClassName({ variant: "primary", className: "min-h-11 whitespace-normal text-center" })} href={item.primaryAction.href}>
              {item.primaryAction.label}
            </Link>
            {item.evidence ? <EvidenceCard kind={item.evidence.kind} id={item.evidence.id} compact /> : null}
          </div>
          {error ? <p className="mt-4 text-[13px] font-semibold text-danger-text" role="alert">{error}</p> : null}
        </div>
        <div className="flex flex-col items-stretch gap-2 sm:flex-row lg:items-end">
          <Button variant="secondary" size="sm" className="min-h-11 w-full sm:w-auto" disabled={actionsDisabled} loading={actionLoading} onClick={() => onDone(item)}>
            <Check className="h-4 w-4" aria-hidden />Готово
          </Button>
          <Button variant="ghost" size="sm" className="min-h-11 w-full sm:w-auto" disabled={actionsDisabled} onClick={() => onSnooze(item)}>
            <Clock3 className="h-4 w-4" aria-hidden />Напомнить завтра
          </Button>
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
  const requestSequence = useRef(0);
  const mutationSequence = useRef(0);
  const stateSequence = useRef(0);
  const activeController = useRef<AbortController | null>(null);
  const mutationController = useRef<AbortController | null>(null);
  const stateController = useRef<AbortController | null>(null);
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
       const nextBoard = retained.length > 0
         ? { ...body, items: stableClientRank([...body.items, ...retained]) }
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
    };
  }, [load]);

  useEffect(() => {
    const handleProjectChange = () => {
      mutationController.current?.abort(); stateController.current?.abort(); setBusy(null); setUndo(null); setItemErrors({});
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
    setUndo({ item, channelId, state: nextState });
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
  }, [busy, commitBoard, load, postState]);

  const restore = useCallback(async () => {
    if (!undo || busy) return;
    const notice = undo;
    stateController.current?.abort();
    const controller = new AbortController(); stateController.current = controller;
    const sequence = ++stateSequence.current;
    setBusy(`undo:${notice.item.fingerprint}`);
    try {
      await postState(notice.item, notice.channelId, "active", controller.signal);
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      setUndo(null); setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "" }));
      setAnnouncement(`«${notice.item.title}» снова в списке.`);
      const current = boardRef.current;
      if (current?.channelId === notice.channelId && !current.items.some((item) => item.fingerprint === notice.item.fingerprint)) {
        commitBoard({ ...current, items: [notice.item, ...current.items] }); setPendingFocus(notice.item.fingerprint);
      }
      void load({ channelId: notice.channelId });
    } catch {
      if (controller.signal.aborted || sequence !== stateSequence.current) return;
      setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "Не удалось вернуть решение. Проверьте соединение и повторите." }));
    } finally { if (sequence === stateSequence.current) setBusy(null); }
  }, [busy, commitBoard, load, postState, undo]);

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
    mutationController.current?.abort(); stateController.current?.abort(); setBusy(null); setUndo(null); setItemErrors({});
    const params = new URLSearchParams(searchString); params.set("channel", String(channelId));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const actionableItems = board?.items.filter((item) => item.type !== "onboarding") ?? [];
  const firstFingerprint = orderedItems(board?.items ?? [])[0]?.fingerprint;
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
              <div className="flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  <ChannelSelector board={board} id="today-channel" onChange={handleChannelChange} />
                  <h2 ref={summaryRef} tabIndex={-1} className="mt-4 text-[15px] font-semibold text-text focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-brand">
                    {actionableItems.length} {plural(actionableItems.length, "решение", "решения", "решений")} в фокусе
                  </h2>
                  <p className="mt-1 type-caption tabular-nums text-text-3">{updatedLabel(board)}</p>
                </div>
                <Button variant="secondary" size="sm" className="min-h-11" disabled={busy !== null} loading={refreshing} onClick={() => void refreshSources()}>
                  <RefreshCw className="h-4 w-4" aria-hidden />Обновить решения
                </Button>
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

            {refreshError ? <div role="alert" className="rounded-sm border border-danger/25 bg-danger-soft px-4 py-3 text-[14px] text-danger-text">{refreshError}</div> : null}

            {undo ? (
              <Card className="border-success/25 bg-success-soft p-4" role="status">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-semibold text-success-text">{undo.state === "done" ? "Решение отмечено готовым" : "Напомним завтра в 09:00"}</p>
                    <p className="mt-1 break-words text-[13px] text-text-2">{undo.item.title}</p>
                    {itemErrors[undo.item.fingerprint] ? <p className="mt-2 text-[13px] font-semibold text-danger-text" role="alert">{itemErrors[undo.item.fingerprint]}</p> : null}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                     <Button variant="secondary" size="sm" className="min-h-11" disabled={refreshing || busy === undo.item.fingerprint} loading={busy === `undo:${undo.item.fingerprint}`} onClick={() => void restore()}><RotateCcw className="h-4 w-4" aria-hidden />Вернуть</Button>
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

            {board.availability !== "unavailable" && actionableItems.length === 0 ? (
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

             {actionableItems.length > 0 ? (
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
                              actionsDisabled={busy !== null || refreshing} actionLoading={busy === item.fingerprint} error={itemErrors[item.fingerprint]}
                              setTitleRef={(element) => { if (element) titleRefs.current.set(item.fingerprint, element); else titleRefs.current.delete(item.fingerprint); }}
                              onDone={(candidate) => void changeState(candidate, "done")} onSnooze={(candidate) => void changeState(candidate, "snoozed")} />
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
