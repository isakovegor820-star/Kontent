"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Grid2X2, List, RefreshCw, Sparkles } from "lucide-react";

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
import { cn } from "@/lib/utils";

const confidenceLabel = { low: "Низкая уверенность", medium: "Средняя уверенность", high: "Высокая уверенность" } as const;

export default function OpportunitiesPage() {
  const router = useRouter(); const searchParams = useSearchParams();
  const channel = searchParams.get("channel");
  const [items, setItems] = useState<OpportunitySnapshot[]>([]);
  const [status, setStatus] = useState<OpportunityPageStatus>("loading");
  const [operationError, setOperationError] = useState<string>();
  const [refreshing, setRefreshing] = useState(false); const [creatingId, setCreatingId] = useState<number | null>(null);
  const [view, setView] = useState<"list" | "map">("list");
  const requested = Number(searchParams.get("opportunity"));
  const [selectedId, setSelectedId] = useState<number | null>(Number.isSafeInteger(requested) && requested > 0 ? requested : null);
  const endpoint = `/api/opportunities${channel ? `?channel=${encodeURIComponent(channel)}` : ""}`;

  const load = useCallback(async () => {
    setOperationError(undefined);
    try {
      const response = await fetch(endpoint, { cache: "no-store" });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities)) {
        setItems([]);
        setSelectedId(null);
        setStatus(classifyOpportunityFailure(response.status, body?.error));
        return;
      }
      setItems(body.opportunities);
      setSelectedId((current) => current && body.opportunities!.some((item) => item.id === current) ? current : body.opportunities![0]?.id ?? null);
      setStatus("ready");
    } catch {
      setItems([]);
      setSelectedId(null);
      setStatus("initial_error");
    }
  }, [endpoint]);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const selected = useMemo(() => items.find((item) => item.id === selectedId) ?? null, [items, selectedId]);

  const refresh = async () => {
    setRefreshing(true);
    setOperationError(undefined);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const body = await response.json().catch(() => null) as { opportunities?: OpportunitySnapshot[]; error?: string } | null;
      if (!response.ok || !Array.isArray(body?.opportunities)) {
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

  return <AppShell title="Карта возможностей" subtitle="Свежие темы, где у канала есть место для собственного голоса." action={status === "ready" ? <Button onClick={() => void refresh()} loading={refreshing}><RefreshCw className="h-4 w-4" aria-hidden />Обновить карту</Button> : undefined}>
    <div className="mx-auto w-full max-w-[76rem] space-y-6">
      {status === "loading" && <Card className="min-h-64 p-6" role="status"><div className="skeleton h-7 w-56 rounded-xs" /><div className="mt-5 space-y-3"><div className="skeleton h-20 rounded-sm" /><div className="skeleton h-20 rounded-sm" /></div><span className="sr-only">Загружаем возможности</span></Card>}
      {status === "no_channel" && <Card className="p-6"><h2>Подключите канал</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Аврора построит карту возможностей после подключения активного канала.</p><Link className={buttonClassName({ variant: "primary", className: "mt-5" })} href="/app/settings?section=channels">Подключить канал</Link></Card>}
      {status === "feature_disabled" && <Card className="p-6"><h2>Карта пока не включена для этого канала</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Сохранённые данные не изменены. Выберите другой канал или вернитесь позже.</p></Card>}
      {status === "access_denied" && <Card className="border-danger/30 p-6" role="alert"><h2>Нет доступа к карте</h2><p className="mt-2 max-w-[65ch] text-[15px] leading-relaxed text-text-2">Попросите владельца проекта проверить вашу роль.</p><Link className={buttonClassName({ className: "mt-4" })} href="/app/calendar">Вернуться в календарь</Link></Card>}
      {status === "session_expired" && <Card className="border-danger/30 p-6" role="alert"><h2>Сессия завершилась</h2><p className="mt-2 text-[15px] text-text-2">Войдите снова, чтобы открыть карту возможностей.</p><Link className={buttonClassName({ variant: "primary", className: "mt-4" })} href="/login">Войти снова</Link></Card>}
      {status === "initial_error" && <Card className="border-danger/30 p-6" role="alert"><h2>Не удалось загрузить карту</h2><p className="mt-2 text-[15px] text-text-2">Сервис временно недоступен. Повторите загрузку.</p><Button className="mt-4" onClick={() => { setStatus("loading"); void load(); }}>Повторить загрузку</Button></Card>}
      {status === "ready" && operationError && <Card className="border-danger/30 p-4" role="alert"><p className="text-[14px] leading-relaxed text-text-2">{operationError}</p><Button variant="ghost" size="sm" className="mt-2" onClick={() => setOperationError(undefined)}>Закрыть сообщение</Button></Card>}
      {status === "ready" && items.length === 0 && <Card className="p-6"><h2>Возможностей пока нет</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Добавьте минимум двух конкурентов и обновите карту. Аврора не показывает точный приоритет при недостаточной выборке.</p><Link className="mt-5 inline-flex min-h-11 items-center font-semibold text-brand underline underline-offset-4" href="/app/competitors">Добавить конкурентов</Link></Card>}
      {status === "ready" && items.length > 0 && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><p className="text-[14px] text-text-2">{items.length} {items.length === 1 ? "актуальная возможность" : "актуальные возможности"}</p><div className="hidden rounded-sm bg-surface-inset p-1 md:inline-flex" aria-label="Представление карты"><Button variant={view === "list" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "list"} onClick={() => setView("list")}><List className="h-4 w-4" aria-hidden />Список</Button><Button variant={view === "map" ? "secondary" : "ghost"} size="sm" aria-pressed={view === "map"} onClick={() => setView("map")}><Grid2X2 className="h-4 w-4" aria-hidden />Матрица</Button></div></div>
        {view === "map" && <section aria-labelledby="opportunity-map-title" className="hidden md:block"><Card className="p-6"><h2 id="opportunity-map-title">Спрос и покрытие канала</h2><p className="mt-2 text-[14px] text-text-2">Выше — спрос сильнее. Правее — тема уже чаще встречалась в канале.</p><div className="relative mt-6 h-80 rounded-sm bg-surface-inset p-6" role="group" aria-label="Матрица возможностей"><span className="absolute bottom-2 left-1/2 -translate-x-1/2 type-caption text-text-3">Покрытие канала →</span><span className="absolute left-2 top-1/2 -rotate-90 type-caption text-text-3">Спрос →</span>{items.map((item) => <button key={item.id} type="button" aria-label={`${item.title}. Спрос ${item.demand} из 4, покрытие ${item.coverage} из 4, ${confidenceLabel[item.confidence]}`} aria-pressed={selectedId === item.id} onClick={() => setSelectedId(item.id)} style={{ insetInlineStart: `${12 + item.coverage * 18}%`, bottom: `${12 + item.demand * 17}%`, width: `${Math.min(56, 34 + (item.sampleSize ?? 1) * 3)}px`, height: `${Math.min(56, 34 + (item.sampleSize ?? 1) * 3)}px` }} className={cn("absolute grid min-h-11 min-w-11 place-items-center rounded-full border-2 font-semibold tabular-nums transition-[transform,background-color,border-color] motion-reduce:transition-none", selectedId === item.id ? "scale-110 border-brand bg-brand text-white" : "border-line-strong bg-surface text-text hover:border-brand")}>{item.id}</button>)}</div></Card></section>}
        <div className="grid gap-6 lg:grid-cols-[minmax(0,0.9fr)_minmax(22rem,1.1fr)]"><section aria-labelledby="opportunity-list-title"><h2 id="opportunity-list-title" className="sr-only">Приоритетный список</h2><ul className="space-y-3">{items.map((item, index) => <li key={item.id}><button type="button" onClick={() => setSelectedId(item.id)} aria-pressed={selectedId === item.id} className={cn("w-full rounded-md p-5 text-start shadow-soft transition-[background-color,box-shadow,transform] motion-reduce:transition-none active:scale-[0.96]", selectedId === item.id ? "bg-surface ring-2 ring-brand" : "bg-surface/75 hover:bg-surface")}><div className="flex flex-wrap items-center gap-2"><Badge tone={index === 0 ? "brand" : "neutral"}>{index === 0 ? "Приоритет" : `№ ${index + 1}`}</Badge><Badge tone={item.confidence === "high" ? "success" : item.confidence === "medium" ? "fire" : "neutral"}>{confidenceLabel[item.confidence]}</Badge></div><h3 className="mt-3 text-balance">{item.title}</h3><p className="mt-2 text-[14px] leading-relaxed text-text-2">{item.freshnessLabel} · {item.channelLabel}</p></button></li>)}</ul></section>
          {selected && <aside aria-labelledby="opportunity-detail-title"><Card strong className="p-5 sm:p-6"><div className="flex flex-wrap items-center gap-2"><Badge tone={selected.epistemicState === "stale" ? "fire" : "brand"}>{selected.epistemicState === "inferred" ? "Объяснимый вывод" : selected.epistemicState === "stale" ? "Устарело" : "Данных мало"}</Badge><span className="type-caption tabular-nums text-text-3">Формула {selected.formulaVersion}</span></div><h2 id="opportunity-detail-title" className="mt-4 text-balance">{selected.title}</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{selected.angle}</p><dl className="mt-5 grid gap-3 sm:grid-cols-3"><div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Спрос</dt><dd className="mt-1 font-semibold tabular-nums">{selected.demand} из 4</dd></div><div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Покрытие</dt><dd className="mt-1 font-semibold tabular-nums">{selected.coverage} из 4</dd></div><div className="rounded-sm bg-surface-inset p-3"><dt className="type-caption text-text-3">Выборка</dt><dd className="mt-1 font-semibold tabular-nums">{selected.sampleSize ?? "Недостаточно"}</dd></div></dl><p className="mt-5 text-[14px] leading-relaxed text-text-2"><span className="font-semibold text-text">Методика:</span> {selected.methodology}</p><div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap"><Button disabled={!selected.actionable} loading={creatingId === selected.id} onClick={() => void create(selected)}><Sparkles className="h-4 w-4" aria-hidden />Создать черновик</Button><EvidenceCard kind="opportunity" id={selected.id} /></div>{!selected.actionable && <p className="mt-3 text-[13px] text-fire-text">Сначала обновите устаревший или неполный источник.</p>}</Card></aside>}
        </div>
      </>}
    </div>
  </AppShell>;
}
