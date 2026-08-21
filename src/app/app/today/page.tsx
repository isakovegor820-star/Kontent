"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock3, Compass, FileCheck2, Lightbulb } from "lucide-react";

import { AppShell } from "@/components/app/shell";
import { EvidenceCard } from "@/components/app/evidence-card";
import { Button, buttonClassName } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/primitives";
import type { TodayBoard, TodayItem } from "@/lib/today";
import { plural } from "@/lib/utils";

const icon = { opportunity: Lightbulb, review: FileCheck2, result: CheckCircle2, risk: AlertTriangle, onboarding: Compass } as const;
const label = { opportunity: "Возможность", review: "Нужно решение", result: "Результат", risk: "Риск", onboarding: "Начало" } as const;
const confidenceLabel = { low: "Низкая уверенность", medium: "Средняя уверенность", high: "Высокая уверенность" } as const;
const stateLabel = { observed: "Наблюдаемые данные", inferred: "Объяснимый вывод", insufficient_data: "Данных мало", stale: "Устарело", blocked: "Действие заблокировано" } as const;

export default function TodayPage() {
  const [board, setBoard] = useState<TodayBoard | null>(null); const [status, setStatus] = useState<"loading" | "ready" | "error">("loading"); const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => { try { const response = await fetch("/api/today", { cache: "no-store" }); const body = await response.json().catch(() => null) as TodayBoard | null; if (!response.ok || !body?.items) throw new Error("today"); setBoard(body); setStatus("ready"); } catch { setStatus("error"); } }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);
  const state = async (item: TodayItem, next: "dismissed" | "snoozed") => { if (!board?.channelId) return; setBusy(item.fingerprint); try { const response = await fetch("/api/today/state", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ channelId: board.channelId, fingerprint: item.fingerprint, state: next }) }); if (!response.ok) throw new Error("state"); await load(); } catch { setStatus("error"); } finally { setBusy(null); } };
  return <AppShell title="Сегодня" subtitle="Небольшой список решений для выбранного канала — с доказательствами и без обещаний роста.">
    <div className="mx-auto w-full max-w-[68rem] space-y-6">
      {status === "loading" && <Card className="min-h-64 p-6" role="status"><div className="skeleton h-7 w-44 rounded-xs" /><div className="mt-5 space-y-3"><div className="skeleton h-24 rounded-sm" /><div className="skeleton h-24 rounded-sm" /></div><span className="sr-only">Собираем решения на сегодня</span></Card>}
      {status === "error" && <Card className="border-danger/30 p-6" role="alert"><h2>Не удалось собрать решения</h2><p className="mt-2 text-[15px] text-text-2">Действия и черновики сохранены. Проверьте соединение и повторите.</p><Button className="mt-4" onClick={() => { setStatus("loading"); void load(); }}>Повторить загрузку</Button></Card>}
      {status === "ready" && board && !board.enabled && <Card className="p-6"><h2>«Сегодня» пока не включено для этого канала</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">Release 1 включается по ограниченным группам. До активации календарь остаётся главной точкой входа.</p><Link className={buttonClassName({ className: "mt-5" })} href="/app/calendar">Открыть календарь</Link></Card>}
      {status === "ready" && board?.enabled && <>
        <div className="flex flex-wrap items-center justify-between gap-3"><div><p className="type-caption font-semibold text-brand">{board.channelLabel}</p><p className="mt-1 text-[14px] text-text-2">{board.items.length} {plural(board.items.length, "решение", "решения", "решений")} в фокусе</p></div><Badge tone="neutral"><Clock3 className="h-3.5 w-3.5" aria-hidden />{board.rankingVersion}</Badge></div>
        {board.partialErrors.map((error) => <div key={error.source} role="status" className="rounded-sm border border-fire/25 bg-fire-soft px-4 py-3 text-[14px] text-fire-text">{error.message} Остальные карточки доступны.</div>)}
        <ol className="space-y-4">{board.items.map((item, index) => { const Icon = icon[item.type]; return <li key={item.fingerprint}><Card strong={index === 0} className="overflow-hidden"><div className="grid gap-5 p-5 sm:p-6 lg:grid-cols-[minmax(0,1fr)_auto]"><div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><Badge tone={item.type === "risk" ? "danger" : index === 0 ? "brand" : "neutral"}><Icon className="h-3.5 w-3.5" aria-hidden />{label[item.type]}</Badge><span className="type-caption text-text-3">{item.channelLabel} · {item.freshness}</span></div><p className="mt-2 type-caption text-text-3">{confidenceLabel[item.confidence]} · {stateLabel[item.epistemicState]}</p><h2 className="mt-4 text-balance">{item.title}</h2><p className="mt-3 max-w-[65ch] text-pretty text-[15px] leading-relaxed text-text-2">{item.whyNow}</p><div className="mt-5 flex flex-col gap-3 sm:flex-row sm:flex-wrap"><Link className={buttonClassName({ variant: "primary", className: "whitespace-normal text-center" })} href={item.primaryAction.href}>{item.primaryAction.label}</Link>{item.evidence && <EvidenceCard kind={item.evidence.kind} id={item.evidence.id} compact />}</div></div>{item.secondaryAction && <div className="flex items-start"><Button variant="ghost" size="sm" loading={busy === item.fingerprint} onClick={() => void state(item, item.secondaryAction!.state)}>{item.secondaryAction.label}</Button></div>}</div></Card></li>; })}</ol>
      </>}
    </div>
  </AppShell>;
}
