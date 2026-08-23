"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  Clock3,
  Compass,
  FileCheck2,
  Lightbulb,
  RefreshCw,
  RotateCcw,
} from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type { TodayBoard, TodayItem, TodayItemType } from "@/lib/today";
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

const GROUPS: Array<{
  key: string;
  title: string;
  description: string;
  types: TodayItemType[];
}> = [
  {
    key: "decisions",
    title: "Требует решения",
    description: "Риски и черновики, которые ждут вашего действия.",
    types: ["risk", "review"],
  },
  {
    key: "opportunities",
    title: "Можно использовать",
    description: "Свежие темы с проверяемым основанием.",
    types: ["opportunity"],
  },
  {
    key: "results",
    title: "Стоит проверить",
    description: "Новые наблюдаемые результаты публикаций.",
    types: ["result"],
  },
];

type LoadStatus = "loading" | "ready" | "error";
type UndoNotice = { item: TodayItem; channelId: number };

function safeChannelId(value: string | null): number | null {
  const channelId = Number(value);
  return Number.isSafeInteger(channelId) && channelId > 0 ? channelId : null;
}

function updatedLabel(board: TodayBoard): string {
  try {
    return new Intl.DateTimeFormat("ru-RU", {
      timeZone: board.timezone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(board.updatedAt));
  } catch {
    return "только что";
  }
}

function orderedItems(items: TodayItem[]): TodayItem[] {
  const grouped = GROUPS.flatMap((group) => items.filter((item) => group.types.includes(item.type)));
  return [...grouped, ...items.filter((item) => item.type === "onboarding")];
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
    <AppShell
      title="Сегодня"
      subtitle="Короткий список решений по выбранному каналу с понятным основанием."
    >
      <div className="mx-auto w-full max-w-[68rem]">
        <TodayLoadingCard />
      </div>
    </AppShell>
  );
}

