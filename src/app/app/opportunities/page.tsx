"use client";
import { useProjectFetch } from "@/lib/use-project-transport";


import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Grid2X2, Info, List, RefreshCw, Sparkles } from "lucide-react";

import { ChannelPicker, channelName, useChannelChoice } from "@/components/app/channel-picker";
import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type { OpportunitySnapshot } from "@/lib/content-intelligence";
import {
  classifyOpportunityFailure,
  opportunityActionError,
  type OpportunityPageStatus,
} from "@/lib/opportunities-client-state";
import { useStore } from "@/lib/store";
import { cn } from "@/lib/utils";

const confidenceLabel = { low: "Низкая уверенность", medium: "Средняя уверенность", high: "Высокая уверенность" } as const;

function safeChannelId(value: string | null): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function opportunityCountLabel(count: number): string {
  const lastTwo = count % 100;
  const last = count % 10;
  if (lastTwo >= 11 && lastTwo <= 14) return `${count} актуальных возможностей`;
  if (last === 1) return `${count} актуальная возможность`;
  if (last >= 2 && last <= 4) return `${count} актуальные возможности`;
  return `${count} актуальных возможностей`;
}

function OpportunityDetails({ item, creating, onCreate, className, titleId }: {
  item: OpportunitySnapshot;
  creating: boolean;
  onCreate: (item: OpportunitySnapshot) => void;
  className?: string;
  titleId: string;
}) {
  return (
    <Card strong className={cn("overflow-hidden", className)}>
      <div className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Badge tone={item.epistemicState === "inferred" ? "brand" : "neutral"}>{item.epistemicState === "inferred" ? "Объяснимый вывод" : "Данных мало"}</Badge>
          <span className="type-caption text-text-3">{item.channelLabel}</span>
        </div>
        <h2 id={titleId} className="mt-4 text-balance text-[22px] leading-tight tracking-tight">{item.title}</h2>
        <p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{item.angle}</p>
        <dl className="mt-5 grid grid-cols-3 gap-2 sm:gap-3">
          <div className="min-w-0 rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Спрос</dt><dd className="mt-1 font-semibold tabular-nums">{item.demand} из 4</dd></div>
          <div className="min-w-0 rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Покрытие</dt><dd className="mt-1 font-semibold tabular-nums">{item.coverage} из 4</dd></div>
          <div className="min-w-0 rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Выборка</dt><dd className="mt-1 break-words font-semibold tabular-nums">{item.sampleSize ?? "Мало данных"}</dd></div>
        </dl>
        <div className="mt-6 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
          <Button variant="primary" className="w-full sm:w-auto" disabled={!item.actionable} loading={creating} onClick={() => onCreate(item)}><Sparkles className="h-4 w-4" aria-hidden />Создать черновик</Button>
          <EvidenceCard kind="opportunity" id={item.id} label="Проверить основания" />
        </div>
        {!item.actionable && <p className="mt-3 flex items-start gap-2 text-[13px] leading-relaxed text-fire-text"><Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />Для черновика пока недостаточно подтверждённых данных.</p>}
      </div>
      <details className="group border-t border-line px-5 sm:px-6">
        <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 font-semibold text-text focus-visible:rounded-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand"><span>Источник и методика</span><ChevronDown className="h-4 w-4 shrink-0 transition-transform duration-150 group-open:rotate-180 motion-reduce:transition-none" aria-hidden /></summary>
        <div className="space-y-3 pb-6 text-[14px] leading-relaxed text-text-2">
          <p><span className="font-semibold text-text">Источник:</span> {item.sourceType}{item.sourceLabel ? ` · ${item.sourceLabel}` : ""}</p>
          <p><span className="font-semibold text-text">Актуальность:</span> {item.freshnessLabel}</p>
          <p><span className="font-semibold text-text">Методика:</span> {item.methodology}</p>
          <p className="type-caption tabular-nums text-text-3">Версия расчёта: {item.formulaVersion}</p>
        </div>
      </details>
    </Card>
  );
}