function TodayItemCard({
  item,
  featured,
  busy,
  error,
  setTitleRef,
  onSnooze,
}: {
  item: TodayItem;
  featured: boolean;
  busy: boolean;
  error?: string;
  setTitleRef: (element: HTMLHeadingElement | null) => void;
  onSnooze: (item: TodayItem) => void;
}) {
  const Icon = ICONS[item.type];
  return (
    <Card strong={featured} className="overflow-hidden">
      <div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={item.type === "risk" ? "danger" : featured ? "brand" : "neutral"}>
              <Icon className="h-3.5 w-3.5" aria-hidden />
              {ITEM_LABELS[item.type]}
            </Badge>
            <span className="type-caption text-text-3">
              {item.channelLabel} · {item.freshness}
            </span>
          </div>
          <p className="mt-2 type-caption text-text-3">
            {CONFIDENCE_LABELS[item.confidence]} · {STATE_LABELS[item.epistemicState]}
          </p>
          <h3
            ref={setTitleRef}
            tabIndex={-1}
            className="mt-4 text-balance focus:outline-none"
          >
            {item.title}
          </h3>
          <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">
            {item.whyNow}
          </p>
          <div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
            <Link
              className={buttonClassName({
                variant: "primary",
                className: "whitespace-normal text-center",
              })}
              href={item.primaryAction.href}
            >
              {item.primaryAction.label}
            </Link>
            {item.evidence ? (
              <EvidenceCard kind={item.evidence.kind} id={item.evidence.id} compact />
            ) : null}
          </div>
          {error ? (
            <p className="mt-4 text-[13px] font-semibold text-danger-text" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        {item.secondaryAction ? (
          <div className="flex items-start">
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              loading={busy}
              onClick={() => onSnooze(item)}
            >
              <Clock3 className="h-4 w-4" aria-hidden />
              {item.secondaryAction.label}
            </Button>
          </div>
        ) : null}
      </div>
    </Card>
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
  const activeController = useRef<AbortController | null>(null);
  const titleRefs = useRef(new Map<string, HTMLHeadingElement>());
  const summaryRef = useRef<HTMLHeadingElement>(null);

  const commitBoard = useCallback((next: TodayBoard) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  const syncChannelUrl = useCallback((channelId: number | null) => {
    const params = new URLSearchParams(searchString);
    if (channelId == null) params.delete("channel");
    else params.set("channel", String(channelId));
    const nextSearch = params.toString();
    if (nextSearch === searchString) return;
    router.replace(nextSearch ? `${pathname}?${nextSearch}` : pathname, { scroll: false });
  }, [pathname, router, searchString]);

  const load = useCallback(async ({
    clear = false,
    channelId = requestedChannelId,
  }: {
    clear?: boolean;
    channelId?: number | null;
  } = {}): Promise<boolean> => {
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const sequence = ++requestSequence.current;
    if (clear) {
      boardRef.current = null;
      setBoard(null);
      setStatus("loading");
    } else if (boardRef.current) {
      setRefreshing(true);
    } else {
      setStatus("loading");
    }
    setRefreshError("");
    try {
      const query = channelId == null ? "" : `?channel=${channelId}`;
      const response = await fetch(`/api/today${query}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const body = await response.json().catch(() => null) as TodayBoard | null;
      if (!response.ok || !body?.items || !Array.isArray(body.channels)) {
        throw new Error("today_unavailable");
      }
      if (controller.signal.aborted || sequence !== requestSequence.current) return false;
      commitBoard(body);
      setStatus("ready");
      syncChannelUrl(body.channelId);
      return true;
    } catch {
      if (controller.signal.aborted || sequence !== requestSequence.current) return false;
      if (boardRef.current) {
        setStatus("ready");
        setRefreshError("Не удалось обновить список. Показаны последние загруженные данные.");
      } else {
        setStatus("error");
      }
      return false;
    } finally {
      if (sequence === requestSequence.current) setRefreshing(false);
    }
  }, [commitBoard, requestedChannelId, syncChannelUrl]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load({ clear: true }), 0);
    return () => {
      window.clearTimeout(timer);
      activeController.current?.abort();
    };
  }, [load]);

  useEffect(() => {
    const handleProjectChange = () => {
      setUndo(null);
      setItemErrors({});
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

  const postState = useCallback(async (
    item: TodayItem,
    channelId: number,
    state: "active" | "snoozed",
  ) => {
    const response = await fetch("/api/today/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId, fingerprint: item.fingerprint, state }),
    });
    if (!response.ok) throw new Error("state_unavailable");
  }, []);

  const snooze = useCallback(async (item: TodayItem) => {
    const current = boardRef.current;
    if (!current?.channelId) return;
    const channelId = current.channelId;
    setBusy(item.fingerprint);
    setItemErrors((errors) => ({ ...errors, [item.fingerprint]: "" }));
    try {
      await postState(item, channelId, "snoozed");
      const visible = orderedItems(current.items);
      const index = visible.findIndex((candidate) => candidate.fingerprint === item.fingerprint);
      const next = visible[index + 1] ?? visible[index - 1];
      setPendingFocus(next?.fingerprint ?? "summary");
      commitBoard({ ...current, items: current.items.filter((candidate) => candidate.fingerprint !== item.fingerprint) });
      setUndo({ item, channelId });
      setAnnouncement(`«${item.title}» отложено до завтра, 09:00.`);
      void load();
    } catch {
      setItemErrors((errors) => ({
        ...errors,
        [item.fingerprint]: "Не удалось отложить решение. Попробуйте ещё раз.",
      }));
    } finally {
      setBusy(null);
    }
  }, [commitBoard, load, postState]);

  const restore = useCallback(async () => {
    if (!undo) return;
    const notice = undo;
    setBusy(`undo:${notice.item.fingerprint}`);
    try {
      await postState(notice.item, notice.channelId, "active");
      setUndo(null);
      setItemErrors((errors) => ({ ...errors, [notice.item.fingerprint]: "" }));
      setAnnouncement(`«${notice.item.title}» снова в списке.`);
      const current = boardRef.current;
      if (current && !current.items.some((item) => item.fingerprint === notice.item.fingerprint)) {
        commitBoard({ ...current, items: [notice.item, ...current.items] });
      }
      setPendingFocus(notice.item.fingerprint);
      void load({ channelId: notice.channelId });
    } catch {
      setItemErrors((errors) => ({
        ...errors,
        [notice.item.fingerprint]: "Не удалось вернуть решение. Попробуйте ещё раз.",
      }));
    } finally {
      setBusy(null);
    }
  }, [commitBoard, load, postState, undo]);

  const handleChannelChange = (value: string) => {
    const channelId = safeChannelId(value);
    if (channelId == null) return;
    setUndo(null);
    const params = new URLSearchParams(searchString);
    params.set("channel", String(channelId));
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const actionableItems = board?.items.filter((item) => item.type !== "onboarding") ?? [];
  const firstFingerprint = orderedItems(board?.items ?? [])[0]?.fingerprint;
  const onboardingItem = board?.items.find((item) => item.type === "onboarding") ?? null;

  return (
    <AppShell
      title="Сегодня"
      subtitle="Короткий список решений по выбранному каналу с понятным основанием."
    >
      <div className="mx-auto w-full max-w-[68rem] space-y-6">
        <p className="sr-only" aria-live="polite" aria-atomic="true">
          {announcement}
        </p>

        {status === "loading" ? <TodayLoadingCard /> : null}

        {status === "error" ? (
          <Card className="border-danger/30 p-6" role="alert">
            <AlertTriangle className="h-6 w-6 text-danger-text" aria-hidden />
            <h2 className="mt-4">Не удалось собрать решения</h2>
            <p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">
              Черновики и действия сохранены. Проверьте соединение и повторите загрузку.
            </p>
            <Button className="mt-4" onClick={() => void load({ clear: true })}>
              Повторить загрузку
            </Button>
          </Card>
        ) : null}

        {status === "ready" && board && !board.enabled ? (
          <Card className="p-6">
            {board.channels.length > 1 ? (
              <label className="mb-5 block max-w-sm" htmlFor="today-disabled-channel">
                <span className="type-caption font-semibold text-text-2">Канал</span>
                <select
                  id="today-disabled-channel"
                  value={board.channelId ?? ""}
                  onChange={(event) => handleChannelChange(event.target.value)}
                  className="mt-1.5 h-12 w-full rounded-xs border border-line bg-surface px-4 text-base font-semibold text-text transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:text-sm"
                >
                  {board.channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.label}{channel.enabled ? "" : " — недоступен"}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <h2>Раздел пока недоступен для этого канала</h2>
            <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">
              {board.channels.some((channel) => channel.enabled)
                ? "Выберите другой канал или продолжите работу в календаре."
                : "Планировать и редактировать публикации по-прежнему можно в календаре."}
            </p>
            <Link className={buttonClassName({ className: "mt-5" })} href="/app/calendar">
              Открыть календарь
            </Link>
          </Card>
        ) : null}

        {status === "ready" && board?.enabled ? (
          <>
            <Card className="p-4 sm:p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
                <div className="min-w-0">
                  {board.channels.length > 1 ? (
                    <label className="block" htmlFor="today-channel">
                      <span className="type-caption font-semibold text-text-2">Канал</span>
                      <select
                        id="today-channel"
                        value={board.channelId ?? ""}
                        onChange={(event) => handleChannelChange(event.target.value)}
                        className="mt-1.5 h-12 w-full min-w-0 rounded-xs border border-line bg-surface px-4 text-base font-semibold text-text transition-colors hover:border-line-strong focus:border-brand focus:outline-none focus-visible:ring-4 focus-visible:ring-brand/15 sm:w-72 sm:text-sm"
                      >
                        {board.channels.map((channel) => (
                          <option key={channel.id} value={channel.id}>
                            {channel.label}{channel.enabled ? "" : " — недоступен"}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <>
                      <p className="type-caption font-semibold text-text-2">Канал</p>
                      <p className="mt-1 text-[15px] font-semibold text-text">{board.channelLabel}</p>
                    </>
                  )}
                  <h2
                    ref={summaryRef}
                    tabIndex={-1}
                    className="mt-3 text-[15px] font-semibold text-text focus:outline-none"
                  >
                    {actionableItems.length} {plural(actionableItems.length, "решение", "решения", "решений")} в фокусе
                  </h2>
                  <p className="mt-1 type-caption text-text-3">
                    Обновлено в {updatedLabel(board)} по времени проекта
                  </p>
                </div>
                <Button
                  variant="secondary"
                  size="sm"
                  loading={refreshing}
                  onClick={() => void load()}
                >
                  <RefreshCw className="h-4 w-4" aria-hidden />
                  Обновить
                </Button>
              </div>
            </Card>

            {refreshError ? (
              <div
                role="status"
                className="rounded-sm border border-fire/25 bg-fire-soft px-4 py-3 text-[14px] text-fire-text"
              >
                {refreshError}
              </div>
            ) : null}

            {undo ? (
              <Card className="border-success/25 bg-success-soft p-4" role="status">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="font-semibold text-success-text">Напомним завтра в 09:00</p>
                    <p className="mt-1 text-[13px] text-text-2">{undo.item.title}</p>
                    {itemErrors[undo.item.fingerprint] ? (
                      <p className="mt-2 text-[13px] font-semibold text-danger-text" role="alert">
                        {itemErrors[undo.item.fingerprint]}
                      </p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      loading={busy === `undo:${undo.item.fingerprint}`}
                      onClick={() => void restore()}
                    >
                      <RotateCcw className="h-4 w-4" aria-hidden />
                      Вернуть
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setUndo(null)}>
                      Скрыть сообщение
                    </Button>
                  </div>
                </div>
              </Card>
            ) : null}

            {board.availability === "partial" ? (
              <div
                role="status"
                className="rounded-sm border border-fire/25 bg-fire-soft px-4 py-3 text-[14px] text-fire-text"
              >
                Часть данных временно недоступна. Показаны решения из работающих источников.
              </div>
            ) : null}

            {board.availability === "unavailable" ? (
              <Card className="border-danger/30 p-6" role="alert">
                <AlertTriangle className="h-6 w-6 text-danger-text" aria-hidden />
                <h2 className="mt-4">Источники решений временно недоступны</h2>
                <p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">
                  Мы не подменяем ошибку пустым списком. Повторите запрос — ваши данные сохранены.
                </p>
                <Button className="mt-4" onClick={() => void load()}>
                  Повторить запрос
                </Button>
              </Card>
            ) : null}

            {board.availability !== "unavailable" && onboardingItem ? (
              <section aria-labelledby="today-start-title">
                <h2 id="today-start-title" className="sr-only">Начало работы</h2>
                <TodayItemCard
                  item={onboardingItem}
                  featured
                  busy={false}
                  setTitleRef={(element) => {
                    if (element) titleRefs.current.set(onboardingItem.fingerprint, element);
                    else titleRefs.current.delete(onboardingItem.fingerprint);
                  }}
                  onSnooze={snooze}
                />
              </section>
            ) : null}

            {board.availability !== "unavailable" && !onboardingItem && actionableItems.length === 0 ? (
              <Card className="p-7 text-center sm:p-10">
                <CheckCircle2 className="mx-auto h-8 w-8 text-success-text" aria-hidden />
                <h2 className="mt-4">На сегодня новых решений нет</h2>
                <p className="mx-auto mt-2 max-w-[55ch] text-pretty text-[15px] leading-relaxed text-text-2">
                  Здесь появятся свежие риски, возможности и результаты по выбранному каналу.
                </p>
                <div className="mt-5 flex flex-col justify-center gap-3 sm:flex-row">
                  <Button variant="primary" onClick={() => void load()}>Проверить ещё раз</Button>
                  <Link className={buttonClassName()} href="/app/calendar">Открыть календарь</Link>
                </div>
              </Card>
            ) : null}

            {board.availability !== "unavailable" && actionableItems.length > 0 ? (
              <div className="space-y-8">
                {GROUPS.map((group) => {
                  const items = board.items.filter((item) => group.types.includes(item.type));
                  if (items.length === 0) return null;
                  return (
                    <section key={group.key} aria-labelledby={`today-group-${group.key}`}>
                      <div className="mb-3">
                        <h2 id={`today-group-${group.key}`}>{group.title}</h2>
                        <p className="mt-1 text-[14px] text-text-3">{group.description}</p>
                      </div>
                      <ol className="space-y-4">
                        {items.map((item) => (
                          <li key={item.fingerprint}>
                            <TodayItemCard
                              item={item}
                              featured={item.fingerprint === firstFingerprint}
                              busy={busy === item.fingerprint}
                              error={itemErrors[item.fingerprint]}
                              setTitleRef={(element) => {
                                if (element) titleRefs.current.set(item.fingerprint, element);
                                else titleRefs.current.delete(item.fingerprint);
                              }}
                              onSnooze={snooze}
                            />
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
  return (
    <Suspense fallback={<TodayPageFallback />}>
      <TodayPageContent />
    </Suspense>
  );
}