export default function OpportunitiesPage() {
  const fetch = useProjectFetch();
  const store = useStore();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const searchString = searchParams.toString();
  const requestedChannelId = safeChannelId(searchParams.get("channel"));
  const { tgChannels, channelId } = useChannelChoice(store.realChannels, requestedChannelId);
  const [items, setItems] = useState<OpportunitySnapshot[]>([]);
  const [status, setStatus] = useState<OpportunityPageStatus>("loading");
  const [operationError, setOperationError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false);
  const [creatingId, setCreatingId] = useState<number | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const requested = Number(searchParams.get("opportunity"));
  const [selectedId, setSelectedId] = useState<number | null>(Number.isSafeInteger(requested) && requested > 0 ? requested : null);
  const endpoint = channelId ? `/api/opportunities?channel=${channelId}` : null;

  const handleChannelChange = (nextChannelId: number) => {
    const params = new URLSearchParams(searchString);
    params.set("channel", String(nextChannelId));
    params.delete("opportunity");
    setItems([]);
    setSelectedId(null);
    setStatus("loading");
    setOperationError(undefined);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  };

  const load = useCallback(async (signal?: AbortSignal) => {
    setOperationError(undefined);
    if (!store.realReady) return;
    if (!endpoint) {
      setItems([]);
      setSelectedId(null);
      setStatus("no_channel");
      return;
    }
    try {
      const response = await fetch(endpoint, { cache: "no-store", signal });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities) || body.opportunities.some((item) => item.channelId !== channelId)) {
        setItems([]);
        setSelectedId(null);
        setStatus(classifyOpportunityFailure(response.status, body?.error));
        return;
      }
      setItems(body.opportunities);
      setSelectedId((current) => current && body.opportunities!.some((item) => item.id === current) ? current : body.opportunities![0]?.id ?? null);
      setStatus("ready");
    } catch {
      if (signal?.aborted) return;
      setItems([]);
      setSelectedId(null);
      setStatus("initial_error");
    }
  }, [channelId, endpoint, fetch, store.realReady]);
  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setTimeout(() => void load(controller.signal), 0);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [load]);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  const refresh = async () => {
    if (!endpoint) return;
    setRefreshing(true);
    setOperationError(undefined);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities) || body.opportunities.some((item) => item.channelId !== channelId)) {
        const failure = classifyOpportunityFailure(response.status, body?.error);
        if (failure === "initial_error" && items.length > 0) {
          setOperationError("Не удалось обновить карту. Показаны ранее загруженные данные.");
        } else {
          setItems([]);
          setSelectedId(null);
          setStatus(failure);
        }
        return;
      }
      setItems(body.opportunities);
      setSelectedId(body.opportunities[0]?.id ?? null);
      setStatus("ready");
    } catch {
      if (items.length > 0) {
        setOperationError("Не удалось обновить карту. Показаны ранее загруженные данные.");
      } else setStatus("initial_error");
    } finally {
      setRefreshing(false);
    }
  };
  const create = async (item: OpportunitySnapshot) => {
    if (item.actionHref) { router.push(item.actionHref); return; }
    setCreatingId(item.id);
    setOperationError(undefined);
    try {
      const response = await fetch(`/api/opportunities/${item.id}/draft`, { method: "POST" });
      const body = await response.json().catch(() => null) as { draftId?: number; error?: string } | null;
      if (!response.ok || !body?.draftId) {
        setOperationError(opportunityActionError(body?.error));
        return;
      }
      router.push(`/app/studio?draft=${body.draftId}&intent=create`);
    } catch {
      setOperationError("Сеть недоступна. Проверьте соединение и повторите создание черновика.");
    } finally {
      setCreatingId(null);
    }
  };

  const activeChannel = tgChannels.find((item) => item.id === channelId) ?? null;

  return <AppShell title="Карта возможностей" subtitle="Свежие темы, где у канала есть место для собственного голоса." action={status === "ready" ? <Button data-aurora-feature="map" data-aurora-action="built" onClick={() => void refresh()} loading={refreshing}><RefreshCw className="h-4 w-4" aria-hidden />Обновить карту</Button> : undefined}>
    <div className="mx-auto w-full max-w-[76rem] space-y-5">
      {status === "loading" && <Card className="min-h-64 p-6" role="status" aria-busy="true"><div className="skeleton h-7 w-56 rounded-xs" /><div className="mt-5 grid gap-4 lg:grid-cols-2"><div className="skeleton h-52 rounded-md" /><div className="skeleton h-52 rounded-md" /></div><span className="sr-only">Загружаем возможности выбранного канала</span></Card>}
      {status === "no_channel" && <Card className="p-6"><h2>Подключите канал</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Аврора построит карту возможностей после подключения активного канала.</p><Link className={buttonClassName({ variant: "primary", className: "mt-5" })} href="/app/settings?section=channels">Подключить канал</Link></Card>}
      {status === "feature_disabled" && <Card className="p-6"><h2>Карта пока не включена для этого канала</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Выберите другой канал или вернитесь позже.</p><ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} className="mt-5" /></Card>}
      {status === "access_denied" && <Card className="border-danger/30 p-6" role="alert"><h2>Нет доступа к карте</h2><p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">Попросите владельца проекта проверить вашу роль.</p><Link className={buttonClassName({ className: "mt-4" })} href="/app/calendar">Вернуться в календарь</Link></Card>}
      {status === "session_expired" && <Card className="border-danger/30 p-6" role="alert"><h2>Сессия завершилась</h2><p className="mt-2 text-[15px] text-text-2">Войдите снова, чтобы открыть карту возможностей.</p><Link className={buttonClassName({ variant: "primary", className: "mt-4" })} href="/login">Войти снова</Link></Card>}
      {status === "initial_error" && <Card className="border-danger/30 p-6" role="alert"><h2>Не удалось загрузить карту</h2><p className="mt-2 text-[15px] text-text-2">Проверьте соединение и повторите загрузку.</p><Button variant="primary" className="mt-4" onClick={() => { setStatus("loading"); void load(); }}>Повторить загрузку</Button></Card>}
      {status === "ready" && operationError && <Card className="border-danger/30 p-4" role="alert"><p className="text-[14px] leading-relaxed text-text-2">{operationError}</p><Button variant="ghost" size="sm" className="mt-2" onClick={() => setOperationError(undefined)}>Закрыть сообщение</Button></Card>}

      {status === "ready" && <Card className="p-4 sm:p-5"><div className="flex flex-col gap-5 md:flex-row md:items-end md:justify-between"><div className="min-w-0">{tgChannels.length > 1 ? <ChannelPicker channels={tgChannels} value={channelId} onChange={handleChannelChange} /> : activeChannel ? <><p className="type-caption text-text-3">Канал</p><p className="mt-1 font-semibold text-text">{channelName(activeChannel)}</p></> : null}<p className="mt-3 text-[14px] text-text-2" role="status">{opportunityCountLabel(items.length)}</p></div>{items.length > 0 && <div className="hidden shrink-0 rounded-sm bg-surface-inset p-1 md:inline-flex" role="group" aria-label="Представление карты"><Button variant={view === "list" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "list"} onClick={() => setView("list")}><List className="h-4 w-4" aria-hidden />Список</Button><Button variant={view === "map" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "map"} onClick={() => setView("map")}><Grid2X2 className="h-4 w-4" aria-hidden />Матрица</Button></div>}</div></Card>}

      {status === "ready" && items.length === 0 && <Card className="p-6"><h2>Свежих возможностей пока нет</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Просроченные темы скрыты. Добавьте минимум двух конкурентов для этого канала и обновите карту.</p><Link className="mt-5 inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-4" href={`/app/competitors${channelId ? `?channel=${channelId}` : ""}`}>Настроить конкурентов канала</Link></Card>}

      {status === "ready" && items.length > 0 && view === "map" && <div className="hidden gap-5 md:grid lg:grid-cols-[minmax(0,1fr)_minmax(24rem,1fr)]"><section aria-labelledby="opportunity-map-title"><Card className="p-5 sm:p-6"><h2 id="opportunity-map-title">Спрос и покрытие канала</h2><p className="mt-2 text-pretty text-[14px] leading-relaxed text-text-2">Выше — спрос сильнее. Правее — тема уже чаще встречалась в выбранном канале.</p><div className="relative mt-6 h-80 rounded-sm bg-surface-inset p-6" role="group" aria-label="Матрица возможностей"><span className="absolute bottom-2 left-1/2 -translate-x-1/2 type-caption text-text-3">Покрытие канала →</span><span className="absolute left-2 top-1/2 -rotate-90 type-caption text-text-3">Спрос →</span>{items.map((item, index) => <button key={item.id} type="button" aria-label={`${item.title}. Спрос ${item.demand} из 4, покрытие ${item.coverage} из 4, ${confidenceLabel[item.confidence]}`} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)} style={{ insetInlineStart: `${12 + item.coverage * 18}%`, bottom: `${12 + item.demand * 17}%`, width: `${Math.min(56, 34 + (item.sampleSize ?? 1) * 3)}px`, height: `${Math.min(56, 34 + (item.sampleSize ?? 1) * 3)}px` }} className={cn("absolute grid min-h-11 min-w-11 place-items-center rounded-full border-2 font-semibold tabular-nums transition-[transform,background-color,border-color] motion-reduce:transition-none", selectedId === item.id ? "scale-110 border-brand bg-brand text-white" : "border-line-strong bg-surface text-text hover:border-brand")}>{index + 1}</button>)}</div></Card></section>{selected && <aside aria-labelledby="opportunity-map-detail-title" className="self-start lg:sticky lg:top-6"><OpportunityDetails item={selected} creating={creatingId === selected.id} onCreate={(item) => void create(item)} titleId="opportunity-map-detail-title" /></aside>}</div>}

      {status === "ready" && items.length > 0 && <div className={cn("grid items-start gap-5 lg:grid-cols-[minmax(18rem,0.95fr)_minmax(24rem,1.05fr)]", view === "map" && "md:hidden")}><section aria-labelledby="opportunity-list-title"><h2 id="opportunity-list-title" className="sr-only">Приоритетный список</h2><ul className="space-y-3">{items.map((item, index) => { const isSelected = selectedId === item.id; return <li key={item.id} className="space-y-3"><button type="button" onClick={() => setSelectedId(item.id)} aria-pressed={isSelected} className={cn("w-full rounded-md bg-surface/75 p-4 text-start shadow-soft transition-[background-color,box-shadow,transform] motion-reduce:transition-none active:scale-[0.96] sm:p-5", isSelected ? "bg-surface ring-2 ring-brand" : "hover:bg-surface")}><div className="flex flex-wrap items-center gap-2"><Badge tone={index === 0 ? "brand" : "neutral"}>{index === 0 ? "Приоритет" : `№ ${index + 1}`}</Badge><Badge tone={item.confidence === "high" ? "success" : item.confidence === "medium" ? "fire" : "neutral"}>{confidenceLabel[item.confidence]}</Badge></div><h3 className="mt-3 text-balance text-[17px] leading-snug">{item.title}</h3><p className="mt-2 text-[13px] leading-relaxed text-text-2">{item.freshnessLabel} · {item.channelLabel}</p><span className="mt-3 inline-flex items-center gap-1.5 text-[13px] font-semibold text-brand lg:hidden">{isSelected ? "Подробности открыты" : "Развернуть подробности"}<ChevronDown className={cn("h-4 w-4 transition-transform duration-150 motion-reduce:transition-none", isSelected && "rotate-180")} aria-hidden /></span></button>{isSelected && <OpportunityDetails item={item} creating={creatingId === item.id} onCreate={(candidate) => void create(candidate)} titleId={`opportunity-mobile-detail-title-${item.id}`} className="lg:hidden" />}</li>; })}</ul></section>{selected && <aside aria-labelledby="opportunity-detail-title" className="hidden self-start lg:sticky lg:top-6 lg:block"><OpportunityDetails item={selected} creating={creatingId === selected.id} onCreate={(item) => void create(item)} titleId="opportunity-detail-title" /></aside>}</div>}
    </div>
  </AppShell>;
}
